/**
 * LocalAgentTask — Task adapter over `AgentRecentRun`.
 *
 * Maps the unified Task verbs onto pi's existing background-agent control
 * surface in `core/agents/status.ts`:
 *
 *   Task.kill            → cancelAgentRecentRun     (hard abort)
 *   Task.requestShutdown → interruptAgentRecentRun  (cooperative, resumable)
 *   Task.injectMessage   → injectAgentRecentRun     (running: deliver mid-loop
 *                                                    via controller.inject)
 *                       → resumeAgentRecentRun     (otherwise: prompt-resume)
 *
 * No behavior change to the underlying registry — this is a pure facade so the
 * TUI (Layer B) can talk to one interface regardless of task flavor.
 */

import type { AgentRecentRun } from "../agents/status.ts";
import {
	agentRunUiStatus,
	cancelAgentRecentRun,
	findAgentRecentRun,
	injectAgentRecentRun,
	interruptAgentRecentRun,
	resumeAgentRecentRun,
} from "../agents/status.ts";
import type { AgentRunDetails, AgentToolStatus } from "../agents/types.ts";
import type { Task, TaskControlResult, TaskOutputResult, TaskSnapshot, TaskStatus } from "./types.ts";

function mapStatus(status: AgentToolStatus): TaskStatus {
	switch (status) {
		case "running":
			return "running";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "interrupted":
			return "interrupted";
	}
}

function previewTask(task: string): string {
	return task.length > 60 ? `${task.slice(0, 59)}…` : task;
}

function describeRun(run: AgentRecentRun): string {
	const agents = run.agents.length > 0 ? run.agents.join(", ") : "agent";
	const first = run.tasks[0] ?? "";
	const preview = previewTask(first);
	return preview ? `${agents}: ${preview}` : agents;
}

function describeChildRun(detail: AgentRunDetails): string {
	const task = detail.description ?? previewTask(detail.task);
	return task || detail.agent;
}

function taskStatusFromRun(run: AgentRecentRun): TaskStatus {
	const status = agentRunUiStatus(run);
	return status === "idle" ? "idle" : mapStatus(status);
}

function needsInputFor(run: AgentRecentRun, status: TaskStatus): boolean {
	return run.needsAttention || status === "interrupted" || status === "failed";
}

function childSnapshotFromRun(run: AgentRecentRun, detail: AgentRunDetails, index: number): TaskSnapshot {
	const followsPersistentParent = run.persistent && run.runs.length === 1;
	const status = followsPersistentParent ? taskStatusFromRun(run) : mapStatus(detail.status);
	const startedAt = detail.startedAt ?? Date.parse(run.startedAt);
	return {
		id: `${run.id}:${index + 1}`,
		type: "local_agent",
		status,
		description: describeChildRun(detail),
		label: run.label ?? detail.agent,
		sessionPath: detail.sessionPath,
		needsInput: followsPersistentParent
			? needsInputFor(run, status)
			: status === "interrupted" || status === "failed",
		startedAt,
		endedAt:
			status === "running" || status === "idle" || status === "interrupted"
				? undefined
				: startedAt + detail.durationMs,
		resumable: Boolean(followsPersistentParent && run.resumable),
		error: detail.error,
		controlId: run.id,
	};
}

function snapshotFromRun(run: AgentRecentRun): TaskSnapshot {
	const status = taskStatusFromRun(run);
	return {
		id: run.id,
		type: "local_agent",
		status,
		description: describeRun(run),
		label: run.label,
		sessionPath: run.sessionRefs.length === 1 ? run.sessionRefs[0]?.sessionPath : undefined,
		needsInput: needsInputFor(run, status),
		startedAt: Date.parse(run.startedAt),
		endedAt: run.endedAt ? Date.parse(run.endedAt) : undefined,
		resumable: run.resumable,
		error: run.error,
		children: run.runs.map((detail, index) => childSnapshotFromRun(run, detail, index)),
	};
}

function lookup(taskId: string): TaskSnapshot | undefined {
	const run = findAgentRecentRun(taskId);
	return run ? snapshotFromRun(run) : undefined;
}

/** Best-available result text for one sub-run: final output, else raw, else recent snippets. */
function runOutputText(detail: AgentRunDetails): string {
	const body = detail.finalOutput ?? detail.rawOutput ?? detail.recentOutputSnippets.join("\n");
	return body.trim();
}

function renderRunOutput(run: AgentRecentRun): string {
	const header = `${run.id}: ${mapStatus(run.status)}${run.error ? ` (${run.error})` : ""}`;
	if (run.runs.length === 0) return `${header}\n\n(no output yet)`;
	const sections = run.runs.map((detail) => {
		const text = runOutputText(detail);
		const label = run.runs.length > 1 ? `── ${detail.agent} ──\n` : "";
		return `${label}${text || "(no output yet)"}`;
	});
	return `${header}\n\n${sections.join("\n\n")}`;
}

function toControlResult(taskId: string, ok: boolean, message: string): TaskControlResult {
	return { ok, message, snapshot: lookup(taskId) };
}

export const LocalAgentTask: Task = {
	type: "local_agent",

	snapshot(taskId) {
		return lookup(taskId);
	},

	async output(taskId, options): Promise<TaskOutputResult | undefined> {
		const run = findAgentRecentRun(taskId);
		if (!run) return undefined;
		const outputPath = run.outputPaths[0] ?? run.runs.find((detail) => detail.outputPath)?.outputPath;
		if (options?.maxLines !== undefined && options.maxLines <= 1) {
			const snapshot = snapshotFromRun(run);
			return { text: `${snapshot.id}: ${snapshot.status}`, fullOutputPath: outputPath, snapshot };
		}
		return { text: renderRunOutput(run), fullOutputPath: outputPath, snapshot: snapshotFromRun(run) };
	},

	async kill(taskId) {
		const result = await cancelAgentRecentRun(taskId);
		return toControlResult(taskId, result.ok, result.message);
	},

	async requestShutdown(taskId) {
		const result = await interruptAgentRecentRun(taskId);
		return toControlResult(taskId, result.ok, result.message);
	},

	async injectMessage(taskId, message) {
		const trimmed = message.trim();
		if (!trimmed) {
			return toControlResult(taskId, false, "Cannot inject an empty message");
		}
		const current = findAgentRecentRun(taskId);
		if (!current) return toControlResult(taskId, false, `Run not found: ${taskId}`);

		if (current.status === "running") {
			const injected = await injectAgentRecentRun(taskId, trimmed);
			return toControlResult(taskId, injected.ok, injected.message);
		}

		const resumed = await resumeAgentRecentRun(taskId, trimmed);
		return toControlResult(taskId, resumed.ok, resumed.message);
	},
};
