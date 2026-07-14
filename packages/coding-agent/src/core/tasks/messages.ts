/**
 * Per-task live event ring buffer.
 *
 * The executor sinks normalized events from `session.subscribe()` here. Agent
 * events are keyed by stable member id and mirrored to the aggregate
 * `AgentRecentRun.id` for backwards-compatible whole-run subscriptions. UI
 * consumers can subscribe to render a live transcript for a running child.
 *
 * Bounded: oldest events are evicted past MAX_EVENTS_PER_TASK to keep memory
 * predictable when a child runs for a long time. Full transcript remains on
 * disk in the child session jsonl — this is a tail buffer, not storage.
 */

const MAX_EVENTS_PER_TASK = 200;

export type TaskMessageEvent =
	| { kind: "assistant_text"; ts: number; text: string }
	| { kind: "assistant_end"; ts: number }
	| { kind: "tool_start"; ts: number; toolName: string; argsPreview?: string }
	| { kind: "tool_end"; ts: number; toolName: string; isError?: boolean; resultPreview?: string }
	| { kind: "user_injected"; ts: number; text: string };

export type TaskMessageListener = (event: TaskMessageEvent) => void;

interface TaskMessageState {
	events: TaskMessageEvent[];
	listeners: Set<TaskMessageListener>;
}

const buffers = new Map<string, TaskMessageState>();

function getOrCreate(taskId: string): TaskMessageState {
	let state = buffers.get(taskId);
	if (!state) {
		state = { events: [], listeners: new Set() };
		buffers.set(taskId, state);
	}
	return state;
}

/** Append one event; evicts oldest past cap; notifies subscribers. */
export function appendTaskMessage(taskId: string, event: TaskMessageEvent): void {
	const state = getOrCreate(taskId);
	state.events.push(event);
	if (state.events.length > MAX_EVENTS_PER_TASK) {
		state.events.splice(0, state.events.length - MAX_EVENTS_PER_TASK);
	}
	for (const listener of state.listeners) {
		try {
			listener(event);
		} catch {
			// Listeners are UI hooks; never let one break the sink.
		}
	}
}

/** Snapshot of the buffered events for a task. Returns a copy. */
export function getTaskMessages(taskId: string): TaskMessageEvent[] {
	const state = buffers.get(taskId);
	return state ? [...state.events] : [];
}

/** Subscribe to future events for a task. Returns an unsubscribe function. */
export function subscribeTaskMessages(taskId: string, listener: TaskMessageListener): () => void {
	const state = getOrCreate(taskId);
	state.listeners.add(listener);
	return () => {
		state.listeners.delete(listener);
		// Drop the buffer entirely once nobody is listening AND the task is gone.
		// Cheap heuristic: if listeners empty and no events ever appended, drop now.
		if (state.listeners.size === 0 && state.events.length === 0) buffers.delete(taskId);
	};
}

/** Free a task's buffer entirely. Called when a task reaches terminal status. */
export function evictTaskMessages(taskId: string): void {
	buffers.delete(taskId);
}

/** For tests: wipe everything. */
export function clearTaskMessagesForTests(): void {
	buffers.clear();
}

export { MAX_EVENTS_PER_TASK };
