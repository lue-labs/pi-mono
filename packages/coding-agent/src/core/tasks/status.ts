import { formatAgentDurationMs } from "../agents/status.ts";
import { listTasks } from "./registry.ts";
import type { TaskSnapshot, TaskType } from "./types.ts";

function taskTypeLabel(type: TaskType): string {
	if (type === "local_bash") return "bash";
	if (type === "local_agent") return "agent";
	if (type === "intercom_peer") return "intercom";
	return type;
}

export function taskNeedsInput(task: TaskSnapshot): boolean {
	// Needs-input is an explicit claim by the task provider (e.g. a bash job
	// stalled on an interactive prompt). Never derived from status: terminal or
	// interrupted tasks are settled state, not a user wait.
	return task.needsInput === true;
}

export function taskIsWorking(task: TaskSnapshot): boolean {
	return task.status === "running" || task.status === "idle";
}

function isFooterRelevant(task: TaskSnapshot): boolean {
	return taskNeedsInput(task) || taskIsWorking(task);
}

function elapsed(task: TaskSnapshot): string {
	return formatAgentDurationMs(Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt));
}

function byNewestStart(a: TaskSnapshot, b: TaskSnapshot): number {
	return b.startedAt - a.startedAt;
}

function byActiveThenNewest(a: TaskSnapshot, b: TaskSnapshot): number {
	const activeDelta = Number(isFooterRelevant(b)) - Number(isFooterRelevant(a));
	return activeDelta || byNewestStart(a, b);
}

const AGENTS_FOOTER_HINT = "← for agents";

/** Compact semantic footer text; internal ids, types, and descriptions stay in the pane. */
export function formatTaskFooterStatus(tasks = listTasks()): string {
	const needsInputCount = tasks.filter(taskNeedsInput).length;
	if (needsInputCount > 0) return `${needsInputCount} needs input · ${AGENTS_FOOTER_HINT}`;
	const workingCount = tasks.filter((task) => task.status === "running").length;
	if (workingCount > 0) return `${workingCount} working · ${AGENTS_FOOTER_HINT}`;
	return AGENTS_FOOTER_HINT;
}

export function formatTaskStatus(tasks = listTasks(), detailId?: string): string {
	const lines = [
		"Background task status",
		"",
		"Long-running runtime tasks: background agents and background bash jobs.",
	];
	const sorted = [...tasks].sort(byActiveThenNewest);
	if (sorted.length === 0) return [...lines, "", "No background runtime tasks."].join("\n");

	const detailTask = detailId ? sorted.find((task) => task.id === detailId) : undefined;
	if (detailId && !detailTask) return [...lines, "", `Task not found: ${detailId}`].join("\n");
	const tasksToRender = detailTask ? [detailTask] : sorted;

	lines.push("");
	for (const task of tasksToRender) {
		const type = taskTypeLabel(task.type);
		const resumable = task.resumable ? " resumable" : "";
		const error = task.error ? ` error: ${task.error}` : "";
		const lifecycle = task.lifecycle?.promptStalled
			? " waiting for prompt"
			: task.lifecycle?.terminalReason
				? ` reason: ${task.lifecycle.terminalReason}`
				: "";
		lines.push(
			`${task.id} [${type}] ${task.status}${resumable} ${elapsed(task)} ${task.description}${lifecycle}${error}`,
		);
	}
	lines.push(
		"",
		"Details/output: TaskBackgroundList shows output paths; read logs with Read(offset/limit).",
		"Control: TaskStop { task_id } stops background agents or bash jobs.",
	);
	return lines.join("\n");
}
