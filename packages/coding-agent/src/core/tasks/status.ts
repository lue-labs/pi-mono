import { formatAgentDurationMs } from "../agents/status.ts";
import { listTasks } from "./registry.ts";
import type { TaskSnapshot, TaskStatus, TaskType } from "./types.ts";

function taskTypeLabel(type: TaskType): string {
	if (type === "local_bash") return "bash";
	if (type === "local_agent") return "agent";
	if (type === "intercom_peer") return "intercom";
	return type;
}

function taskTypeNoun(type: TaskType, count: number): string {
	const noun = type === "local_bash" ? "shell" : type === "local_agent" ? "agent" : taskTypeLabel(type);
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isFooterRelevant(task: TaskSnapshot): boolean {
	return task.status === "running" || task.status === "interrupted" || task.status === "failed";
}

function countByStatus(tasks: TaskSnapshot[], status: TaskStatus): number {
	return tasks.filter((task) => task.status === status).length;
}

function formatCount(count: number, label: string): string | undefined {
	if (count === 0) return undefined;
	return `${count} ${label}`;
}

function formatTypeCounts(tasks: TaskSnapshot[]): string {
	const counts = new Map<TaskType, number>();
	for (const task of tasks) counts.set(task.type, (counts.get(task.type) ?? 0) + 1);
	return [...counts.entries()].map(([type, count]) => taskTypeNoun(type, count)).join(", ");
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

export function formatTaskFooterStatus(tasks = listTasks()): string | undefined {
	const relevant = tasks.filter(isFooterRelevant).sort(byNewestStart);
	if (relevant.length === 0) return undefined;

	const statusParts = [
		formatCount(countByStatus(relevant, "running"), "running"),
		formatCount(countByStatus(relevant, "interrupted"), "interrupted"),
		formatCount(countByStatus(relevant, "failed"), "failed"),
	].filter((part): part is string => Boolean(part));
	const latest = relevant[0]!;
	const latestDescription = latest.description ? ` ${latest.description}` : "";
	return `Background: ${statusParts.join(", ")} · ${formatTypeCounts(relevant)} · ${latest.id} ${latest.status} ${taskTypeLabel(latest.type)}${latestDescription} · enter details`;
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
		lines.push(`${task.id} [${type}] ${task.status}${resumable} ${elapsed(task)} ${task.description}${error}`);
	}
	lines.push(
		"",
		"Details/output: TaskBackgroundList shows output paths; read logs with Read(offset/limit).",
		"Control: TaskStop { task_id } stops background agents or bash jobs.",
	);
	return lines.join("\n");
}
