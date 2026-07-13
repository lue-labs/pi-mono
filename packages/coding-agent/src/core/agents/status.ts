import { existsSync } from "node:fs";
import type {
	AgentAttentionReason,
	AgentExecutionProgress,
	AgentRunDetails,
	AgentToolDetails,
	AgentToolMode,
	AgentToolStatus,
} from "./types.ts";

export type AgentRunExecution = "foreground" | "background";

export interface AgentRecentRun {
	id: string;
	/** Delegation depth that initiated this run: 0 = top-level, >0 = nested sub-agent. */
	depth: number;
	/** Run id that spawned the session which started this run (tree linkage). */
	parentRunId?: string;
	mode: AgentToolMode;
	execution: AgentRunExecution;
	status: AgentToolStatus;
	agents: string[];
	tasks: string[];
	startedAt: string;
	updatedAt: string;
	endedAt?: string;
	durationMs?: number;
	outputPaths: string[];
	sessionRefs: Array<{ agent: string; sessionId?: string; sessionPath?: string }>;
	runs: AgentRunDetails[];
	resumable: boolean;
	needsAttention: boolean;
	attentionReason?: AgentAttentionReason;
	attentionMessage?: string;
	/** True after the operator dismisses a terminal failure from attention UI. */
	acknowledged?: boolean;
	error?: string;
	/**
	 * True for a `mode:"single"` background run kept alive across turns
	 * (`AgentToolExecutionInput.persistent` / `ForkAgentOptions.persistent`).
	 * Persistent runs may intentionally park between turns; `parked` distinguishes
	 * that state from a real interruption of the same long-lived run.
	 */
	persistent?: boolean;
	/**
	 * True only while a persistent run is intentionally parked after completing
	 * a turn. Both parked runs and real interruptions use storage status
	 * `interrupted`; this bit keeps their UI/eviction semantics distinct.
	 */
	parked?: boolean;
	/**
	 * Exact, caller-supplied UI label — sourced from `ForkAgentOptions.description`
	 * (threaded via `AgentTaskConfig.description`) for extension-launched forks.
	 * Preferred over the generic `agent: task preview` text wherever a compact,
	 * human-authored name is available. Undefined for runs that never set one.
	 */
	label?: string;
}

/**
 * UI-facing status for a run: identical to `run.status` except a run explicitly
 * parked at "interrupted" reads as "idle" instead — it's waiting to be fed its
 * next turn, not stuck needing the user. Real interruptions remain visible. Every
 * surface that renders `run.status` as user-visible text (footer, agents
 * pane, `/agents runs` rows/detail) should go through this instead of
 * reading `run.status` directly.
 */
export function agentRunUiStatus(run: Pick<AgentRecentRun, "status" | "parked">): AgentToolStatus | "idle" {
	return run.parked && run.status === "interrupted" ? "idle" : run.status;
}

export interface AgentRecentRunController {
	interrupt?: () => void | Promise<void>;
	cancel?: () => void | Promise<void>;
	resume?: (prompt?: string) => void | Promise<void>;
	inject?: (message: string) => void | Promise<void>;
}

export interface AgentRunControlResult {
	ok: boolean;
	message: string;
	run?: AgentRecentRun;
}

export type AgentRecentRunsListener = () => void;
export type AgentRecentRunTerminalListener = (run: AgentRecentRun) => void;

const MAX_RECENT_RUNS = 25;
const recentRuns: AgentRecentRun[] = [];
const liveRunControllers = new Map<string, AgentRecentRunController>();
const recentRunListeners = new Set<AgentRecentRunsListener>();
const terminalListeners = new Map<string, AgentRecentRunTerminalListener>();
// Atomic dedup per run generation. Survives status thrash between lifecycle
// paths in one turn while allowing a persistent run to notify again after
// restartAgentRecentRun() advances it to the next turn.
const terminalNotifiedGeneration = new WeakMap<AgentRecentRun, number>();
const runGenerations = new WeakMap<AgentRecentRun, number>();
let nextRunId = 1;

function nowIso(): string {
	return new Date().toISOString();
}

function pruneAgentRecentRuns(): void {
	while (recentRuns.length > MAX_RECENT_RUNS) {
		let evictIndex = -1;
		for (let index = recentRuns.length - 1; index >= 0; index--) {
			const candidate = recentRuns[index];
			if (candidate && candidate.status !== "running" && !candidate.parked) {
				evictIndex = index;
				break;
			}
		}
		if (evictIndex === -1) break;
		recentRuns.splice(evictIndex, 1);
	}
}

function notifyAgentRecentRunsChanged(): void {
	for (const listener of recentRunListeners) {
		try {
			listener();
		} catch {
			// Status listeners are UI refresh hooks; never let one break lifecycle updates.
		}
	}
	// The registry may temporarily exceed the history bound while every row is
	// live (running or a parked persistent helper). Notify synchronous waiters of
	// the terminal transition before pruning its row; scheduled UI renders then
	// read the already-pruned registry.
	pruneAgentRecentRuns();
}

export function subscribeAgentRecentRuns(listener: AgentRecentRunsListener): () => void {
	recentRunListeners.add(listener);
	return () => recentRunListeners.delete(listener);
}

function cloneRunDetails(run: AgentRunDetails): AgentRunDetails {
	return {
		...run,
		effectiveTools: [...run.effectiveTools],
		deniedTools: [...run.deniedTools],
		recentToolCalls: run.recentToolCalls.map((tool) => ({ ...tool })),
		recentOutputSnippets: [...run.recentOutputSnippets],
		loadedSkills: [...run.loadedSkills],
		invokedSkills: { count: run.invokedSkills.count, names: [...run.invokedSkills.names] },
	};
}

function cloneRecentRun(run: AgentRecentRun): AgentRecentRun {
	return {
		...run,
		agents: [...run.agents],
		tasks: [...run.tasks],
		outputPaths: [...run.outputPaths],
		sessionRefs: run.sessionRefs.map((session) => ({ ...session })),
		runs: run.runs.map(cloneRunDetails),
	};
}

function summarizeErrors(runs: AgentRunDetails[]): string | undefined {
	const errors = runs.map((run) => run.error).filter((error): error is string => Boolean(error));
	return errors.length > 0 ? errors.join("; ") : undefined;
}

function summarizeOutputs(runs: AgentRunDetails[]): string[] {
	return runs.map((run) => run.outputPath).filter((path): path is string => Boolean(path));
}

function summarizeSessions(runs: AgentRunDetails[]): AgentRecentRun["sessionRefs"] {
	return runs.map((run) => ({ agent: run.agent, sessionId: run.sessionId, sessionPath: run.sessionPath }));
}

function isTerminalStatus(status: AgentToolStatus): boolean {
	return status !== "running";
}

// Fire the terminal listener at most once per run generation. Caller must have
// already driven `run.status` to a terminal value; we read it for the snapshot.
function maybeFireTerminal(run: AgentRecentRun): void {
	if (!isTerminalStatus(run.status)) return;
	const listener = terminalListeners.get(run.id);
	// Do not mark a generation notified until a listener actually observes it;
	// late registration must still close the transition-vs-registration race.
	if (!listener) return;
	const generation = getRunGeneration(run);
	const keepForNextGeneration = run.parked || run.resumable;
	if (terminalNotifiedGeneration.get(run) === generation) {
		if (!keepForNextGeneration && terminalListeners.get(run.id) === listener) terminalListeners.delete(run.id);
		return;
	}
	terminalNotifiedGeneration.set(run, generation);
	if (!keepForNextGeneration && terminalListeners.get(run.id) === listener) terminalListeners.delete(run.id);
	try {
		listener(cloneRecentRun(run));
	} catch {
		// Terminal listeners are side-effecting (e.g. inject custom message).
		// Never let one break the lifecycle.
	}
}

function getRunGeneration(run: AgentRecentRun): number {
	return runGenerations.get(run) ?? 0;
}

function isExpectedGeneration(run: AgentRecentRun, expectedGeneration?: number): boolean {
	return expectedGeneration === undefined || getRunGeneration(run) === expectedGeneration;
}

export function getAgentRecentRunGeneration(run: AgentRecentRun): number {
	return getRunGeneration(run);
}

function canResumeRun(run: AgentRecentRun): boolean {
	if (run.mode !== "single" || run.execution !== "background" || run.status !== "interrupted") return false;
	if (run.sessionRefs.length !== 1) return false;
	const sessionPath = run.sessionRefs[0]?.sessionPath;
	return Boolean(sessionPath && existsSync(sessionPath));
}

function refreshRunSummary(run: AgentRecentRun, runs: AgentRunDetails[]): void {
	run.outputPaths = summarizeOutputs(runs);
	run.sessionRefs = summarizeSessions(runs);
	run.runs = runs.map(cloneRunDetails);
	run.error = summarizeErrors(runs);
	run.resumable = canResumeRun(run);
}

function updateRunTimestamps(run: AgentRecentRun, terminal: boolean): void {
	run.updatedAt = nowIso();
	if (!terminal) return;
	run.endedAt = run.updatedAt;
	run.durationMs = Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
}

// Tracks the last user-visible content signature notified per run so that
// no-op progress ticks (e.g. a heartbeat where only updatedAt moved) can skip
// the render-triggering notify. Keyed by run identity — WeakMap avoids a
// manual cleanup path when a run is evicted from recentRuns.
const runContentSignatures = new WeakMap<AgentRecentRun, string>();

function computeRunContentSignature(run: AgentRecentRun): string {
	return JSON.stringify({
		status: run.status,
		execution: run.execution,
		error: run.error,
		needsAttention: run.needsAttention,
		attentionReason: run.attentionReason,
		attentionMessage: run.attentionMessage,
		acknowledged: run.acknowledged,
		resumable: run.resumable,
		parked: run.parked,
		outputPaths: run.outputPaths,
		sessionRefs: run.sessionRefs,
		runs: run.runs.map((r) => ({
			status: r.status,
			effectiveTools: r.effectiveTools,
			deniedTools: r.deniedTools,
			recentToolCalls: r.recentToolCalls,
			recentOutputSnippets: r.recentOutputSnippets,
			loadedSkills: r.loadedSkills,
			invokedSkills: r.invokedSkills,
		})),
	});
}

function applyRunDetails(
	run: AgentRecentRun,
	details: AgentToolDetails | AgentExecutionProgress,
	terminal = isTerminalStatus(details.status),
	expectedGeneration?: number,
	guardUnchanged = false,
): void {
	if (!isExpectedGeneration(run, expectedGeneration)) return;
	run.status = details.status;
	run.parked = details.status === "interrupted" && details.parked === true;
	updateRunTimestamps(run, terminal);
	refreshRunSummary(run, details.runs);
	if (run.status !== "interrupted") run.resumable = false;
	if (run.status === "running") {
		run.needsAttention = false;
		run.attentionReason = undefined;
		run.attentionMessage = undefined;
	} else if (run.status === "failed") {
		run.needsAttention = !run.acknowledged;
		run.attentionReason = run.acknowledged ? undefined : "failure";
		run.attentionMessage = run.acknowledged ? undefined : run.error;
	} else if (run.status === "completed" || run.status === "cancelled") {
		run.needsAttention = false;
		run.attentionReason = undefined;
		run.attentionMessage = undefined;
	}
	if (run.status === "completed" || run.status === "cancelled" || run.status === "failed") {
		liveRunControllers.delete(run.id);
	}
	if (guardUnchanged) {
		const nextSignature = computeRunContentSignature(run);
		const unchanged = runContentSignatures.get(run) === nextSignature;
		runContentSignatures.set(run, nextSignature);
		if (unchanged) {
			maybeFireTerminal(run);
			return;
		}
	} else {
		runContentSignatures.set(run, computeRunContentSignature(run));
	}
	notifyAgentRecentRunsChanged();
	maybeFireTerminal(run);
}

function markRunStopped(run: AgentRecentRun, status: "interrupted" | "cancelled", message?: string): void {
	const stoppedAt = Date.now();
	run.status = status;
	run.parked = false;
	updateRunTimestamps(run, true);
	run.needsAttention = false;
	run.attentionReason = undefined;
	run.attentionMessage = undefined;
	run.runs = run.runs.map((child) => {
		if (child.status !== "running" && !(status === "cancelled" && child.status === "interrupted")) return child;
		const durationMs = child.startedAt ? Math.max(child.durationMs, stoppedAt - child.startedAt) : child.durationMs;
		return { ...child, status, durationMs };
	});
	refreshRunSummary(run, run.runs);
	if (message) run.error = message;
	run.resumable = canResumeRun(run);
	if (status === "cancelled") {
		run.resumable = false;
		liveRunControllers.delete(run.id);
	}
	notifyAgentRecentRunsChanged();
	maybeFireTerminal(run);
}

function findMutableRun(runId: string): AgentRecentRun | undefined {
	return recentRuns.find((run) => run.id === runId);
}

export function startAgentRecentRun(
	mode: AgentToolMode,
	tasks: Array<{ agent: string; task: string }>,
	options?: {
		background?: boolean;
		depth?: number;
		parentRunId?: string;
		/** See `AgentRecentRun.persistent`. Default false. */
		persistent?: boolean;
		/** See `AgentRecentRun.label`. */
		label?: string;
	},
): AgentRecentRun {
	const timestamp = nowIso();
	const run: AgentRecentRun = {
		id: `agent-${nextRunId++}`,
		depth: options?.depth ?? 0,
		parentRunId: options?.parentRunId,
		mode,
		execution: options?.background ? "background" : "foreground",
		status: "running",
		agents: tasks.map((task) => task.agent),
		tasks: tasks.map((task) => task.task),
		startedAt: timestamp,
		updatedAt: timestamp,
		outputPaths: [],
		sessionRefs: [],
		runs: [],
		resumable: false,
		needsAttention: false,
		acknowledged: false,
		persistent: options?.persistent ?? false,
		parked: false,
		label: options?.label,
	};
	runGenerations.set(run, 0);
	recentRuns.unshift(run);
	notifyAgentRecentRunsChanged();
	return run;
}

export function updateAgentRecentRunProgress(
	run: AgentRecentRun,
	details: AgentExecutionProgress,
	expectedGeneration?: number,
): void {
	// Progress ticks fire far more often than terminal transitions (finish/fail);
	// guard against re-rendering when nothing user-visible actually changed;
	// previously every agent progress tick triggered a global requestRender().
	applyRunDetails(run, details, details.status !== "running", expectedGeneration, /* guardUnchanged */ true);
}

export function markAgentRecentRunBackgrounded(run: AgentRecentRun): void {
	if (run.execution === "background") return;
	run.execution = "background";
	run.updatedAt = nowIso();
	run.resumable = canResumeRun(run);
	runContentSignatures.set(run, computeRunContentSignature(run));
	notifyAgentRecentRunsChanged();
}

export function finishAgentRecentRun(
	run: AgentRecentRun,
	details: AgentToolDetails,
	expectedGeneration?: number,
): void {
	applyRunDetails(run, details, true, expectedGeneration);
}

export function failAgentRecentRun(run: AgentRecentRun, error: unknown, expectedGeneration?: number): void {
	if (!isExpectedGeneration(run, expectedGeneration)) return;
	run.status = "failed";
	run.parked = false;
	updateRunTimestamps(run, true);
	run.error = error instanceof Error ? error.message : String(error);
	run.resumable = false;
	run.needsAttention = true;
	run.attentionReason = "failure";
	run.attentionMessage = run.error;
	liveRunControllers.delete(run.id);
	notifyAgentRecentRunsChanged();
	maybeFireTerminal(run);
}

export function attachAgentRecentRunController(runId: string, controller: AgentRecentRunController): void {
	liveRunControllers.set(runId, controller);
}

export function detachAgentRecentRunController(runId: string): void {
	liveRunControllers.delete(runId);
}

/**
 * Register a lifecycle callback that fires when this run reaches a terminal
 * status (completed | failed | cancelled | interrupted). Atomic dedup: fires
 * at most once per run generation even if multiple paths drive that turn
 * terminal in the same tick, then re-arms when a run is resumed.
 *
 * Used by the background-agent path to push a structured task_notification
 * back to the parent session without polling.
 */
export function attachAgentRecentRunTerminalListener(
	runId: string,
	listener: AgentRecentRunTerminalListener,
): () => void {
	terminalListeners.set(runId, listener);
	// If the run already terminated before registration (race), fire immediately.
	const existing = findMutableRun(runId);
	if (existing && isTerminalStatus(existing.status)) maybeFireTerminal(existing);
	return () => {
		if (terminalListeners.get(runId) === listener) terminalListeners.delete(runId);
	};
}

export function restartAgentRecentRun(run: AgentRecentRun): void {
	runGenerations.set(run, getRunGeneration(run) + 1);
	run.status = "running";
	run.parked = false;
	run.updatedAt = nowIso();
	run.endedAt = undefined;
	run.durationMs = undefined;
	run.error = undefined;
	run.resumable = false;
	run.needsAttention = false;
	run.attentionReason = undefined;
	run.attentionMessage = undefined;
	run.acknowledged = false;
	run.runs = run.runs.map((child) => (child.status === "interrupted" ? { ...child, status: "running" } : child));
	notifyAgentRecentRunsChanged();
}

export async function interruptAgentRecentRun(runId: string): Promise<AgentRunControlResult> {
	const run = findMutableRun(runId);
	if (!run) return { ok: false, message: `Run not found: ${runId}` };
	if (run.status === "interrupted")
		return { ok: true, message: `${runId} is already interrupted`, run: cloneRecentRun(run) };
	if (run.status !== "running")
		return { ok: false, message: `${runId} is not running (status: ${run.status})`, run: cloneRecentRun(run) };
	const controller = liveRunControllers.get(runId);
	if (!controller?.interrupt) return { ok: false, message: `${runId} is not interruptible`, run: cloneRecentRun(run) };
	await controller.interrupt();
	if (run.status === "running") markRunStopped(run, "interrupted", "Interrupted by operator");
	return { ok: true, message: `Interrupted ${runId}`, run: cloneRecentRun(run) };
}

export async function cancelAgentRecentRun(runId: string): Promise<AgentRunControlResult> {
	const run = findMutableRun(runId);
	if (!run) return { ok: false, message: `Run not found: ${runId}` };
	if (run.status !== "running" && run.status !== "interrupted") {
		return { ok: false, message: `${runId} is not cancellable (status: ${run.status})`, run: cloneRecentRun(run) };
	}
	const controller = liveRunControllers.get(runId);
	if (!controller?.cancel) return { ok: false, message: `${runId} is not cancellable`, run: cloneRecentRun(run) };
	await controller.cancel();
	markRunStopped(run, "cancelled", "Cancelled by operator");
	return { ok: true, message: `Cancelled ${runId}`, run: cloneRecentRun(run) };
}

export function acknowledgeAgentRecentRun(runId: string): AgentRunControlResult {
	const run = findMutableRun(runId);
	if (!run) return { ok: false, message: `Run not found: ${runId}` };
	if (run.status !== "failed") {
		return {
			ok: false,
			message: `${runId} is not a failed terminal run (status: ${run.status})`,
			run: cloneRecentRun(run),
		};
	}
	if (run.acknowledged) return { ok: true, message: `${runId} is already dismissed`, run: cloneRecentRun(run) };

	// Deliberately only UI/session bookkeeping: preserve the run record and all
	// session/output references so its diagnostics remain inspectable.
	run.acknowledged = true;
	run.needsAttention = false;
	run.attentionReason = undefined;
	run.attentionMessage = undefined;
	run.updatedAt = nowIso();
	notifyAgentRecentRunsChanged();
	return { ok: true, message: `Dismissed ${runId}`, run: cloneRecentRun(run) };
}

export async function resumeAgentRecentRun(runId: string, prompt?: string): Promise<AgentRunControlResult> {
	const run = findMutableRun(runId);
	if (!run) return { ok: false, message: `Run not found: ${runId}` };
	if (run.status === "running") return { ok: false, message: `${runId} is already running`, run: cloneRecentRun(run) };
	if (!run.resumable) return { ok: false, message: `${runId} is not resumable`, run: cloneRecentRun(run) };
	const controller = liveRunControllers.get(runId);
	if (!controller?.resume)
		return { ok: false, message: `${runId} cannot resume in this process`, run: cloneRecentRun(run) };
	await controller.resume(prompt);
	return { ok: true, message: `Resumed ${runId}`, run: cloneRecentRun(run) };
}

export async function injectAgentRecentRun(runId: string, message: string): Promise<AgentRunControlResult> {
	const run = findMutableRun(runId);
	if (!run) return { ok: false, message: `Run not found: ${runId}` };
	if (run.status !== "running")
		return { ok: false, message: `${runId} is not running (status: ${run.status})`, run: cloneRecentRun(run) };
	const controller = liveRunControllers.get(runId);
	if (!controller?.inject) return { ok: false, message: `${runId} is not injectable`, run: cloneRecentRun(run) };
	await controller.inject(message);
	return { ok: true, message: `Queued message for ${runId}`, run: cloneRecentRun(run) };
}

export function listAgentRecentRuns(): AgentRecentRun[] {
	return recentRuns.map(cloneRecentRun);
}

/** Return a cloned snapshot of the recent run with the given id, or undefined. */
export function findAgentRecentRun(runId: string): AgentRecentRun | undefined {
	const run = findMutableRun(runId);
	return run ? cloneRecentRun(run) : undefined;
}

/**
 * Resolve once the recent run reaches a terminal status (anything other than
 * "running"). Rejects if the run id is unknown or evicted before terminating.
 */
export function waitForAgentRecentRun(runId: string): Promise<AgentRecentRun> {
	return new Promise((resolve, reject) => {
		let unsubscribe: (() => void) | undefined;
		const check = () => {
			const run = findMutableRun(runId);
			if (!run) {
				unsubscribe?.();
				reject(new Error(`Run not found or evicted: ${runId}`));
				return;
			}
			if (isTerminalStatus(run.status)) {
				unsubscribe?.();
				resolve(cloneRecentRun(run));
			}
		};
		unsubscribe = subscribeAgentRecentRuns(check);
		check();
	});
}

export function markAgentRecentRunNeedsAttention(
	run: AgentRecentRun,
	message: string,
	reason: AgentAttentionReason = "stale_progress",
): void {
	if (reason === "stale_progress" && run.status !== "running") return;
	if (reason === "failure" && run.status !== "failed") return;
	if (reason === "user_input" && run.status !== "running" && run.status !== "interrupted") return;
	if (run.needsAttention && run.attentionReason === reason && run.attentionMessage === message) return;
	run.needsAttention = true;
	run.attentionReason = reason;
	run.attentionMessage = message;
	run.updatedAt = nowIso();
	notifyAgentRecentRunsChanged();
}

export function clearAgentRecentRunsForTests(): void {
	recentRuns.length = 0;
	liveRunControllers.clear();
	recentRunListeners.clear();
	nextRunId = 1;
}

export function formatAgentTokenCount(count: number): string {
	if (count < 1000) return String(count);
	return `${Math.floor(count / 1000)}k`;
}

export function formatAgentDurationMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatUsage(run: AgentRunDetails): string | undefined {
	if (!run.usage) return undefined;
	const cache =
		run.usage.cacheRead || run.usage.cacheWrite
			? ` cache r/w ${formatAgentTokenCount(run.usage.cacheRead)}/${formatAgentTokenCount(run.usage.cacheWrite)}`
			: "";
	const cost = run.usage.cost.total > 0 ? ` $${run.usage.cost.total.toFixed(4)}` : "";
	return `${formatAgentTokenCount(run.usage.totalTokens)} tok${cache}${cost}`;
}

export function formatAgentRunModel(run: AgentRunDetails): string | undefined {
	if (!run.model && !run.thinking) return undefined;
	const model = run.model ? `${run.model.provider}/${run.model.id}` : "unknown-model";
	return `${model}${run.thinking ? ` · thinking ${run.thinking}` : ""}`;
}

function formatRunDetail(run: AgentRunDetails, index: number): string[] {
	const model = formatAgentRunModel(run);
	const lines = [`${index + 1}. ${run.agent} ${run.status} ${formatChildDuration(run)}${model ? ` · ${model}` : ""}`];
	lines.push(`   session: ${run.sessionPath ?? run.sessionId ?? "n/a"}`);
	lines.push(`   tools: ${run.toolCallCount}${run.currentToolName ? ` current ${run.currentToolName}` : ""}`);
	if (run.recentToolCalls.length > 0) {
		lines.push("   recent tools:");
		for (const tool of run.recentToolCalls.slice(-8)) {
			lines.push(
				`   - ${tool.name}${tool.argsPreview ? ` ${tool.argsPreview}` : ""}${tool.isError ? " (error)" : ""}`,
			);
			// Show the tool's result, not just its name (CC 2.1.178: subagent
			// transcript shows tool results). resultPreview is already captured per call.
			if (tool.resultPreview) lines.push(`     → ${tool.resultPreview}`);
		}
	}
	if (run.invokedSkills.count > 0)
		lines.push(`   invoked skills: ${run.invokedSkills.names.join(", ")} (${run.invokedSkills.count})`);
	if (run.loadedSkills.length > 0) lines.push(`   loaded skills: ${run.loadedSkills.join(", ")}`);
	const usage = formatUsage(run);
	if (usage) lines.push(`   usage: ${usage}`);
	if (run.outputPath) lines.push(`   output: ${run.outputPath}`);
	if (run.error) lines.push(`   error: ${run.error}`);
	return lines;
}

function formatDuration(run: AgentRecentRun): string {
	if (run.durationMs !== undefined) return formatAgentDurationMs(run.durationMs);
	// Running runs have no final durationMs yet; show live elapsed so the pane
	// ticks a seconds counter (the status column already prints "running").
	if (run.status === "running") return formatAgentDurationMs(Math.max(0, Date.now() - Date.parse(run.startedAt)));
	return "running";
}

function formatChildDuration(run: AgentRunDetails): string {
	return run.durationMs !== undefined ? formatAgentDurationMs(run.durationMs) : "running";
}

function countRunsByUiStatus(runs: AgentRecentRun[], status: AgentToolStatus | "idle"): number {
	return runs.filter((run) => agentRunUiStatus(run) === status).length;
}

function formatCount(count: number, label: string): string | undefined {
	if (count === 0) return undefined;
	return `${count} ${label}`;
}

export function formatAgentFooterStatus(runs = listAgentRecentRuns()): string | undefined {
	const backgroundRuns = runs.filter(
		(run) =>
			run.execution === "background" &&
			(run.status === "running" || run.status === "interrupted" || run.status === "failed" || run.needsAttention),
	);
	if (backgroundRuns.length === 0) return undefined;
	const statusParts = [
		formatCount(countRunsByUiStatus(backgroundRuns, "running"), "running"),
		formatCount(countRunsByUiStatus(backgroundRuns, "idle"), "idle"),
		formatCount(countRunsByUiStatus(backgroundRuns, "interrupted"), "interrupted"),
		formatCount(backgroundRuns.filter((run) => run.resumable).length, "resumable"),
		formatCount(countRunsByUiStatus(backgroundRuns, "failed"), "failed"),
	].filter((part): part is string => Boolean(part));
	const latest = backgroundRuns[0];
	const latestAgents = latest.agents.length > 0 ? ` ${latest.agents.join(",")}` : "";
	const latestModels = Array.from(
		new Set(latest.runs.map(formatAgentRunModel).filter((model): model is string => Boolean(model))),
	);
	const latestModelLabel = latestModels.length > 0 ? ` · ${latestModels.join(",")}` : "";
	const attention = backgroundRuns.some((run) => run.needsAttention) ? " · needs attention" : "";
	const latestLabel = `${latest.id} ${agentRunUiStatus(latest)}${latest.resumable ? " resumable" : ""}${latest.needsAttention ? " needs attention" : ""}${latestAgents}${latestModelLabel}`;
	return `Agents: ${statusParts.join(", ")}${attention} · ${latestLabel} · /agents runs`;
}

export function formatAgentStatus(runs = listAgentRecentRuns(), detailId?: string): string {
	const lines = [
		"Native agent status",
		"",
		"Background control: native background runs support status, interrupt, cancel, and single-run resume.",
	];
	if (runs.length === 0) return [...lines, "", "No recent native agent runs."].join("\n");
	const detailRun = detailId ? runs.find((run) => run.id === detailId) : undefined;
	if (detailId && !detailRun) return [...lines, "", `Run not found: ${detailId}`].join("\n");
	if (detailRun) {
		lines.push(
			"",
			`${detailRun.id} ${detailRun.mode} ${detailRun.execution} ${agentRunUiStatus(detailRun)} ${formatDuration(detailRun)}`,
			`started: ${detailRun.startedAt}`,
			`updated: ${detailRun.updatedAt}`,
		);
		if (detailRun.depth > 0)
			lines.push(
				`nested: depth ${detailRun.depth}${detailRun.parentRunId ? ` (parent ${detailRun.parentRunId})` : ""}`,
			);
		if (detailRun.resumable) lines.push(`resumable: yes (/agents resume ${detailRun.id} [-- prompt])`);
		if (detailRun.needsAttention) lines.push(`needs attention: ${detailRun.attentionMessage ?? "check run"}`);
		if (detailRun.error) lines.push(`error: ${detailRun.error}`);
		if (detailRun.runs.length === 0) lines.push("No child run details recorded yet.");
		for (const [index, run] of detailRun.runs.entries()) lines.push(...formatRunDetail(run, index));
		return lines.join("\n");
	}
	lines.push("");
	for (const run of runs) {
		const outputs = run.outputPaths.length > 0 ? ` outputs: ${run.outputPaths.join(", ")}` : "";
		const sessions =
			run.sessionRefs.length > 0
				? ` sessions: ${run.sessionRefs
						.map((s) => s.sessionId ?? s.sessionPath)
						.filter(Boolean)
						.join(", ")}`
				: "";
		const error = run.error ? ` error: ${run.error}` : "";
		const resumable = run.resumable ? " resumable" : "";
		const attention = run.needsAttention
			? ` needs-attention${run.attentionMessage ? `: ${run.attentionMessage}` : ""}`
			: "";
		// Nesting marker (depth > 0 = a sub-agent's own delegation) and fan-out
		// progress (done/total across child runs, CC 2.1.161) make nested and
		// parallel work visible at a glance in the agents view.
		const nesting = run.depth > 0 ? ` ↳L${run.depth}` : "";
		const doneCount = run.runs.filter((child) => child.status !== "running").length;
		// Denominator is the requested task count, not observed child details: queued
		// children (parallel beyond the concurrency limit, or later chain steps) have no
		// `runs[]` entry yet, so `runs.length` would understate the total and mislead.
		const fanout = run.tasks.length > 1 ? ` [${doneCount}/${run.tasks.length} done]` : "";
		const activeModels = Array.from(
			new Set(run.runs.map(formatAgentRunModel).filter((model): model is string => Boolean(model))),
		);
		const models = activeModels.length > 0 ? ` models: ${activeModels.join(", ")}` : "";
		lines.push(
			`${run.id} ${run.mode} ${run.execution} ${agentRunUiStatus(run)}${nesting}${resumable}${attention} ${formatDuration(run)} agents: ${run.agents.join(", ")}${fanout}${models}${sessions}${outputs}${error}`,
		);
	}
	lines.push(
		"",
		"Detail: /agents-status <run-id> or /agents status <run-id>",
		"Control: /agents interrupt <run-id>, /agents cancel <run-id>, /agents resume <run-id> [-- prompt]",
	);
	return lines.join("\n");
}
