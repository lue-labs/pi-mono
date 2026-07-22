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
	readSync,
	rmSync,
	statSync,
	truncateSync,
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

/**
 * Explicit lifecycle classification only. Production monitor processes use the
 * monitor subsystem and do not create `BashBgJob` records; this reserved tag
 * supports programmatic callers that deliberately share the registry. Never
 * infer it from command text.
 */
export type BashBgJobKind = "bash" | "monitor";

export type BashBgTerminalReason =
	| "clean_exit"
	| "non_zero_exit"
	| "signal"
	| "output_limit"
	| "manual_kill"
	| "spawn_error"
	| "stream_error";

/**
 * Process-lifecycle state owned by the background-bash registry. It is
 * deliberately separate from model-facing tool inputs: consumers can render
 * lifecycle evidence without changing the Bash/Task control schemas.
 */
export interface BashBgLifecycleState {
	kind: BashBgJobKind;
	outputBytes: number;
	outputLimitBytes: number;
	terminalReason: BashBgTerminalReason | undefined;
	promptStalledAt: number | undefined;
	promptStallTail: string | undefined;
}

/** Internal spawn options; the public Bash tool schema stays unchanged. */
export interface BashBgJobOptions {
	/** Explicit only; monitor command names are not classified as monitor jobs. */
	kind?: BashBgJobKind;
	maxOutputBytes?: number;
}

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
	/**
	 * Fork-owned lifecycle metadata. Optional for source/API compatibility with
	 * consumers that construct or persist the pre-lifecycle job shape.
	 */
	lifecycle?: BashBgLifecycleState;
}

/**
 * Owner-facing lifecycle notification for a background shell task. This is
 * runtime metadata, deliberately separate from all model-facing tool inputs.
 */
export interface BackgroundShellNotification {
	type: "shell_completion" | "shell_needs_input" | "shell_output_limited";
	taskId: string;
	ownerSessionId?: string;
	status: "exited" | "failed" | "killed";
	exitCode?: number | null;
	signal?: string | null;
	outputPath: string;
	summary: string;
	terminalReason?: BashBgTerminalReason;
}

function backgroundShellNotificationType(job: BashBgJob): BackgroundShellNotification["type"] {
	if (job.status === "running" && job.lifecycle?.promptStalledAt !== undefined) return "shell_needs_input";
	return job.lifecycle?.terminalReason === "output_limit" ? "shell_output_limited" : "shell_completion";
}

function backgroundShellNotificationStatus(job: BashBgJob): BackgroundShellNotification["status"] {
	// Prompt stalls are still live processes, but this terminal-status contract
	// reports an actionable failure. Consumers distinguish the live prompt from a
	// terminal failure by the notification type.
	if (job.status === "running" || job.lifecycle?.terminalReason === "non_zero_exit") return "failed";
	return job.status;
}

function backgroundShellNotificationSummary(
	type: BackgroundShellNotification["type"],
	status: BackgroundShellNotification["status"],
): string {
	if (type === "shell_needs_input") return "Background shell task needs input.";
	if (type === "shell_output_limited") return "Background shell task stopped after reaching its output limit.";
	if (status === "exited") return "Background shell task completed.";
	if (status === "killed") return "Background shell task was stopped.";
	return "Background shell task failed.";
}

/** Build the complete owner notification from the registry-owned job snapshot. */
export function createBackgroundShellNotification(job: BashBgJob): BackgroundShellNotification {
	const type = backgroundShellNotificationType(job);
	const status = backgroundShellNotificationStatus(job);
	return {
		type,
		taskId: job.id,
		...(job.ownerSessionId === undefined ? {} : { ownerSessionId: job.ownerSessionId }),
		status,
		exitCode: job.exitCode,
		signal: job.signal,
		outputPath: job.logPath,
		summary: backgroundShellNotificationSummary(type, status),
		...(job.lifecycle?.terminalReason === undefined ? {} : { terminalReason: job.lifecycle.terminalReason }),
	};
}

/** Registry-owned jobs always carry lifecycle state, unlike the public shape. */
interface OwnedBashBgJob extends BashBgJob {
	lifecycle: BashBgLifecycleState;
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

const bashBgJobs = new Map<string, OwnedBashBgJob>();
const bashBgSubscribers = new Set<() => void>();

type BashBgWatchState = {
	lastOutputBytes: number;
	lastGrowthAt: number;
	promptNotifiedForBytes: number | undefined;
};

const bashBgWatchStates = new Map<string, BashBgWatchState>();
const bashBgTerminalNotified = new Set<string>();
let bashBgWatchdog: NodeJS.Timeout | undefined;

function notifyBashBgJobsChanged(): void {
	for (const subscriber of bashBgSubscribers) subscriber();
}

export function subscribeBashBgJobs(callback: () => void): () => void {
	bashBgSubscribers.add(callback);
	return () => bashBgSubscribers.delete(callback);
}

// Terminal listeners fire once for natural terminal status (process exit or
// spawn error) and the protective output-limit stop. Deliberate stops
// (bash_kill / session dispose / killAll) do NOT fire — the agent already knows
// it stopped them. This mirrors the agent background-run terminal listener so
// the owning session can inject a completion notification, matching Claude
// Code's task-notification wake ("you'll be notified when it finishes").
const bashBgTerminalListeners = new Set<(job: BashBgJob) => void>();
const bashBgStallListeners = new Set<(job: BashBgJob) => void>();
// Interactive ownership is exclusive: a re-bound TUI replaces the prior
// receiver for its session rather than causing duplicate model wakes.
const bashBgOwnerTerminalListeners = new Map<string, (job: BashBgJob) => void>();
const bashBgOwnerStallListeners = new Map<string, (job: BashBgJob) => void>();
const bashBgOwnerNotificationListeners = new Map<string, (notification: BackgroundShellNotification) => void>();

export function subscribeBashBgTerminal(callback: (job: BashBgJob) => void): () => void {
	bashBgTerminalListeners.add(callback);
	return () => bashBgTerminalListeners.delete(callback);
}

/**
 * Fires when the process-scoped watchdog has evidence that a non-monitor job
 * is blocked on an interactive prompt. The job remains running; this is an
 * owner-wake event, not a terminal transition.
 */
export function subscribeBashBgStall(callback: (job: BashBgJob) => void): () => void {
	bashBgStallListeners.add(callback);
	return () => bashBgStallListeners.delete(callback);
}

function subscribeBashBgOwnerEvent<T>(
	listeners: Map<string, (event: T) => void>,
	ownerSessionId: string,
	callback: (event: T) => void,
): () => void {
	listeners.set(ownerSessionId, callback);
	return () => {
		if (listeners.get(ownerSessionId) === callback) listeners.delete(ownerSessionId);
	};
}

/** Register the sole terminal wake receiver for one owning session. */
export function subscribeBashBgTerminalForOwner(
	ownerSessionId: string,
	callback: (job: BashBgJob) => void,
): () => void {
	return subscribeBashBgOwnerEvent(bashBgOwnerTerminalListeners, ownerSessionId, callback);
}

/** Register the sole prompt-stall wake receiver for one owning session. */
export function subscribeBashBgStallForOwner(ownerSessionId: string, callback: (job: BashBgJob) => void): () => void {
	return subscribeBashBgOwnerEvent(bashBgOwnerStallListeners, ownerSessionId, callback);
}

/** Register the sole lifecycle-notification receiver for one owning session. */
export function subscribeBashBgNotificationForOwner(
	ownerSessionId: string,
	callback: (notification: BackgroundShellNotification) => void,
): () => void {
	return subscribeBashBgOwnerEvent(bashBgOwnerNotificationListeners, ownerSessionId, callback);
}

function notifyBashBgOwner(listeners: Map<string, (job: BashBgJob) => void>, job: BashBgJob): void {
	const listener = job.ownerSessionId ? listeners.get(job.ownerSessionId) : undefined;
	if (!listener) return;
	try {
		listener(job);
	} catch {
		// Owner wake delivery must not disrupt lifecycle bookkeeping.
	}
}

function notifyBashBgTerminal(job: BashBgJob): void {
	for (const listener of bashBgTerminalListeners) {
		try {
			listener(job);
		} catch {
			// A listener must never break the process exit/error handler.
		}
	}
	notifyBashBgOwner(bashBgOwnerTerminalListeners, job);
	notifyBashBgOwnerNotification(job);
}

function notifyBashBgTerminalOnce(job: BashBgJob): void {
	if (bashBgTerminalNotified.has(job.id)) return;
	bashBgTerminalNotified.add(job.id);
	notifyBashBgTerminal(job);
}

function notifyBashBgStall(job: BashBgJob): void {
	for (const listener of bashBgStallListeners) {
		try {
			listener(job);
		} catch {
			// A listener must never break the watchdog.
		}
	}
	notifyBashBgOwner(bashBgOwnerStallListeners, job);
	notifyBashBgOwnerNotification(job);
}

function notifyBashBgOwnerNotification(job: BashBgJob): void {
	const listener = job.ownerSessionId ? bashBgOwnerNotificationListeners.get(job.ownerSessionId) : undefined;
	if (!listener) return;
	try {
		listener(createBackgroundShellNotification(job));
	} catch {
		// Owner wake delivery must not disrupt lifecycle bookkeeping.
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
		bashBgWatchStates.delete(id);
		bashBgTerminalNotified.delete(id);
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
	return getRunningOwnedBashBgJobsSorted();
}

function getRunningOwnedBashBgJobsSorted(): OwnedBashBgJob[] {
	return [...bashBgJobs.values()].filter((job) => job.status === "running").sort((a, b) => a.startedAt - b.startedAt);
}

export function killBashBgJob(id: string): { job: BashBgJob | undefined; error?: string } {
	const job = bashBgJobs.get(id);
	if (!job || job.status !== "running") return { job };
	return stopBashBgJob(job, "manual_kill", false);
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
		if (job.status === "running") stopBashBgJob(job, "manual_kill", false);
	}
	bashBgJobs.clear();
	bashBgWatchStates.clear();
	bashBgTerminalNotified.clear();
	stopBashBgWatchdogIfIdle();
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

/** One process-scoped sweep, regardless of how many background jobs are live. */
export const BASH_BG_WATCHDOG_INTERVAL_MS = 5_000;
export const BASH_BG_STALL_THRESHOLD_MS = 45_000;
export const BASH_BG_STALL_TAIL_BYTES = 1024;
export const BASH_BG_DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
export const BASH_BG_MAX_LOG_READ_BYTES = 256 * 1024;

function configuredBashBgOutputLimit(): number {
	const candidate = Number.parseInt(process.env.PI_BASH_BG_MAX_OUTPUT_BYTES ?? "", 10);
	return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : BASH_BG_DEFAULT_MAX_OUTPUT_BYTES;
}

function outputLimitForBashBgJob(options: BashBgJobOptions | undefined): number {
	if (options?.maxOutputBytes === undefined) return configuredBashBgOutputLimit();
	if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
		throw new Error("Background bash maxOutputBytes must be a positive safe integer");
	}
	return options.maxOutputBytes;
}

function safeBashBgLogSize(logPath: string): number {
	try {
		return statSync(logPath).size;
	} catch {
		return 0;
	}
}

function readBashBgLogTailBytes(logPath: string, maxBytes: number): string {
	let fd: number | undefined;
	try {
		const size = statSync(logPath).size;
		if (size === 0) return "";
		const bytes = Math.min(size, maxBytes);
		const buffer = Buffer.allocUnsafe(bytes);
		fd = openSync(logPath, "r");
		readSync(fd, buffer, 0, bytes, Math.max(0, size - bytes));
		return buffer.toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// The tail is advisory; a close failure must not affect the process.
			}
		}
	}
}

const BASH_BG_PROMPT_PATTERNS = [
	/\(y\/n\)/iu,
	/\(Y\/n\)/u,
	/\(y\/N\)/u,
	/\[y\/n\]/iu,
	/\(yes\/no\)/iu,
	/\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\?\s*$/iu,
	/Press (?:any key|Enter)/iu,
	/Continue\?/iu,
	/Overwrite\?/iu,
];

/** Last-line prompt recognizer used by the output-stall watchdog. */
export function looksLikeBashBgPrompt(tail: string): boolean {
	const lastLine = tail.trimEnd().split("\n").pop() ?? "";
	return BASH_BG_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}

function stopBashBgWatchdogIfIdle(): void {
	if (getRunningBashBgJobsSorted().length > 0 || !bashBgWatchdog) return;
	clearInterval(bashBgWatchdog);
	bashBgWatchdog = undefined;
}

function transitionBashBgJob(
	job: OwnedBashBgJob,
	status: Exclude<BashBgJob["status"], "running">,
	reason: BashBgTerminalReason,
	notifyOwner: boolean,
): boolean {
	if (job.status !== "running") return false;
	job.status = status;
	job.endedAt = Date.now();
	job.lifecycle.terminalReason = reason;
	job.lifecycle.promptStalledAt = undefined;
	job.lifecycle.promptStallTail = undefined;
	bashBgWatchStates.delete(job.id);
	stopBashBgWatchdogIfIdle();
	notifyBashBgJobsChanged();
	if (notifyOwner) notifyBashBgTerminalOnce(job);
	return true;
}

function trimBashBgLogToOutputLimit(job: OwnedBashBgJob): void {
	try {
		truncateSync(job.logPath, job.lifecycle.outputLimitBytes);
	} catch {
		// Retain the artifact if the filesystem refuses a trim rather than masking
		// the lifecycle transition.
	}
	job.lifecycle.outputBytes = safeBashBgLogSize(job.logPath);
	notifyBashBgJobsChanged();
}

type BoundedBashBgOutputSink = {
	append(data: Buffer): void;
	close(): void;
	onError(handler: (error: Error) => void): void;
};

type BashBgStopRequest = {
	reason: Extract<BashBgTerminalReason, "manual_kill" | "output_limit" | "stream_error">;
	notifyOwner: boolean;
};

type BashBgChildLifecycle = {
	processSettled: boolean;
	stdoutSettled: boolean;
	stderrSettled: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	spawnError: Error | undefined;
	streamError: Error | undefined;
	stopRequest: BashBgStopRequest | undefined;
	sink: BoundedBashBgOutputSink;
};

// The public job record remains a durable snapshot. Pipe/exit coordination is
// live process state only, so consumers cannot observe a false terminal before
// the log's final buffered bytes are durable.
const bashBgChildLifecycles = new WeakMap<OwnedBashBgJob, BashBgChildLifecycle>();

function stopBashBgJob(
	job: OwnedBashBgJob,
	reason: Extract<BashBgTerminalReason, "manual_kill" | "output_limit">,
	notifyOwner: boolean,
): { job: BashBgJob; error?: string } {
	const lifecycle = bashBgChildLifecycles.get(job);
	if (
		job.status !== "running" ||
		!lifecycle ||
		lifecycle.stopRequest ||
		(reason === "manual_kill" && lifecycle.processSettled)
	)
		return { job };
	if (reason === "output_limit") {
		job.error = `Background output exceeded ${formatSize(job.lifecycle.outputLimitBytes)} limit`;
	}
	lifecycle.stopRequest = { reason, notifyOwner };
	if (reason === "manual_kill") {
		// A deliberate stop is complete from the caller's perspective as soon as
		// we accept it. Pipe callbacks still own fd/process cleanup, but must not
		// turn this terminal decision into a natural-exit wake later.
		transitionBashBgJob(job, "killed", reason, false);
	}
	let error: string | undefined;
	if (job.pid) {
		try {
			killProcessTree(job.pid);
		} catch (err) {
			// ESRCH is already-terminal success. Manual stops have already published
			// their terminal state; output-limit stops still wait for stream drain.
			if ((err as { code?: string })?.code !== "ESRCH") {
				error = err instanceof Error ? err.message : String(err);
			}
		}
	}
	return error ? { job, error } : { job };
}

/**
 * Write a live child stream into its log without ever letting the filesystem
 * exceed the registry cap. The sink, rather than the five-second watchdog, is
 * the enforcement seam so a noisy process is stopped on the first oversized
 * chunk. Its closed latch also makes stream/exit/watchdog races harmless.
 */
function createBoundedBashBgOutputSink(job: OwnedBashBgJob, fd: number): BoundedBashBgOutputSink {
	let closed = false;
	let errorHandler: ((error: Error) => void) | undefined;
	const close = () => {
		if (closed) return;
		closed = true;
		try {
			closeSync(fd);
		} catch {
			// The child has already reached a terminal lifecycle state; an fd close
			// failure must not disturb it.
		}
	};
	const append = (data: Buffer) => {
		if (closed || job.status !== "running") return;
		const remaining = job.lifecycle.outputLimitBytes - job.lifecycle.outputBytes;
		if (remaining <= 0) {
			stopBashBgJob(job, "output_limit", true);
			return;
		}

		const allowed = data.subarray(0, remaining);
		let written = 0;
		try {
			while (written < allowed.byteLength) {
				const count = writeSync(fd, allowed, written, allowed.byteLength - written);
				if (count <= 0) break;
				written += count;
			}
		} catch (error) {
			close();
			errorHandler?.(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		job.lifecycle.outputBytes += written;

		// Hitting the limit exactly is terminal too: continuing would permit the
		// next chunk to exceed the promised ceiling.
		if (data.byteLength >= remaining) {
			stopBashBgJob(job, "output_limit", true);
		}
	};
	return {
		append,
		close,
		onError(handler) {
			errorHandler = handler;
		},
	};
}

function finalizeBashBgChild(job: OwnedBashBgJob, lifecycle: BashBgChildLifecycle): void {
	if (!lifecycle.processSettled || !lifecycle.stdoutSettled || !lifecycle.stderrSettled) return;
	lifecycle.sink.close();
	if (job.status !== "running") return;

	job.exitCode = lifecycle.exitCode;
	job.signal = lifecycle.signal;
	const stop = lifecycle.stopRequest;
	if (stop) {
		// taskkill is asynchronous on Windows, so the output stream may race the
		// process exit. The close latches above prove there can be no further write.
		if (stop.reason === "output_limit") trimBashBgLogToOutputLimit(job);
		if (stop.reason === "stream_error") {
			job.error = `Background output stream error: ${lifecycle.streamError?.message ?? "unknown error"}`;
			transitionBashBgJob(job, "failed", "stream_error", stop.notifyOwner);
		} else {
			transitionBashBgJob(job, "killed", stop.reason, stop.notifyOwner);
		}
		return;
	}
	if (lifecycle.streamError) {
		job.error = `Background output stream error: ${lifecycle.streamError.message}`;
		transitionBashBgJob(job, "failed", "stream_error", true);
		return;
	}
	if (lifecycle.spawnError) {
		job.error = lifecycle.spawnError.message;
		transitionBashBgJob(job, "failed", "spawn_error", true);
		return;
	}
	if (lifecycle.signal) transitionBashBgJob(job, "killed", "signal", true);
	else transitionBashBgJob(job, "exited", lifecycle.exitCode === 0 ? "clean_exit" : "non_zero_exit", true);
}

function settleBashBgStream(job: OwnedBashBgJob, lifecycle: BashBgChildLifecycle, stream: "stdout" | "stderr"): void {
	if (stream === "stdout") lifecycle.stdoutSettled = true;
	else lifecycle.stderrSettled = true;
	finalizeBashBgChild(job, lifecycle);
}

function stopForBashBgStreamError(job: OwnedBashBgJob, lifecycle: BashBgChildLifecycle, error: Error): void {
	if (!lifecycle.streamError) lifecycle.streamError = error;
	if (lifecycle.stopRequest || lifecycle.processSettled || job.status !== "running") return;
	lifecycle.stopRequest = { reason: "stream_error", notifyOwner: true };
	if (!job.pid) return;
	try {
		killProcessTree(job.pid);
	} catch {
		// The process may have already exited; its exit/close events will finalize.
	}
}

function bindBashBgOutputStream(
	job: OwnedBashBgJob,
	lifecycle: BashBgChildLifecycle,
	stream: NodeJS.ReadableStream | null,
	name: "stdout" | "stderr",
): void {
	if (!stream) {
		settleBashBgStream(job, lifecycle, name);
		return;
	}
	stream.on("data", lifecycle.sink.append);
	stream.once("error", (error) => {
		const normalized = error instanceof Error ? error : new Error(String(error));
		stopForBashBgStreamError(job, lifecycle, normalized);
		settleBashBgStream(job, lifecycle, name);
	});
	stream.once("close", () => settleBashBgStream(job, lifecycle, name));
	unrefBashBgOutputStream(stream);
}

function bindBashBgChildLifecycle(
	child: ReturnType<typeof spawn>,
	job: OwnedBashBgJob,
	sink: BoundedBashBgOutputSink,
): void {
	const lifecycle: BashBgChildLifecycle = {
		processSettled: false,
		stdoutSettled: false,
		stderrSettled: false,
		exitCode: null,
		signal: null,
		spawnError: undefined,
		streamError: undefined,
		stopRequest: undefined,
		sink,
	};
	bashBgChildLifecycles.set(job, lifecycle);
	sink.onError((error) => stopForBashBgStreamError(job, lifecycle, error));
	bindBashBgOutputStream(job, lifecycle, child.stdout, "stdout");
	bindBashBgOutputStream(job, lifecycle, child.stderr, "stderr");
	child.on("error", (error) => {
		lifecycle.spawnError = error;
		lifecycle.processSettled = true;
		if (child.pid) untrackDetachedChildPid(child.pid);
		finalizeBashBgChild(job, lifecycle);
	});
	child.on("exit", (code, signal) => {
		lifecycle.exitCode = code;
		lifecycle.signal = signal;
		lifecycle.processSettled = true;
		if (child.pid) untrackDetachedChildPid(child.pid);
		finalizeBashBgChild(job, lifecycle);
	});
	// ChildProcess close follows both exit/error and stdio closure. It is a
	// fallback for platforms where an absent/destroyed pipe never emits close.
	child.on("close", () => {
		settleBashBgStream(job, lifecycle, "stdout");
		settleBashBgStream(job, lifecycle, "stderr");
	});
}

function unrefBashBgOutputStream(stream: NodeJS.ReadableStream | null): void {
	const unref = (stream as unknown as { unref?: () => void } | null)?.unref;
	unref?.call(stream);
}

/**
 * Evaluate every running job once. Exported for deterministic lifecycle tests;
 * production invokes it from the one unref'd process watchdog below.
 */
export function checkBashBgLifecycle(now: number = Date.now()): void {
	for (const job of getRunningOwnedBashBgJobsSorted()) {
		const size = safeBashBgLogSize(job.logPath);
		job.lifecycle.outputBytes = size;
		if (size > job.lifecycle.outputLimitBytes) {
			stopBashBgJob(job, "output_limit", true);
			continue;
		}

		const watch = bashBgWatchStates.get(job.id) ?? {
			lastOutputBytes: 0,
			lastGrowthAt: job.startedAt,
			promptNotifiedForBytes: undefined,
		};
		bashBgWatchStates.set(job.id, watch);
		if (size > watch.lastOutputBytes) {
			watch.lastOutputBytes = size;
			watch.lastGrowthAt = now;
			watch.promptNotifiedForBytes = undefined;
			if (job.lifecycle.promptStalledAt !== undefined) {
				job.lifecycle.promptStalledAt = undefined;
				job.lifecycle.promptStallTail = undefined;
				notifyBashBgJobsChanged();
			}
			continue;
		}

		if (job.lifecycle.kind === "monitor" || now - watch.lastGrowthAt < BASH_BG_STALL_THRESHOLD_MS) continue;
		if (watch.promptNotifiedForBytes === size) continue;

		const tail = readBashBgLogTailBytes(job.logPath, BASH_BG_STALL_TAIL_BYTES);
		if (!looksLikeBashBgPrompt(tail)) {
			// A quiet build is not a prompt. Retry a bounded tail inspection only
			// after another full threshold rather than every five-second sweep.
			watch.lastGrowthAt = now;
			continue;
		}

		watch.promptNotifiedForBytes = size;
		job.lifecycle.promptStalledAt = now;
		job.lifecycle.promptStallTail = tail;
		notifyBashBgJobsChanged();
		notifyBashBgStall(job);
	}
}

function startBashBgWatchdog(): void {
	if (bashBgWatchdog) return;
	bashBgWatchdog = setInterval(() => checkBashBgLifecycle(), BASH_BG_WATCHDOG_INTERVAL_MS);
	bashBgWatchdog.unref();
}

export function spawnBashBackground(
	command: string,
	cwd: string,
	shellPath?: string,
	commandPrefix?: string,
	ownerSessionId?: string,
	jobOptions?: BashBgJobOptions,
): BashBgJob {
	assertBashBgCapacity(getRunningBashBgJobsSorted().length);
	const outputLimitBytes = outputLimitForBashBgJob(jobOptions);
	const id = nextBashBgId();
	const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
	const logPath = join(bashBgLogDir(), `${id}.log`);
	const { shell, args } = getShellConfig(shellPath);
	if (!existsSync(cwd)) {
		throw new Error(`Working directory does not exist: ${cwd}`);
	}
	const outputFd = openSync(logPath, "a");
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(shell, [...args, resolvedCommand], {
			cwd,
			detached: process.platform !== "win32",
			env: getShellEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		closeSync(outputFd);
		throw error;
	}
	if (child.pid) trackDetachedChildPid(child.pid);
	const job: OwnedBashBgJob = {
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
		lifecycle: {
			kind: jobOptions?.kind ?? "bash",
			outputBytes: 0,
			outputLimitBytes,
			terminalReason: undefined,
			promptStalledAt: undefined,
			promptStallTail: undefined,
		},
	};
	bashBgJobs.set(id, job);
	const sink = createBoundedBashBgOutputSink(job, outputFd);
	bashBgWatchStates.set(id, {
		lastOutputBytes: 0,
		lastGrowthAt: job.startedAt,
		promptNotifiedForBytes: undefined,
	});
	evictTerminalBashBgJobs();
	startBashBgWatchdog();
	notifyBashBgJobsChanged();
	bindBashBgChildLifecycle(child, job, sink);
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
	jobOptions?: BashBgJobOptions,
): BashBgJob {
	const outputLimitBytes = outputLimitForBashBgJob(jobOptions);
	const id = nextBashBgId();
	const logPath = join(bashBgLogDir(), `${id}.log`);
	let outputFd: number;
	try {
		outputFd = openSync(logPath, "a");
	} catch (error) {
		if (child.pid) {
			try {
				killProcessTree(child.pid);
			} catch {
				// Preserve the log-open failure; the child may already have exited.
			}
			untrackDetachedChildPid(child.pid);
		}
		throw error;
	}
	const job: OwnedBashBgJob = {
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
		lifecycle: {
			kind: jobOptions?.kind ?? "bash",
			outputBytes: 0,
			outputLimitBytes,
			terminalReason: undefined,
			promptStalledAt: undefined,
			promptStallTail: undefined,
		},
	};
	bashBgJobs.set(id, job);
	bashBgWatchStates.set(id, {
		lastOutputBytes: 0,
		lastGrowthAt: job.startedAt,
		promptNotifiedForBytes: undefined,
	});
	evictTerminalBashBgJobs();
	startBashBgWatchdog();
	notifyBashBgJobsChanged();
	const sink = createBoundedBashBgOutputSink(job, outputFd);
	bindBashBgChildLifecycle(child, job, sink);
	// This diagnostic is output too. Routing it through the same sink preserves
	// the exact cap when a foreground process is adopted after timeout.
	sink.append(Buffer.from("[detached into background after foreground timeout \u2014 process still running]\n"));
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
				if (child.pid) killProcessTree(child.pid);
				else child.kill("SIGKILL");
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
): { text: string; shownLines: number; totalLines: number; lineCountExact: boolean; truncated: boolean } {
	let content = "";
	let complete = true;
	let startsMidLine = false;
	try {
		const size = statSync(job.logPath).size;
		const bytes = Math.min(size, BASH_BG_MAX_LOG_READ_BYTES);
		const position = opts.mode === "tail" ? Math.max(0, size - bytes) : 0;
		const buffer = Buffer.allocUnsafe(bytes);
		const fd = openSync(job.logPath, "r");
		try {
			readSync(fd, buffer, 0, bytes, position);
		} finally {
			closeSync(fd);
		}
		content = buffer.toString("utf8");
		complete = bytes === size;
		startsMidLine = position > 0;
	} catch {
		return { text: "", shownLines: 0, totalLines: 0, lineCountExact: true, truncated: false };
	}
	const all = content.split("\n");
	// The first tail fragment begins part-way through a line; never render it as
	// a fake line. A full read starts at byte zero and keeps it intact.
	if (startsMidLine && all.length > 0) all.shift();
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
		lineCountExact: complete,
		truncated: !complete || total > slice.length || truncation.truncated,
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
