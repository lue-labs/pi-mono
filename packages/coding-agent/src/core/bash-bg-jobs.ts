// Background bash job registry and lifecycle (fork-owned; extracted verbatim from tools/bash.ts).
//
// Background bash jobs are tracked in-process so siblings bash_output / bash_kill
// can read or stop them by id. Output is appended to a log file under
// ~/.pi/agent/bash-bg/<bgId>.log so it survives process exit and can be tailed.

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "child_process";
import { stripAnsi } from "../utils/ansi.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../utils/shell.ts";
import { formatSize, truncateHead, truncateTail } from "./tools/truncate.ts";

export interface BashBgJob {
	id: string;
	command: string;
	cwd: string;
	ownerSessionId?: string;
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
	killForSession(sessionId: string): void;
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

export function bashBgLogDir(): string {
	const dir = join(homedir(), ".pi", "agent", "bash-bg");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Background-bash logs older than this are pruned on startup. */
export const BASH_BG_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reap background-bash log files left behind by past sessions.
 *
 * Each detached job writes a `~/.pi/agent/bash-bg/<id>.log` that is *designed* to
 * survive process exit so its output can be tailed post-mortem (see the exit
 * handler note above). Nothing ever pruned them, so the directory grew unbounded
 * (thousands of files / hundreds of MB on long-lived machines). This deletes
 * every `.log` whose mtime is older than maxAgeMs and returns the count removed.
 *
 * Mirrors the session-liveness stale-marker sweep: best-effort, never throws, safe
 * to call off the hot path at startup. Running jobs keep their logs fresh via
 * writes, and the sweep runs at load before any job exists, so live output is
 * never touched.
 */
export function sweepStaleBashBgLogs(
	maxAgeMs: number = BASH_BG_LOG_MAX_AGE_MS,
	now: number = Date.now(),
	dir: string = join(homedir(), ".pi", "agent", "bash-bg"),
): number {
	let removed = 0;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0; // dir absent or unreadable
	}
	for (const name of names) {
		if (!name.endsWith(".log")) continue;
		const logPath = join(dir, name);
		try {
			if (now - statSync(logPath).mtimeMs <= maxAgeMs) continue;
			rmSync(logPath);
			removed++;
		} catch {
			// Vanished or unreadable; another process may be reaping it. Ignore.
		}
	}
	return removed;
}

/**
 * Cap on terminal (exited/killed/failed) jobs retained in the in-memory registry.
 * Running jobs are never evicted. Bounds metadata growth over a long-lived session
 * that launches thousands of background commands (mirrors MAX_RECENT_RUNS in
 * agents/status.ts). Output lives in log files, so evicting a stale entry only
 * drops a small metadata record, not any tailed output.
 */
export const BASH_BG_MAX_TERMINAL = 50;

/**
 * Pure policy: given all jobs, return the ids of terminal jobs to evict once the
 * terminal count exceeds the cap. Running jobs are never selected; the most
 * recently finished are kept so bash_output on a just-finished job still resolves.
 * Injectable so the eviction policy is unit-testable without spawning processes.
 */
export function selectTerminalBashBgJobIdsToEvict(jobs: BashBgJob[], cap: number = BASH_BG_MAX_TERMINAL): string[] {
	const terminal = jobs.filter((job) => job.status !== "running");
	if (terminal.length <= cap) return [];
	terminal.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
	return terminal.slice(0, terminal.length - cap).map((job) => job.id);
}

function evictTerminalBashBgJobs(): void {
	for (const id of selectTerminalBashBgJobIdsToEvict([...bashBgJobs.values()])) {
		bashBgJobs.delete(id);
	}
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
		killForSession: killBashBgJobsForSession,
		killAll: killAllBashBgJobs,
	};
}

/** Terminate running jobs owned by one session without clearing the registry. */
export function killBashBgJobsForSession(sessionId: string): void {
	for (const job of bashBgJobs.values()) {
		if (job.status === "running" && job.ownerSessionId === sessionId) {
			killBashBgJob(job.id);
		}
	}
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

/**
 * Cap on concurrently-running background bash jobs. Without a ceiling a looping
 * or runaway agent can spawn detached children without bound, exhausting PIDs /
 * RAM and leaving orphans behind. Override with PI_BASH_BG_MAX.
 */
export const BASH_BG_MAX_CONCURRENT = Number.parseInt(process.env.PI_BASH_BG_MAX ?? "", 10) || 32;

/**
 * Throw if starting another background job would exceed the ceiling. Pure guard
 * (running count injected) so the policy is unit-testable without spawning.
 */
export function assertBashBgCapacity(running: number, ceiling: number = BASH_BG_MAX_CONCURRENT): void {
	if (running >= ceiling) {
		throw new Error(
			`Refusing to start background bash job: ${running}/${ceiling} already running (PI_BASH_BG_MAX). ` +
				`Stop finished/unneeded jobs with bash_kill / TaskStop first.`,
		);
	}
}

export function spawnBashBackground(
	command: string,
	cwd: string,
	shellPath?: string,
	commandPrefix?: string,
	ownerSessionId?: string,
): BashBgJob {
	assertBashBgCapacity(getRunningBashBgJobsSorted().length);
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
		ownerSessionId,
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
	evictTerminalBashBgJobs();
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
function adoptBashBackground(
	child: ReturnType<typeof spawn>,
	command: string,
	cwd: string,
	ownerSessionId?: string,
): BashBgJob {
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
		ownerSessionId,
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
	evictTerminalBashBgJobs();
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
export function disposeBashTimeout(
	child: ReturnType<typeof spawn>,
	command: string,
	cwd: string,
	timeoutMs: number,
	ownerSessionId?: string,
): BashTimeoutOutcome {
	return bashTimeoutResolver({
		command,
		cwd,
		timeoutMs,
		background: () => adoptBashBackground(child, command, cwd, ownerSessionId),
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
export const BASH_MAX_OUTPUT_BYTES = 20 * 1024;

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

export function readBashBgLog(
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

export interface BashBgDetails {
	bgId: string;
	taskId: string;
	pid: number | undefined;
	logPath: string;
	outputPath: string;
	command: string;
	startedAt: number;
}
