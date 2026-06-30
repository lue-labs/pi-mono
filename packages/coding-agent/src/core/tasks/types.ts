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
 * `idle` is reserved for future use (in-process teammates awaiting input).
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
	 * Steer the task with a user message.
	 *
	 * v1 `local_agent` implementation: interrupt → resume(message). This means
	 * the message lands at the next turn, not mid-LLM-call. Future layer C may
	 * promote this to true in-loop drain.
	 */
	injectMessage?: (taskId: string, message: string) => Promise<TaskControlResult>;
}

export type TaskListener = (taskId: string, snapshot: TaskSnapshot) => void;
