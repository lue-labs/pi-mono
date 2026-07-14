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
	acknowledgeAgentRecentRun,
	agentRunUiStatus,
	cancelAgentRecentRun,
	canResumeAgentRecentRunMember,
	findAgentRecentRun,
	findAgentRecentRunMember,
	injectAgentRecentRun,
	interruptAgentRecentRun,
	resumeAgentRecentRun,
} from "../agents/status.ts";
import type { AgentAttentionReason, AgentRunDetails, AgentToolStatus } from "../agents/types.ts";
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

function attentionFor(
	run: AgentRecentRun,
	detail: AgentRunDetails | undefined,
	status: TaskStatus,
	followsPersistentParent: boolean,
): { reason?: AgentAttentionReason; message?: string } {
	if (run.acknowledged) return {};
	if (followsPersistentParent && run.attentionReason) {
		return { reason: run.attentionReason, message: run.attentionMessage };
	}
	if (detail?.attentionReason) return { reason: detail.attentionReason, message: detail.attentionMessage };
	return status === "failed" ? { reason: "failure", message: detail?.error ?? run.error } : {};
}

function childSnapshotFromRun(run: AgentRecentRun, detail: AgentRunDetails, index: number): TaskSnapshot {
	const followsPersistentParent = run.persistent === true && run.runs.length === 1;
	const status = followsPersistentParent ? taskStatusFromRun(run) : mapStatus(detail.status);
	const startedAt = detail.startedAt ?? Date.parse(run.startedAt);
	const attention = attentionFor(run, detail, status, followsPersistentParent);
	return {
		id: detail.memberId ?? `${run.id}:${index + 1}`,
		type: "local_agent",
		status,
		description: describeChildRun(detail),
		label: run.label ?? detail.agent,
		sessionPath: detail.sessionPath,
		needsInput: attention.reason === "user_input",
		needsAttention: attention.reason !== undefined,
		attentionReason: attention.reason,
		attentionMessage: attention.message,
		startedAt,
		endedAt: status === "running" || status === "idle" ? undefined : startedAt + detail.durationMs,
		resumable: Boolean(
			(detail.memberId && canResumeAgentRecentRunMember(detail.memberId)) ||
				(followsPersistentParent && run.resumable),
		),
		error: detail.error,
		controlId: detail.memberId ?? run.id,
	};
}

function snapshotFromRun(run: AgentRecentRun): TaskSnapshot {
	const status = taskStatusFromRun(run);
	const attention = attentionFor(run, undefined, status, true);
	return {
		id: run.id,
		type: "local_agent",
		status,
		description: describeRun(run),
		label: run.label,
		sessionPath: run.sessionRefs.length === 1 ? run.sessionRefs[0]?.sessionPath : undefined,
		needsInput: attention.reason === "user_input",
		needsAttention: attention.reason !== undefined,
		attentionReason: attention.reason,
		attentionMessage: attention.message,
		startedAt: Date.parse(run.startedAt),
		endedAt: run.endedAt ? Date.parse(run.endedAt) : undefined,
		resumable: run.resumable,
		error: run.error,
		children: run.runs.map((detail, index) => childSnapshotFromRun(run, detail, index)),
	};
}

function lookup(taskId: string): TaskSnapshot | undefined {
	const run = findAgentRecentRun(taskId);
	if (run) return snapshotFromRun(run);
	const member = findAgentRecentRunMember(taskId);
	if (!member) return undefined;
	const index = member.run.runs.findIndex((detail) => detail.memberId === taskId);
	return childSnapshotFromRun(member.run, member.detail, index);
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
		if (run) {
			const outputPath = run.outputPaths[0] ?? run.runs.find((detail) => detail.outputPath)?.outputPath;
			if (options?.maxLines !== undefined && options.maxLines <= 1) {
				const snapshot = snapshotFromRun(run);
				return { text: `${snapshot.id}: ${snapshot.status}`, fullOutputPath: outputPath, snapshot };
			}
			return { text: renderRunOutput(run), fullOutputPath: outputPath, snapshot: snapshotFromRun(run) };
		}

		const member = findAgentRecentRunMember(taskId);
		if (!member) return undefined;
		const snapshot = lookup(taskId)!;
		const outputPath = member.detail.outputPath;
		if (options?.maxLines !== undefined && options.maxLines <= 1) {
			return { text: `${snapshot.id}: ${snapshot.status}`, fullOutputPath: outputPath, snapshot };
		}
		const text = runOutputText(member.detail);
		const header = `${snapshot.id}: ${snapshot.status}${member.detail.error ? ` (${member.detail.error})` : ""}`;
		return { text: `${header}\n\n${text || "(no output yet)"}`, fullOutputPath: outputPath, snapshot };
	},

	async kill(taskId) {
		const result = await cancelAgentRecentRun(taskId);
		return toControlResult(taskId, result.ok, result.message);
	},

	async requestShutdown(taskId) {
		const result = await interruptAgentRecentRun(taskId);
		return toControlResult(taskId, result.ok, result.message);
	},

	async acknowledge(taskId) {
		const result = acknowledgeAgentRecentRun(taskId);
		return toControlResult(taskId, result.ok, result.message);
	},

	async injectMessage(taskId, message) {
		const trimmed = message.trim();
		if (!trimmed) {
			return toControlResult(taskId, false, "Cannot inject an empty message");
		}
		const current = findAgentRecentRun(taskId);
		const member = current ? undefined : findAgentRecentRunMember(taskId);
		if (!current && !member) return toControlResult(taskId, false, `Run not found: ${taskId}`);

		if ((current?.status ?? member?.detail.status) === "running") {
			const injected = await injectAgentRecentRun(taskId, trimmed);
			return toControlResult(taskId, injected.ok, injected.message);
		}

		const resumed = await resumeAgentRecentRun(taskId, trimmed);
		return toControlResult(taskId, resumed.ok, resumed.message);
	},
};
