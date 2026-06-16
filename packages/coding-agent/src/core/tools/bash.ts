import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "@valkyriweb/pi-agent-core";
import { Container, Text, truncateToWidth } from "@valkyriweb/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { highlightCode, theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead, truncateTail } from "./truncate.ts";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	workdir: Type.Optional(
		Type.String({
			description:
				'Absolute path (or a path relative to the session working directory) to run the command in. Use this INSTEAD of `cd <dir> && …` whenever the command needs to run in a different directory — e.g. workdir: "/abs/path/to/project". Defaults to the session working directory.',
		}),
	),
	timeout: Type.Optional(
		Type.Union([
			Type.Number({
				description:
					"Timeout in seconds. Defaults to 300 seconds. On timeout the still-running command is automatically detached into a background job (returns a bgId) rather than being killed, so long work keeps running. Read it with bash_output(bgId), stop it with bash_kill(bgId).",
			}),
			Type.Literal(false, { description: "Disable timeout for this command." }),
		]),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to spawn the command in the background. Returns immediately with a bgId. Read accumulated output with bash_output(bgId) and stop it with bash_kill(bgId). Use this for any command likely to exceed ~30s when you do not need its stdout immediately. For continuous log streams that should wake the agent on each batch, prefer the Monitor tool (monitor_start) instead.",
		}),
	),
	tui_only: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to stream output live to the TUI but return only an exit/size summary to the model context. Use for long monitoring loops (reboot waits, log tails, progress meters) where the streaming output is for human eyes and would be wasted tokens in context. Incompatible with run_in_background.",
		}),
	),
});

// ---------- Background bash registry ----------
//
// Background bash jobs are tracked in-process so siblings bash_output / bash_kill
// can read or stop them by id. Output is appended to a log file under
// ~/.pi/agent/bash-bg/<bgId>.log so it survives process exit and can be tailed.

export interface BashBgJob {
	id: string;
	command: string;
	cwd: string;
	pid: number | undefined;
	startedAt: number;
	status: "running" | "exited" | "killed" | "failed";
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	logPath: string;
	endedAt: number | undefined;
	error: string | undefined;
}

export interface BashBgJobStore {
	get(id: string): BashBgJob | undefined;
	list(): BashBgJob[];
	running(): BashBgJob[];
	subscribe(callback: () => void): () => void;
	kill(id: string): { job: BashBgJob | undefined; error?: string };
	killAll(): void;
}

const bashBgJobs = new Map<string, BashBgJob>();
const bashBgSubscribers = new Set<() => void>();

function notifyBashBgJobsChanged(): void {
	for (const subscriber of bashBgSubscribers) subscriber();
}

export function subscribeBashBgJobs(callback: () => void): () => void {
	bashBgSubscribers.add(callback);
	return () => bashBgSubscribers.delete(callback);
}

// Terminal listeners fire once when a background bash job reaches a *natural*
// terminal status (process exit or spawn error). Explicit stops (bash_kill /
// session dispose / killAll) do NOT fire — the agent already knows it stopped
// them. This mirrors the agent background-run terminal listener so the owning
// session can inject a completion notification, matching Claude Code's
// task-notification wake ("you'll be notified when it finishes"). Without this,
// a backgrounded command completes silently and a CC-trained model parks
// forever waiting for a wake that never arrives.
const bashBgTerminalListeners = new Set<(job: BashBgJob) => void>();

export function subscribeBashBgTerminal(callback: (job: BashBgJob) => void): () => void {
	bashBgTerminalListeners.add(callback);
	return () => bashBgTerminalListeners.delete(callback);
}

function notifyBashBgTerminal(job: BashBgJob): void {
	for (const listener of bashBgTerminalListeners) {
		try {
			listener(job);
		} catch {
			// A listener must never break the process exit/error handler.
		}
	}
}

function bashBgLogDir(): string {
	const dir = join(homedir(), ".pi", "agent", "bash-bg");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function nextBashBgId(): string {
	return `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getBashBgJob(id: string): BashBgJob | undefined {
	return bashBgJobs.get(id);
}

export function listBashBgJobs(): BashBgJob[] {
	return [...bashBgJobs.values()];
}

export function getRunningBashBgJobsSorted(): BashBgJob[] {
	return listBashBgJobs()
		.filter((job) => job.status === "running")
		.sort((a, b) => a.startedAt - b.startedAt);
}

export function killBashBgJob(id: string): { job: BashBgJob | undefined; error?: string } {
	const job = getBashBgJob(id);
	if (!job || job.status !== "running") return { job };
	if (job.pid) {
		try {
			killProcessTree(job.pid);
		} catch (err) {
			// The kill was deliberate but signalling failed. Mark the job killed so the
			// exit handler's wasRunning check stays silent instead of firing a spurious
			// crash wake. ESRCH means the process already exited — the kill effectively
			// succeeded, so report success; any other error is surfaced.
			job.status = "killed";
			job.endedAt = Date.now();
			notifyBashBgJobsChanged();
			if ((err as { code?: string })?.code === "ESRCH") return { job };
			return { job, error: err instanceof Error ? err.message : String(err) };
		}
	}
	job.status = "killed";
	job.endedAt = Date.now();
	notifyBashBgJobsChanged();
	return { job };
}

export function createBashBgJobStore(): BashBgJobStore {
	return {
		get: getBashBgJob,
		list: listBashBgJobs,
		running: getRunningBashBgJobsSorted,
		subscribe: subscribeBashBgJobs,
		kill: killBashBgJob,
		killAll: killAllBashBgJobs,
	};
}

/**
 * Terminate every running background bash job and clear the registry.
 * The built-in bash-bg-jobs extension calls this on session dispose; jobs
 * intentionally survive extension reload because the store is process-scoped.
 */
export function killAllBashBgJobs(): void {
	for (const job of bashBgJobs.values()) {
		if (job.status === "running" && job.pid) {
			try {
				killProcessTree(job.pid);
			} catch {
				// best-effort; process may already be gone
			}
			job.status = "killed";
			job.endedAt = Date.now();
		}
	}
	bashBgJobs.clear();
	notifyBashBgJobsChanged();
}

export function spawnBashBackground(
	command: string,
	cwd: string,
	shellPath?: string,
	commandPrefix?: string,
): BashBgJob {
	const id = nextBashBgId();
	const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
	const logPath = join(bashBgLogDir(), `${id}.log`);
	const fd = openSync(logPath, "a");
	const { shell, args } = getShellConfig(shellPath);
	if (!existsSync(cwd)) {
		closeSync(fd);
		throw new Error(`Working directory does not exist: ${cwd}`);
	}
	const child = spawn(shell, [...args, resolvedCommand], {
		cwd,
		detached: process.platform !== "win32",
		env: getShellEnv(),
		stdio: ["ignore", fd, fd],
	});
	closeSync(fd);
	if (child.pid) trackDetachedChildPid(child.pid);
	const job: BashBgJob = {
		id,
		command: resolvedCommand,
		cwd,
		pid: child.pid,
		startedAt: Date.now(),
		status: "running",
		exitCode: null,
		signal: null,
		logPath,
		endedAt: undefined,
		error: undefined,
	};
	bashBgJobs.set(id, job);
	notifyBashBgJobsChanged();
	child.on("error", (err) => {
		const wasRunning = job.status === "running";
		job.error = err.message;
		job.endedAt = Date.now();
		if (wasRunning) job.status = "failed";
		if (child.pid) untrackDetachedChildPid(child.pid);
		notifyBashBgJobsChanged();
		// Stay silent if the job was already stopped deliberately (bash_kill/dispose).
		if (wasRunning) notifyBashBgTerminal(job);
	});
	child.on("exit", (code, signal) => {
		job.exitCode = code;
		job.signal = signal;
		job.endedAt = Date.now();
		const wasRunning = job.status === "running";
		if (wasRunning) {
			job.status = signal ? "killed" : "exited";
		}
		if (child.pid) untrackDetachedChildPid(child.pid);
		notifyBashBgJobsChanged();
		// Wake on any terminal transition the agent did NOT initiate: a clean exit
		// OR an external crash (signal death while still "running" — SIGSEGV, OOM
		// SIGKILL, an external SIGTERM). Deliberate stops (bash_kill / dispose /
		// killAll) flip status off "running" *before* this fires, so they stay
		// silent — the agent already knows it stopped them. Without waking on the
		// crash case, a CC-trained model parks forever waiting on a dead job.
		if (wasRunning) notifyBashBgTerminal(job);
	});
	// Don't keep the event loop alive on our behalf — caller decides.
	child.unref();
	return job;
}

/**
 * Adopt an already-running foreground child into the background registry instead
 * of killing it. Used by auto-background-on-timeout (mirrors Claude Code): the
 * live process keeps running, its stdout/stderr are redirected to the bg log, and
 * it becomes readable/killable by bgId. Callers must detach their own `onData`
 * listeners before calling so output isn't double-counted.
 */
function adoptBashBackground(child: ReturnType<typeof spawn>, command: string, cwd: string): BashBgJob {
	const id = nextBashBgId();
	const logPath = join(bashBgLogDir(), `${id}.log`);
	const fd = openSync(logPath, "a");
	try {
		writeSync(fd, "[detached into background after foreground timeout \u2014 process still running]\n");
	} catch {}
	const append = (data: Buffer) => {
		try {
			writeSync(fd, data);
		} catch {}
	};
	child.stdout?.on("data", append);
	child.stderr?.on("data", append);
	const job: BashBgJob = {
		id,
		command,
		cwd,
		pid: child.pid,
		startedAt: Date.now(),
		status: "running",
		exitCode: null,
		signal: null,
		logPath,
		endedAt: undefined,
		error: undefined,
	};
	bashBgJobs.set(id, job);
	notifyBashBgJobsChanged();
	child.on("error", (err) => {
		const wasRunning = job.status === "running";
		job.error = err.message;
		job.endedAt = Date.now();
		if (wasRunning) job.status = "failed";
		try {
			closeSync(fd);
		} catch {}
		if (child.pid) untrackDetachedChildPid(child.pid);
		notifyBashBgJobsChanged();
		// Stay silent if the job was already stopped deliberately (bash_kill/dispose).
		if (wasRunning) notifyBashBgTerminal(job);
	});
	child.on("exit", (code, signal) => {
		job.exitCode = code;
		job.signal = signal;
		job.endedAt = Date.now();
		const wasRunning = job.status === "running";
		if (wasRunning) {
			job.status = signal ? "killed" : "exited";
		}
		try {
			closeSync(fd);
		} catch {}
		if (child.pid) untrackDetachedChildPid(child.pid);
		notifyBashBgJobsChanged();
		// Wake on crash too (signal death while "running"), not just clean exit;
		// deliberate stops already moved status off "running". See the primary
		// spawn handler above for the full rationale.
		if (wasRunning) notifyBashBgTerminal(job);
	});
	child.unref();
	return job;
}

/**
 * Disposition of a foreground bash command that exceeds its timeout.
 *
 * Additive seam: the exec path stays one call deep and the policy lives in the
 * resolver, so the fork (or a my-pi extension) can change timeout behaviour
 * without reshaping the upstream exec loop. `background()` adopts the live
 * process into the bg registry (it keeps running); `kill()` terminates it.
 */
export interface BashTimeout {
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs: number;
	background(): BashBgJob;
	kill(): void;
}

export type BashTimeoutOutcome = { backgroundedJobId: string } | { failed: true };

/** Upstream-faithful default: kill the timed-out process and report failure.
 *  Detach-on-timeout is opt-in via `onBashTimeout()` — the my-pi
 *  `native-tool-aliases` extension installs the detach resolver for Luke's
 *  `Bash` tool, so the opinionated policy lives there, not in core. */
function killOnBashTimeout(t: BashTimeout): BashTimeoutOutcome {
	t.kill();
	return { failed: true };
}

let bashTimeoutResolver: (t: BashTimeout) => BashTimeoutOutcome = killOnBashTimeout;

/**
 * Override what happens when a foreground bash command times out. Returns a
 * restore function. Consumers that choose `{ failed: true }` are responsible for
 * killing the process (e.g. via `t.kill()`); the default already kills.
 * Choose `{ backgroundedJobId }` (via `t.background()`) to detach instead.
 */
export function onBashTimeout(resolve: (t: BashTimeout) => BashTimeoutOutcome): () => void {
	const previous = bashTimeoutResolver;
	bashTimeoutResolver = resolve;
	return () => {
		bashTimeoutResolver = previous;
	};
}

/** Apply the configured timeout disposition to a still-running foreground child. */
function disposeBashTimeout(
	child: ReturnType<typeof spawn>,
	command: string,
	cwd: string,
	timeoutMs: number,
): BashTimeoutOutcome {
	return bashTimeoutResolver({
		command,
		cwd,
		timeoutMs,
		background: () => adoptBashBackground(child, command, cwd),
		kill: () => {
			try {
				child.kill("SIGKILL");
			} catch {}
		},
	});
}

const VERTICAL_TUI_RUN_MIN_LINES = 12;
// Shared byte cap for every bash-tool surface (foreground bash, background bash_output).
// Smaller than DEFAULT_MAX_BYTES (50KB) because shell output is the loudest single
// source of context bloat — and tokenjuice can rescue the full log on demand.
const BASH_MAX_OUTPUT_BYTES = 20 * 1024;

function stripTrailingCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function stripTerminalControls(text: string): string {
	return stripAnsi(text)
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
		.trimEnd();
}

function isShortTerminalFragment(line: string): boolean {
	const text = stripTrailingCarriageReturn(line);
	return text === "" || [...text].length <= 3;
}

function isLikelyWrappedTuiRun(lines: string[]): boolean {
	if (lines.length < VERTICAL_TUI_RUN_MIN_LINES) return false;
	const joined = lines.map(stripTrailingCarriageReturn).join("");
	return joined.includes("\u001B") && /\[[0-9;?]*[A-Za-z]/u.test(joined);
}

function sanitizeBashBgDisplayLines(lines: string[]): string[] {
	const sanitized: string[] = [];
	for (let index = 0; index < lines.length; ) {
		if (!isShortTerminalFragment(lines[index])) {
			sanitized.push(stripTerminalControls(stripTrailingCarriageReturn(lines[index])));
			index++;
			continue;
		}

		let end = index + 1;
		while (end < lines.length && isShortTerminalFragment(lines[end])) end++;
		const run = lines.slice(index, end);
		if (isLikelyWrappedTuiRun(run)) {
			const collapsed = stripTerminalControls(run.map(stripTrailingCarriageReturn).join(""));
			if (collapsed) sanitized.push(collapsed);
		} else {
			for (const line of run) sanitized.push(stripTerminalControls(stripTrailingCarriageReturn(line)));
		}
		index = end;
	}
	return sanitized;
}

function readBashBgLog(
	job: BashBgJob,
	opts: { mode: "tail" | "head" | "all"; maxLines: number },
): { text: string; shownLines: number; totalLines: number; truncated: boolean } {
	let content = "";
	try {
		content = readFileSync(job.logPath, "utf8");
	} catch {
		return { text: "", shownLines: 0, totalLines: 0, truncated: false };
	}
	const all = content.split("\n");
	// Trailing newline produces an empty last element; drop it.
	if (all.length > 0 && all[all.length - 1] === "") all.pop();
	const total = all.length;
	const max = Math.max(1, Math.min(opts.maxLines, 1000));
	const slice = opts.mode === "tail" ? all.slice(Math.max(0, total - max)) : all.slice(0, max);
	const sanitized = sanitizeBashBgDisplayLines(slice).join("\n");
	const truncation =
		opts.mode === "tail"
			? truncateTail(sanitized, { maxLines: max, maxBytes: BASH_MAX_OUTPUT_BYTES })
			: truncateHead(sanitized, { maxLines: max, maxBytes: BASH_MAX_OUTPUT_BYTES });
	const text =
		truncation.content ||
		(total > 0 ? `[output omitted: first line exceeds ${formatSize(BASH_MAX_OUTPUT_BYTES)}]` : "");
	const shownLines = text ? text.split("\n").length : 0;
	return {
		text,
		shownLines,
		totalLines: total,
		truncated: total > slice.length || truncation.truncated,
	};
}

export type BashToolInput = Static<typeof bashSchema>;

export interface BashBgDetails {
	bgId: string;
	taskId: string;
	pid: number | undefined;
	logPath: string;
	outputPath: string;
	command: string;
	startedAt: number;
}

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface BashOutputToolDetails extends BashBgJob {
	fullOutputPath: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null; backgroundedJobId?: string }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const { shell, args } = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}
			if (signal?.aborted) {
				throw new Error("aborted");
			}

			const child = spawn(shell, [...args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (child.pid) trackDetachedChildPid(child.pid);
			let backgroundedJobId: string | undefined;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Race real exit against the timeout. On timeout the disposition seam
				// decides what happens (core default: kill and fail). Consumers opt into
				// detach-on-timeout via onBashTimeout() — e.g. Luke's native-tool-aliases
				// extension adopts the live process into a background job (Claude Code
				// parity) so long work keeps running and stays readable/killable by bgId.
				const exitPromise = waitForChildProcess(child).then((code) => ({ kind: "exit" as const, code }));
				const timeoutPromise =
					timeout !== undefined && timeout > 0
						? new Promise<{ kind: "timeout" }>((resolveTimeout) => {
								timeoutHandle = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeout * 1000);
							})
						: undefined;
				const outcome = timeoutPromise ? await Promise.race([exitPromise, timeoutPromise]) : await exitPromise;
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (outcome.kind === "timeout") {
					// Detach the foreground listeners first so the bg log is the single sink,
					// then hand off to the configured disposition.
					child.stdout?.off("data", onData);
					child.stderr?.off("data", onData);
					const disposition = disposeBashTimeout(child, command, cwd, (timeout ?? 0) * 1000);
					if ("backgroundedJobId" in disposition) {
						backgroundedJobId = disposition.backgroundedJobId;
						return { exitCode: null, backgroundedJobId };
					}
					// Failed disposition (the default kills): surface the timeout sentinel so
					// the tool layer reports "Command timed out after Ns" instead of a bare exit code.
					throw new Error(`timeout:${timeout ?? 0}`);
				}
				return { exitCode: outcome.code };
			} finally {
				// Adopted children stay tracked — the background job owns the pid now.
				if (!backgroundedJobId && child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	toolName?: "bash" | "Bash";
	label?: string;
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

// ---------- Bash policy (read-only child agents) ----------
//
// Per-invocation policy enforcing a deny-list against bash commands executed
// inside a specific child agent (currently: `explore`). Set via
// `runWithBashPolicy()` around `session.prompt(...)` in the agents executor;
// read at the top of bash `execute`. AsyncLocalStorage keeps the policy bound
// to the child's async context without plumbing options through session
// factories.
//
// Soft guard, not a sandbox: rejects commands whose first 1-3 tokens of any
// pipeline/sequence segment match a deny pattern, and rejects unquoted
// `>` / `>>` / `tee` / `sponge` when `denyWrites` is set. Will not catch every
// adversarial construction (eval, $(), backticks, here-docs).
export interface BashPolicy {
	/** Human-readable label used in error messages. */
	label: string;
	/** Command-name patterns to reject (case-sensitive, word-boundary match). Multi-word entries (e.g. "git push") match consecutive tokens. */
	denyCommands: string[];
	/** When true, reject unquoted output redirection (`>`, `>>`, `tee`, `| sponge`). */
	denyWrites?: boolean;
}

const bashPolicyStore = new AsyncLocalStorage<BashPolicy>();

/** Run `fn` with `policy` bound to the current async context. */
export function runWithBashPolicy<T>(policy: BashPolicy, fn: () => Promise<T>): Promise<T> {
	return bashPolicyStore.run(policy, fn);
}

/** Deny list applied to the `explore` agent: no mutations, no writes, no network sends. */
export const EXPLORE_BASH_POLICY: BashPolicy = {
	label: "explore (read-only)",
	denyWrites: true,
	denyCommands: [
		"rm",
		"mv",
		"cp",
		"mkdir",
		"rmdir",
		"touch",
		"chmod",
		"chown",
		"ln",
		"sed -i",
		"perl -i",
		"awk -i",
		"git add",
		"git commit",
		"git push",
		"git pull",
		"git fetch",
		"git checkout",
		"git switch",
		"git reset",
		"git restore",
		"git stash",
		"git merge",
		"git rebase",
		"git cherry-pick",
		"git tag",
		"git branch",
		"git worktree",
		"gh pr create",
		"gh pr edit",
		"gh pr close",
		"gh pr merge",
		"gh issue create",
		"gh issue edit",
		"gh issue close",
		"gh issue comment",
		"gh release",
		"gh repo create",
		"gh repo delete",
		"npm install",
		"npm i",
		"npm run",
		"npm publish",
		"pnpm install",
		"pnpm add",
		"yarn install",
		"yarn add",
		"pip install",
		"pipx install",
		"brew install",
		"cargo install",
		"go install",
		"kill",
		"pkill",
		"killall",
		"systemctl",
		"launchctl",
		"docker run",
		"docker exec",
		"kubectl apply",
		"kubectl delete",
		"kubectl create",
		"kubectl edit",
		"kubectl patch",
		"scp",
		"rsync",
		"eval",
		"exec",
		"source",
	],
};

/** Tokenize the command into pipeline/sequence segments. */
function splitBashSegments(command: string): string[] {
	return command
		.split(/(?:;|&&|\|\|?|\n)/g)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** First three whitespace-separated tokens of a segment (covers "git push" style). */
function firstTokens(segment: string): string {
	const trimmed = segment.replace(/^[!\s]+/, "").trim();
	return trimmed.split(/\s+/).slice(0, 3).join(" ");
}

/**
 * Strip single-quoted spans from a string. Single quotes in POSIX shell are
 * literal (no escapes, no interpolation), so anything inside `'...'` cannot
 * be a backtick / `$()` / here-doc operator we care about. Removing them
 * eliminates false positives like `grep '\$(' file`.
 */
function stripSingleQuoted(s: string): string {
	return s.replace(/'[^']*'/g, "''");
}

/**
 * Detect unsafe shell constructs that the simple token scanner can't reason
 * about: command substitution (`$(...)`, backticks), here-docs (`<<WORD`,
 * `<<-WORD`, `<<<` is fine — it's a here-string of literal data), and `eval`/
 * arithmetic substitution `$((...))` which can shell out via nested `$()`.
 * Returns a reason string when found, else undefined.
 */
function detectUnsafeConstructs(command: string): string | undefined {
	const stripped = stripSingleQuoted(command);
	if (/\$\(/.test(stripped))
		return "command substitution `$(...)` is not permitted — inline the inner command directly";
	if (/(^|[^\\])`/.test(stripped))
		return "backtick command substitution is not permitted — inline the inner command directly";
	if (/<<-?\s*['"]?\w+/.test(stripped)) return "here-doc (`<<WORD`) is not permitted — pass arguments inline instead";
	return undefined;
}

/**
 * Check `command` against `policy`. Returns a human-readable reason if denied,
 * else undefined.
 *
 * Pipeline:
 *   1. Detect command substitution, backticks, here-docs — reject outright.
 *      These constructs let the model smuggle arbitrary commands past the
 *      segment scanner. A read-only explore agent never needs them.
 *   2. Split into pipeline/sequence segments.
 *   3. Multi-word patterns (e.g. "git push") match the first 1–3 tokens of
 *      each segment.
 *   4. Single-word patterns (e.g. "rm") match ANY token in any segment —
 *      catches `find ... | xargs rm` style chained-mutation bypasses.
 *   5. When `denyWrites` is set, reject unquoted `>` / `>>` / `tee` / `sponge`.
 */
export function checkBashPolicy(command: string, policy: BashPolicy): string | undefined {
	const unsafe = detectUnsafeConstructs(command);
	if (unsafe) {
		return `bash policy [${policy.label}] denied: ${unsafe} (command: ${command.slice(0, 80)}). Report what you need in Open Questions instead.`;
	}
	const singleWordDeny = policy.denyCommands.filter((p) => !p.includes(" "));
	const multiWordDeny = policy.denyCommands.filter((p) => p.includes(" "));
	const segments = splitBashSegments(command);
	for (const segment of segments) {
		const head = firstTokens(segment);
		for (const pattern of multiWordDeny) {
			if (head === pattern || head.startsWith(`${pattern} `)) {
				return `bash policy [${policy.label}] denied: "${pattern}" is not permitted (segment: ${segment.slice(0, 80)}). Report what you need in Open Questions instead.`;
			}
		}
		const tokens = segment.split(/\s+/);
		for (const token of tokens) {
			if (singleWordDeny.includes(token)) {
				return `bash policy [${policy.label}] denied: "${token}" is not permitted (segment: ${segment.slice(0, 80)}). Report what you need in Open Questions instead.`;
			}
		}
		if (policy.denyWrites) {
			if (/(^|[^&\d])>>?(?![&])/.test(segment) || /\btee\b/.test(segment) || /\bsponge\b/.test(segment)) {
				return `bash policy [${policy.label}] denied: output redirection / tee is not permitted (segment: ${segment.slice(0, 80)}).`;
			}
		}
	}
	return undefined;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;
const DEFAULT_BASH_TIMEOUT_SECONDS = 300;
const COMMAND_SEMANTIC_EXIT_STATUS = 1;

type BashSemanticExit = {
	command: string;
	exitCode: number;
	summary: string;
};

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Embedded script detection
// ---------------------------------------------------------------------------

interface CommandSegment {
	text: string;
	lang: string;
}

/** Interpreter flag patterns that introduce an inline script argument. */
const INLINE_SCRIPT_FLAGS: Array<{ pattern: RegExp; lang: string }> = [
	{ pattern: /\b(?:python3?|pypy3?)\s+-[Bc]\s/, lang: "python" },
	{ pattern: /\b(?:node|nodejs)\s+(?:-e|-p|--eval)\s/, lang: "javascript" },
	{ pattern: /\bruby\s+-e\s/, lang: "ruby" },
	{ pattern: /\bperl\s+-[eE]\s/, lang: "perl" },
	{ pattern: /\bphp\s+(?:-r|-R)\s/, lang: "php" },
];

/**
 * Extract a quoted string starting at `startIdx` (which points at the opening quote).
 * Returns the unescaped content and the index just past the closing quote, or null if
 * the string is unterminated.
 */
function extractQuotedString(cmd: string, startIdx: number): { content: string; endIdx: number } | null {
	const quote = cmd[startIdx];
	if (quote !== '"' && quote !== "'") return null;
	let i = startIdx + 1;
	let content = "";
	while (i < cmd.length) {
		if (quote === '"' && cmd[i] === "\\" && i + 1 < cmd.length) {
			content += cmd[i + 1];
			i += 2;
		} else if (cmd[i] === quote) {
			return { content, endIdx: i + 1 };
		} else {
			content += cmd[i];
			i++;
		}
	}
	return null; // unterminated
}

/**
 * Try to detect a heredoc embedded script in `cmd`.
 * Handles both quoted (`<< 'EOF'`) and unquoted (`<< EOF`) delimiters.
 * Returns segments or null if no heredoc found.
 */
function detectHeredoc(cmd: string): CommandSegment[] | null {
	const heredocRe = /<<-?\s*['"]?([A-Z_][A-Z_0-9]*)['"]?\n/;
	const match = heredocRe.exec(cmd);
	if (!match) return null;
	const delimiter = match[1]!;
	const codeStart = match.index + match[0].length;
	const closingPattern = new RegExp(`(?:^|\n)${delimiter}s*(?:\n|$)`);
	const closeMatch = closingPattern.exec(cmd.slice(codeStart));
	if (!closeMatch) return null;

	// Determine language from the command preceding the heredoc marker
	const prefix = cmd.slice(0, match.index);
	let lang = "bash";
	for (const { pattern, lang: l } of INLINE_SCRIPT_FLAGS) {
		if (pattern.test(`${prefix} x`)) {
			lang = l;
			break;
		}
	}

	const codeEnd = codeStart + closeMatch.index + (closeMatch[0].startsWith("\n") ? 1 : 0);
	return [
		{ text: cmd.slice(0, codeStart), lang: "bash" },
		{ text: cmd.slice(codeStart, codeEnd), lang },
		{ text: cmd.slice(codeEnd), lang: "bash" },
	];
}

/**
 * Split a bash command into segments for per-language syntax highlighting.
 * Detects patterns like `python3 -c "..."` and heredocs.
 * Falls back to a single bash segment if no embedded script is found.
 */
function segmentCommand(command: string): CommandSegment[] {
	// Try heredoc first (it uses a different delimiter style)
	const heredocSegments = detectHeredoc(command);
	if (heredocSegments) return heredocSegments;

	// Try inline -c/-e flag patterns
	for (const { pattern, lang } of INLINE_SCRIPT_FLAGS) {
		const match = pattern.exec(command);
		if (!match) continue;

		const flagEnd = match.index + match[0].length;

		// Skip optional line-continuation whitespace between the flag and the quote
		let quoteStart = flagEnd;
		while (quoteStart < command.length && /[\s\\]/.test(command[quoteStart]!)) {
			quoteStart++;
		}

		const quoteChar = command[quoteStart];
		if (quoteChar !== '"' && quoteChar !== "'") continue;

		const extracted = extractQuotedString(command, quoteStart);
		if (!extracted) continue;

		// Include the opening and closing quotes in the surrounding bash segments so
		// highlight.js sees balanced (or intentionally partial) quoting.
		return [
			{ text: command.slice(0, quoteStart + 1), lang: "bash" },
			{ text: extracted.content, lang },
			{ text: command.slice(extracted.endIdx - 1), lang: "bash" },
		];
	}

	return [{ text: command, lang: "bash" }];
}

function resolveBashTimeout(timeout: number | false | undefined): number | undefined {
	if (timeout === false) return undefined;
	return timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS;
}

function shellTokensForSimpleCommand(command: string): string[] | undefined {
	const tokens: string[] = [];
	let token = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;

	for (const char of command.trim()) {
		if (escaped) {
			token += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else token += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "\n" || char === "(" || char === ")") {
			return undefined;
		}
		if (/\s/.test(char)) {
			if (token) {
				tokens.push(token);
				token = "";
			}
			continue;
		}
		token += char;
	}
	if (escaped || quote) return undefined;
	if (token) tokens.push(token);
	return tokens.length > 0 ? tokens : undefined;
}

function isShellAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function skipGitGlobalOption(tokens: string[], index: number): number {
	const token = tokens[index];
	if (!token?.startsWith("-")) return index;
	if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(token)) return index + 2;
	if (
		token.startsWith("-C") ||
		token.startsWith("-c") ||
		token.startsWith("--git-dir=") ||
		token.startsWith("--work-tree=") ||
		token.startsWith("--namespace=")
	) {
		return index + 1;
	}
	return index + 1;
}

function commandNameForExitSemantics(command: string): string | undefined {
	const tokens = shellTokensForSimpleCommand(command);
	if (!tokens) return undefined;
	let index = 0;
	while (isShellAssignment(tokens[index] ?? "")) index++;
	if (tokens[index] === "command" || tokens[index] === "builtin") index++;
	if (tokens[index] === "env") {
		index++;
		while (isShellAssignment(tokens[index] ?? "")) index++;
	}
	const commandName = tokens[index];
	if (!commandName) return undefined;
	if (commandName !== "git") return commandName;

	index++;
	while (index < tokens.length && tokens[index]?.startsWith("-")) {
		const nextIndex = skipGitGlobalOption(tokens, index);
		if (nextIndex <= index) break;
		index = nextIndex;
	}
	const gitSubcommand = tokens[index];
	if (gitSubcommand === "grep" || gitSubcommand === "diff") return `git ${gitSubcommand}`;
	return commandName;
}

export function semanticExitForBashCommand(command: string, exitCode: number | null): BashSemanticExit | undefined {
	if (exitCode !== COMMAND_SEMANTIC_EXIT_STATUS) return undefined;
	const commandName = commandNameForExitSemantics(command);
	switch (commandName) {
		case "grep":
		case "egrep":
		case "fgrep":
		case "rg":
		case "git grep":
			return { command: commandName, exitCode, summary: `${commandName} found no matches` };
		case "diff":
		case "git diff":
			return { command: commandName, exitCode, summary: `${commandName} found differences` };
		case "test":
		case "[":
			return { command: commandName, exitCode, summary: `${commandName} condition was false` };
		case "find":
			return {
				command: commandName,
				exitCode,
				summary: "find completed with partial results or inaccessible paths",
			};
		default:
			return undefined;
	}
}

function unquoteShellPath(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value.replace(/\\ /g, " ");
}

export function redundantCdToCurrentWorkingDirectory(command: string, cwd: string): boolean {
	const match = /^\s*cd\s+((?:"[^"]+"|'[^']+'|\\\S+|\S)+)\s*(?:&&|;)\s*\S/s.exec(command);
	if (!match) return false;
	let target = unquoteShellPath(match[1]!);
	if (target === "~" || target.startsWith("~/")) target = join(homedir(), target.slice(2));
	return resolve(cwd, target) === resolve(cwd);
}

function redundantCdError(): string {
	return "Blocked redundant cd: bash already runs in the current working directory. Run the command without `cd <cwd> && ...`, or use command-native flags like `git -C <dir>` / `npm --prefix <dir>` for another directory.";
}

function formatBashCall(
	args: { command?: string; timeout?: number | false; run_in_background?: boolean; tui_only?: boolean } | undefined,
	label: string,
): string {
	const command = str(args?.command);
	const timeout = resolveBashTimeout(args?.timeout as number | false | undefined);
	const isBackground = args?.run_in_background === true;
	const isTuiOnly = args?.tui_only === true;
	const modeSuffix = isBackground ? theme.fg("accent", " [bg]") : isTuiOnly ? theme.fg("accent", " [tui]") : "";
	const timeoutSuffix =
		modeSuffix || (timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : theme.fg("muted", " (no timeout)"));

	const prompt = `${theme.fg("toolTitle", theme.bold(label))} `;

	if (command === null) return prompt + invalidArgText(theme) + timeoutSuffix;
	if (!command) return prompt + theme.fg("toolOutput", "...") + timeoutSuffix;

	// Segment the command and highlight each portion in its own language
	const segments = segmentCommand(command);
	const allLines: string[] = [];
	for (const seg of segments) {
		const highlighted = highlightCode(seg.text, seg.lang);
		allLines.push(...highlighted);
	}
	const highlighted =
		allLines.length === 1
			? (allLines[0] ?? "")
			: (allLines[0] ?? "") +
				allLines
					.slice(1)
					.map((l) => `\n  ${l}`)
					.join("");

	return prompt + highlighted + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? BASH_MAX_OUTPUT_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const toolName = options?.toolName ?? "bash";
	const label = options?.label ?? "Bash";
	return {
		name: toolName,
		label,
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${BASH_MAX_OUTPUT_BYTES / 1024}KB (whichever is hit first); if truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. IMPORTANT: prefer native file tools for repo exploration (Find/Ls for paths, Grep for content, Read/Edit/Write for files); standalone \`grep\`/\`rg\`/\`find\`/\`ls\` in Bash is rejected, though pipeline filters on command output (e.g. \`kubectl ... | grep Ready\`) are fine. Pass run_in_background:true to run detached and return immediately with a bgId — a task_notification fires on completion (do not poll); read with bash_output(bgId), stop with bash_kill(bgId). Pass tui_only:true to stream output to the TUI but return only an exit/size summary to context (incompatible with run_in_background).`,
		promptSnippet:
			"Execute bash commands; set run_in_background:true for long-running work and read later with bash_output",
		executionMode: "sequential",
		promptGuidelines: [
			"Use run_in_background:true for any command likely to exceed ~30s when you don't need the output immediately (builds, installers, kubectl rollouts, long test suites, dev servers).",
			"A backgrounded bash job notifies you with a task_notification when it finishes (carrying the bgId + output log path). Do NOT poll it with sleep loops or re-run the command to check — continue other work and the harness re-invokes you on completion. Call bash_output(bgId) only to peek before it finishes, or use monitor_start to be woken on every output batch.",
			"Always stop background jobs you started but no longer need with bash_kill(bgId).",
			// Worded identically to system-prompt.ts so addGuideline deduplicates shared rules.
			"Prefer native file tools for repo exploration: Find/Ls for paths, Grep for known text/regex, SemanticGrep for conceptual searches. Standalone `grep`/`rg`/`find`/`ls` in Bash is discouraged, but pipeline filters on command output (e.g. `kubectl ... | grep Ready`) are fine.",
			"Use Bash for shell work and non-repo command output: `kubectl ... | jq`, `ps ... | awk`, git, package managers, `stat`/`wc`/`head`/`tail`.",
			"Use Read/Edit/Write for files instead of shelling out to view or modify file contents.",
		],
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{
				command,
				workdir,
				timeout,
				run_in_background,
				tui_only,
			}: {
				command: string;
				workdir?: string;
				timeout?: number | false;
				run_in_background?: boolean;
				tui_only?: boolean;
			},
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			// Per-call working directory (Codex exec_command parity). Absolute `workdir`
			// wins; a relative one resolves against the session cwd. A non-existent dir
			// surfaces downstream as a clear spawn error rather than running in the wrong
			// place. Omitting `workdir` is byte-identical to the previous behaviour.
			const effectiveCwd = workdir ? resolve(cwd, workdir) : cwd;
			const policy = bashPolicyStore.getStore();
			if (policy) {
				const denied = checkBashPolicy(command, policy);
				if (denied) {
					return {
						isError: true,
						content: [{ type: "text", text: denied }],
						details: undefined,
					};
				}
			}
			if (redundantCdToCurrentWorkingDirectory(command, effectiveCwd)) {
				return {
					isError: true,
					content: [{ type: "text", text: redundantCdError() }],
					details: undefined,
				};
			}

			if (tui_only && run_in_background) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "tui_only is incompatible with run_in_background. Background jobs already keep output out of context in the returned outputPath.",
						},
					],
					details: undefined,
				};
			}

			// Background fast-path: spawn detached, return immediately. No timeout, no output streaming.
			if (run_in_background) {
				const job = spawnBashBackground(command, effectiveCwd, options?.shellPath, commandPrefix);
				const text =
					`Backgrounded bash job ${job.id} (pid=${job.pid ?? "unknown"}).\n` +
					`Task id: ${job.id}\n` +
					`Command: ${command}\n` +
					`Output file: ${job.logPath}\n\n` +
					`Inspect output with Read(path="${job.logPath}", offset/limit as needed). Stop with TaskStop(task_id="${job.id}").`;
				return {
					content: [{ type: "text", text }],
					details: {
						bgId: job.id,
						taskId: job.id,
						pid: job.pid,
						logPath: job.logPath,
						outputPath: job.logPath,
						command,
						startedAt: job.startedAt,
					} as BashBgDetails as any,
				};
			}
			const timeoutSeconds = resolveBashTimeout(timeout);
			const startedAt = Date.now();
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, effectiveCwd, spawnHook);
			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash", maxBytes: BASH_MAX_OUTPUT_BYTES });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(BASH_MAX_OUTPUT_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				let backgroundedJobId: string | undefined;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout: timeoutSeconds,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
					backgroundedJobId = result.backgroundedJobId;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					// A timed-out command whose disposition failed (the core default kills)
					// throws the `timeout:N` sentinel; detach dispositions return a bgId instead.
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (backgroundedJobId) {
					const job = getBashBgJob(backgroundedJobId);
					const status =
						`Command exceeded ${timeoutSeconds}s and is still running — detached into background job bgId=${backgroundedJobId}` +
						(job?.pid ? ` (pid=${job.pid})` : "") +
						`. The process was NOT killed. Read live output with bash_output(bgId="${backgroundedJobId}"); stop it with bash_kill(bgId="${backgroundedJobId}").`;
					return {
						content: [{ type: "text", text: appendStatus(outputText, status) }],
						details: job ? ({ ...job, fullOutputPath: job.logPath } as unknown as BashBgDetails) : details,
					};
				}
				if (tui_only) {
					const durationStr = formatDuration(Date.now() - startedAt);
					const sizeStr = `${snapshot.truncation.totalLines} lines, ${formatSize(snapshot.truncation.totalBytes)}`;
					const pathHint = snapshot.fullOutputPath ? ` Saved: ${snapshot.fullOutputPath}` : "";
					const summary =
						exitCode === 0 || exitCode === null
							? `[tui_only] Command exited ${exitCode ?? "null"} after ${durationStr} (${sizeStr}). Output streamed to TUI only.${pathHint}`
							: `[tui_only] Command exited ${exitCode} after ${durationStr} (${sizeStr}). Output streamed to TUI only.${pathHint}`;
					if (exitCode !== 0 && exitCode !== null && !semanticExitForBashCommand(command, exitCode)) {
						throw new Error(summary);
					}
					return { content: [{ type: "text", text: summary }], details };
				}
				if (exitCode !== 0 && exitCode !== null) {
					const semanticExit = semanticExitForBashCommand(command, exitCode);
					if (!semanticExit) {
						throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
					}
					const status = `Command exited with code ${exitCode} (${semanticExit.summary}; treated as success).`;
					return { content: [{ type: "text", text: appendStatus(outputText, status) }], details };
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args, label));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}

export function createUppercaseBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createBashToolDefinition(cwd, { ...options, toolName: "Bash", label: "Bash" });
}

export function createUppercaseBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createUppercaseBashToolDefinition(cwd, options));
}

// ===========================================================================
// bash_output — read accumulated output from a backgrounded bash job
// ===========================================================================

/**
 * Render a background bash job's status header + bounded log slice — the body
 * of BashOutput, extracted so the task-registry seam (`core/tasks`) can reuse
 * the exact same bash rendering (tail/head/all
 * slicing, line caps, elapsed/size header) instead of reimplementing it.
 */
export function renderBashBgOutput(
	job: BashBgJob,
	options?: { mode?: "tail" | "head" | "all"; maxLines?: number },
): { text: string; fullOutputPath: string } {
	const { text, shownLines, totalLines, truncated } = readBashBgLog(job, {
		mode: options?.mode ?? "tail",
		maxLines: options?.maxLines ?? 200,
	});
	let logSize = 0;
	try {
		logSize = statSync(job.logPath).size;
	} catch {}
	const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
	const header =
		`bgId: ${job.id}\n` +
		`status: ${job.status}` +
		(job.status === "exited" ? ` (exit ${job.exitCode})` : "") +
		(job.status === "killed" && job.signal ? ` (${job.signal})` : "") +
		(job.status === "failed" && job.error ? ` (${job.error})` : "") +
		`\nelapsed: ${elapsed.toFixed(1)}s\n` +
		`log: ${job.logPath} (${(logSize / 1024).toFixed(1)} KB, ${totalLines} lines)` +
		(truncated
			? ` \u2014 showing ${shownLines} of ${totalLines}, capped at ${formatSize(BASH_MAX_OUTPUT_BYTES)}`
			: "");
	const body = text || "(no output yet)";
	return { text: `${header}\n\n${body}`, fullOutputPath: job.logPath };
}

function bashBgLogPathForId(id: string): string | undefined {
	// Background ids are generated by nextBashBgId(). Keep this strict so a
	// missing registry entry can only map to the persisted bash-bg log directory,
	// never to an arbitrary caller-controlled path.
	if (!/^bg_[a-z0-9]+_[a-z0-9]+$/i.test(id)) return undefined;
	return join(bashBgLogDir(), `${id}.log`);
}

/**
 * Render a persisted background-bash log whose in-memory registry entry is gone.
 *
 * This happens after a pi process/session restart or registry drop: the bg job
 * log survives under ~/.pi/agent/bash-bg, but the task adapter can no longer
 * know pid/exit code/timing. Claude Code's useful part here is the graceful UX:
 * surface the surviving artifact plus the limitation, instead of returning only
 * "No background task" and forcing the user to rediscover the log by hand.
 */
export function renderOrphanedBashBgOutput(
	id: string,
	options?: { mode?: "tail" | "head" | "all"; maxLines?: number },
): { text: string; fullOutputPath: string } | undefined {
	const logPath = bashBgLogPathForId(id);
	if (!logPath || !existsSync(logPath)) return undefined;
	const job: BashBgJob = {
		id,
		command: "(unknown — registry entry missing)",
		cwd: "(unknown — registry entry missing)",
		pid: undefined,
		startedAt: 0,
		status: "failed",
		exitCode: null,
		signal: null,
		logPath,
		endedAt: undefined,
		error: "registry entry missing; process may have exited or pi may have restarted",
	};
	const { text, shownLines, totalLines, truncated } = readBashBgLog(job, {
		mode: options?.mode ?? "tail",
		maxLines: options?.maxLines ?? 200,
	});
	let logSize = 0;
	try {
		logSize = statSync(logPath).size;
	} catch {}
	const header =
		`bgId: ${id}\n` +
		`status: registry-missing (persisted log found; exit status/pid unavailable)\n` +
		`log: ${logPath} (${(logSize / 1024).toFixed(1)} KB, ${totalLines} lines)` +
		(truncated ? ` — showing ${shownLines} of ${totalLines}, capped at ${formatSize(BASH_MAX_OUTPUT_BYTES)}` : "") +
		`\nnext: inspect the log above; if the command may still be running, verify externally (for example with ps) before restarting it.`;
	const body = text || "(log exists but has no output yet)";
	return { text: `${header}\n\n${body}`, fullOutputPath: logPath };
}

const bashOutputSchema = Type.Object({
	bgId: Type.String({ description: "Background job id returned by bash(run_in_background:true)." }),
	mode: Type.Optional(
		Type.Union([Type.Literal("tail"), Type.Literal("head"), Type.Literal("all")], {
			description: "Which slice of the log to return. Default: tail.",
		}),
	),
	maxLines: Type.Optional(Type.Number({ description: "Maximum lines to return (default 200, hard cap 1000)." })),
});

export type BashOutputToolInput = Static<typeof bashOutputSchema>;

export function createBashOutputToolDefinition(options?: {
	toolName?: string;
	label?: string;
	jobs?: BashBgJobStore;
	alwaysLoad?: boolean;
}): ToolDefinition<typeof bashOutputSchema, BashOutputToolDetails | undefined> {
	const toolName = options?.toolName ?? "bash_output";
	const label = options?.label ?? "BashOutput";
	const jobs = options?.jobs ?? createBashBgJobStore();
	return {
		name: toolName,
		label,
		description:
			"Read accumulated stdout/stderr from a backgrounded bash job (started via bash with run_in_background:true). Returns a bounded slice of the log plus job status. Does not block or wait \u2014 just shows current state. Use this when you need to peek at progress or grab results after the job has completed. For live streaming with wake-on-output behavior, use monitor_start instead.",
		promptSnippet: "Read the log of a backgrounded bash job by bgId",
		alwaysLoad: options?.alwaysLoad,
		executionMode: "parallel",
		parameters: bashOutputSchema,
		async execute(_id, { bgId, mode, maxLines }) {
			const job = jobs.get(bgId);
			if (!job) {
				const orphaned = renderOrphanedBashBgOutput(bgId, { mode, maxLines });
				if (orphaned) {
					return {
						content: [{ type: "text", text: orphaned.text }],
						details: { bgId, fullOutputPath: orphaned.fullOutputPath } as unknown as BashOutputToolDetails,
					};
				}
				const known =
					jobs
						.list()
						.map((knownJob) => knownJob.id)
						.slice(-5)
						.join(", ") || "(none)";
				return {
					content: [{ type: "text", text: `No background bash job with bgId=${bgId}. Recent ids: ${known}` }],
					details: undefined,
				};
			}
			const rendered = renderBashBgOutput(job, { mode, maxLines });
			return {
				content: [{ type: "text", text: rendered.text }],
				details: { ...job, fullOutputPath: rendered.fullOutputPath },
			};
		},
	};
}

export function createBashOutputTool(): AgentTool<typeof bashOutputSchema> {
	return wrapToolDefinition(createBashOutputToolDefinition());
}

export function createBashOutputNativeToolDefinition(options?: {
	jobs?: BashBgJobStore;
	alwaysLoad?: boolean;
}): ToolDefinition<typeof bashOutputSchema, BashOutputToolDetails | undefined> {
	return createBashOutputToolDefinition({
		toolName: "BashOutput",
		label: "BashOutput",
		jobs: options?.jobs,
		alwaysLoad: options?.alwaysLoad,
	});
}

export function createBashOutputNativeTool(): AgentTool<typeof bashOutputSchema> {
	return wrapToolDefinition(createBashOutputNativeToolDefinition());
}

// ===========================================================================
// bash_kill — stop a backgrounded bash job
// ===========================================================================

const bashKillSchema = Type.Object({
	bgId: Type.String({ description: "Background job id returned by bash(run_in_background:true)." }),
});

export type BashKillToolInput = Static<typeof bashKillSchema>;

export function createBashKillToolDefinition(options?: {
	toolName?: string;
	label?: string;
	jobs?: BashBgJobStore;
	alwaysLoad?: boolean;
}): ToolDefinition<typeof bashKillSchema, BashBgJob | undefined> {
	const toolName = options?.toolName ?? "bash_kill";
	const label = options?.label ?? "KillShell";
	const jobs = options?.jobs ?? createBashBgJobStore();
	return {
		name: toolName,
		label,
		description:
			"Stop a backgrounded bash job (started via bash with run_in_background:true). Sends SIGTERM to the whole process tree; the job moves to status=killed. Idempotent \u2014 calling on an already-finished job is safe and just reports state.",
		promptSnippet: "Stop a backgrounded bash job by bgId",
		alwaysLoad: options?.alwaysLoad,
		executionMode: "sequential",
		parameters: bashKillSchema,
		async execute(_id, { bgId }) {
			const job = jobs.get(bgId);
			if (!job) {
				return {
					content: [{ type: "text", text: `No background bash job with bgId=${bgId}` }],
					details: undefined,
				};
			}
			if (job.status !== "running") {
				return {
					content: [
						{
							type: "text",
							text: `bgId=${bgId} already ${job.status} (exit ${job.exitCode}, signal ${job.signal ?? "none"}).`,
						},
					],
					details: job,
				};
			}
			const killed = jobs.kill(bgId);
			if (killed.error) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to kill bgId=${bgId} (pid=${job.pid}): ${killed.error}`,
						},
					],
					details: job,
				};
			}
			return {
				content: [{ type: "text", text: `Killed bgId=${bgId} (pid=${job.pid ?? "unknown"}).` }],
				details: job,
			};
		},
	};
}

export function createBashKillTool(): AgentTool<typeof bashKillSchema> {
	return wrapToolDefinition(createBashKillToolDefinition());
}

export function createKillShellToolDefinition(options?: {
	jobs?: BashBgJobStore;
	alwaysLoad?: boolean;
}): ToolDefinition<typeof bashKillSchema, BashBgJob | undefined> {
	return createBashKillToolDefinition({
		toolName: "KillShell",
		label: "KillShell",
		jobs: options?.jobs,
		alwaysLoad: options?.alwaysLoad,
	});
}

export function createKillShellTool(): AgentTool<typeof bashKillSchema> {
	return wrapToolDefinition(createKillShellToolDefinition());
}
