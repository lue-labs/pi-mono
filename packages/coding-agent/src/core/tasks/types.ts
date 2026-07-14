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
export type TaskAttentionReason = "user_input" | "stale_progress" | "failure";

/**
 * Lifecycle states. Terminal: `completed | failed | cancelled | killed`.
 * `interrupted` is non-terminal — a soft-stopped task that may resume.
 * `idle` is a parked-but-alive task awaiting its next turn (e.g. a persistent
 * single-background fork between turns). `interrupted` is a soft-stopped
 * lifecycle state; attention remains orthogonal and requires a typed reason.
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
	/** True only when the worker explicitly requested a human response. */
	needsInput?: boolean;
	/** Orthogonal diagnostic/attention state; lifecycle status alone never implies this. */
	needsAttention?: boolean;
	attentionReason?: TaskAttentionReason;
	attentionMessage?: string;
	/**
	 * Id to use for control-plane operations (kill/requestShutdown/injectMessage,
	 * and any other API that dispatches on a task id — including consumers that
	 * bypass the adapter and call an underlying registry like
	 * `findAgentRecentRun`/`getLiveSession`/`subscribeTaskMessages` directly)
	 * when it differs from `id`. Defaults to `id` when absent.
	 *
	 * Aggregate rows use their own id. A child uses its stable member id only
	 * after the executor has registered a member-scoped controller or live
	 * session; otherwise it deliberately falls back to its aggregate id rather
	 * than exposing an unresolvable control target.
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
	 * `local_agent` steers a running member's live session directly. An interrupted
	 * durable single-member run resumes with the message as its next turn; targets
	 * without a supported live or resumable controller fail explicitly.
	 */
	injectMessage?: (taskId: string, message: string) => Promise<TaskControlResult>;
}

export type TaskListener = (taskId: string, snapshot: TaskSnapshot) => void;
