/**
 * Unified Task abstraction.
 *
 * Modeled on Claude Code's `Task` interface — a single capability surface over
 * every long-running thing the TUI may want to attach to, steer, or kill:
 * agent runs, bash backgrounds, monitors, intercom peers, etc.
 *
 * v1 only ships the `local_agent` adapter (a thin facade over `AgentRecentRun`
 * in `core/agents/status.ts`). Other task types are reserved for later layers.
 */

export type TaskType = "local_agent" | "local_bash" | "monitor" | "intercom_peer";

/**
 * Lifecycle states. Terminal: `completed | failed | cancelled | killed`.
 * `interrupted` is non-terminal — a soft-stopped task that may resume.
 * `idle` is a parked-but-alive task awaiting input (e.g. a persistent
 * single-background fork between turns) — distinct from `interrupted`,
 * which signals the task actually needs the user's attention.
 */
export type TaskStatus = "running" | "idle" | "interrupted" | "completed" | "failed" | "cancelled" | "killed";

export function isTerminalTaskStatus(status: TaskStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "killed";
}

export interface TaskSnapshot {
	id: string;
	type: TaskType;
	status: TaskStatus;
	description: string;
	startedAt: number;
	endedAt?: number;
	/** True when the underlying runtime supports resuming after interrupt. */
	resumable: boolean;
	/** Optional human-readable error message when status is failed/cancelled. */
	error?: string;
	/** Optional leaf tasks for aggregate/group tasks such as a parallel Agent call. */
	children?: TaskSnapshot[];
	/**
	 * Exact, caller-supplied display label (e.g. `ForkAgentOptions.description`
	 * for an extension-launched fork), preferred over `description`'s generic
	 * `agent: task preview` text wherever a compact, human-authored name is
	 * available. Undefined when the underlying run never set one.
	 */
	label?: string;
	/**
	 * Path to the underlying persisted child session, when the task has one
	 * (single-mode agent runs). Lets a UI reconnect/zoom into a parked task
	 * that has no live in-process controller left to attach to.
	 */
	sessionPath?: string;
	/**
	 * True when this task wants user attention right now: an ordinary (non-
	 * persistent-parked) interrupted run, a failed run, or a running run that
	 * flagged `needsAttention`. Persistent single-background forks parked at
	 * `status: "idle"` are NOT needs-input by default — they're waiting to be
	 * fed, not stuck. Drives the "needs input" footer/pane bucket, which wins
	 * over "working" whenever both are non-zero.
	 */
	needsInput?: boolean;
	/**
	 * Id to use for control-plane operations (kill/requestShutdown/injectMessage,
	 * and any other API that dispatches on a task id — including consumers that
	 * bypass the adapter and call an underlying registry like
	 * `findAgentRecentRun`/`getLiveSession`/`subscribeTaskMessages` directly)
	 * when it differs from `id`. Defaults to `id` when absent.
	 *
	 * Exists because a `children` entry's `id` (e.g. "agent-5:1") is a purely
	 * informational leaf label for an aggregate/group task such as a parallel
	 * Agent call — there is no independent adapter or live-session/message-buffer
	 * registration per child, only per top-level run. A caller that threads a
	 * child's `id` into a control/zoom operation gets a silent "not found"
	 * because nothing is ever registered under that exact string. `controlId`
	 * is the id that IS registered (the owning run/task's own `id`), so
	 * consumers building rows from flattened `children` can still resolve real
	 * control/zoom operations without reverse-engineering the leaf id format.
	 */
	controlId?: string;
}

export interface TaskControlResult {
	ok: boolean;
	message: string;
	snapshot?: TaskSnapshot;
}

/** Options for reading a task's accumulated output. */
export interface TaskOutputOptions {
	/** Which slice of a log-backed task (e.g. bash) to return. Default: tail. */
	mode?: "tail" | "head" | "all";
	/** Max lines to return for a log-backed task. */
	maxLines?: number;
}

/** A task's current output, rendered for the model. */
export interface TaskOutputResult {
	/** Human/model-readable output: status header + log for bash, final result for agents. */
	text: string;
	snapshot?: TaskSnapshot;
	/** Path to the full persisted output, when one exists (e.g. bash log file). */
	fullOutputPath?: string;
}

/**
 * Capability surface for a single task. Adapters wire each verb to whatever
 * underlying registry (agent runs, bash bg, etc.) actually owns the lifecycle.
 *
 * Capabilities are optional: e.g. a `monitor` task may expose `kill` but not
 * `injectMessage`. Callers must check for undefined before invoking.
 */
export interface Task {
	type: TaskType;
	snapshot(taskId: string): TaskSnapshot | undefined;
	/**
	 * Read the task's accumulated output. Each adapter renders its native shape:
	 * bash returns its status header + bounded log slice; an agent returns its
	 * final result text. Returns undefined when the id is unknown to the adapter.
	 */
	output?: (taskId: string, options?: TaskOutputOptions) => Promise<TaskOutputResult | undefined>;
	/** Hard stop. Aborts immediately, status → cancelled/killed. */
	kill?: (taskId: string) => Promise<TaskControlResult>;
	/** Cooperative stop. Status → interrupted, may be resumable. */
	requestShutdown?: (taskId: string) => Promise<TaskControlResult>;
	/**
	 * Clear a terminal task's attention state without deleting its session or
	 * output artifacts. Unsupported for tasks that still need lifecycle control.
	 */
	acknowledge?: (taskId: string) => Promise<TaskControlResult>;
	/**
	 * Steer the task with a user message.
	 *
	 * v1 `local_agent` implementation: interrupt → resume(message). This means
	 * the message lands at the next turn, not mid-LLM-call. Future layer C may
	 * promote this to true in-loop drain.
	 */
	injectMessage?: (taskId: string, message: string) => Promise<TaskControlResult>;
}

export type TaskListener = (taskId: string, snapshot: TaskSnapshot) => void;
