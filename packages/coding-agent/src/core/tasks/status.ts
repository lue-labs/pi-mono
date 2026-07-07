import { formatAgentDurationMs } from "../agents/status.ts";
import { listTasks } from "./registry.ts";
import type { TaskSnapshot, TaskStatus, TaskType } from "./types.ts";

function isObserverTask(task: TaskSnapshot): boolean {
	return task.type === "local_agent" && task.kind === "observer";
}

function taskTypeLabel(type: TaskType): string {
	if (type === "local_bash") return "bash";
	if (type === "local_agent") return "agent";
	if (type === "intercom_peer") return "intercom";
	return type;
}

function taskLabel(task: TaskSnapshot): string {
	return isObserverTask(task) ? "observer" : taskTypeLabel(task.type);
}

function taskTypeNoun(task: TaskSnapshot, count: number): string {
	const noun = task.type === "local_bash" ? "shell" : taskLabel(task);
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function observerStatusLabel(status: TaskStatus): string {
	return status === "running" || status === "interrupted" ? "armed" : status;
}

function taskStatusLabel(task: TaskSnapshot): string {
	return isObserverTask(task) ? observerStatusLabel(task.status) : task.status;
}

function isFooterRelevant(task: TaskSnapshot): boolean {
	return task.status === "running" || task.status === "interrupted" || task.status === "failed";
}

function isBackgroundFooterTask(task: TaskSnapshot): boolean {
	return isFooterRelevant(task) && !isObserverTask(task);
}

function countByStatus(tasks: TaskSnapshot[], status: TaskStatus): number {
	return tasks.filter((task) => task.status === status).length;
}

function countObserversByLabel(tasks: TaskSnapshot[], label: string): number {
	return tasks.filter((task) => observerStatusLabel(task.status) === label).length;
}

function formatCount(count: number, label: string): string | undefined {
	if (count === 0) return undefined;
	return `${count} ${label}`;
}

function formatTypeCounts(tasks: TaskSnapshot[]): string {
	const counts = new Map<string, { task: TaskSnapshot; count: number }>();
	for (const task of tasks) {
		const key = taskLabel(task);
		const entry = counts.get(key);
		if (entry) entry.count += 1;
		else counts.set(key, { task, count: 1 });
	}
	return [...counts.values()].map(({ task, count }) => taskTypeNoun(task, count)).join(", ");
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
	const relevant = tasks.filter(isBackgroundFooterTask).sort(byNewestStart);
	if (relevant.length === 0) return undefined;

	const statusParts = [
		formatCount(countByStatus(relevant, "running"), "running"),
		formatCount(countByStatus(relevant, "interrupted"), "interrupted"),
		formatCount(countByStatus(relevant, "failed"), "failed"),
	].filter((part): part is string => Boolean(part));
	const latest = relevant[0]!;
	const latestDescription = latest.description ? ` ${latest.description}` : "";
	return `Background: ${statusParts.join(", ")} · ${formatTypeCounts(relevant)} · ${latest.id} ${latest.status} ${taskLabel(latest)}${latestDescription} · enter details`;
}

export function formatObserverFooterStatus(tasks = listTasks()): string | undefined {
	const observers = tasks.filter((task) => isFooterRelevant(task) && isObserverTask(task)).sort(byNewestStart);
	if (observers.length === 0) return undefined;

	const statusParts = [
		formatCount(countObserversByLabel(observers, "armed"), "armed"),
		formatCount(countObserversByLabel(observers, "failed"), "failed"),
	].filter((part): part is string => Boolean(part));
	const latest = observers[0]!;
	const latestDescription = latest.description ? ` ${latest.description}` : "";
	return `Observer: ${statusParts.join(", ")} · ${latest.id} ${observerStatusLabel(latest.status)}${latestDescription} · enter details`;
}

export function formatTaskStatus(tasks = listTasks(), detailId?: string): string {
	const lines = [
		"Background task status",
		"",
		"Long-running runtime tasks: background agents, observer agents, and background bash jobs.",
	];
	const sorted = [...tasks].sort(byActiveThenNewest);
	if (sorted.length === 0) return [...lines, "", "No background runtime tasks."].join("\n");

	const detailTask = detailId ? sorted.find((task) => task.id === detailId) : undefined;
	if (detailId && !detailTask) return [...lines, "", `Task not found: ${detailId}`].join("\n");
	const tasksToRender = detailTask ? [detailTask] : sorted;

	lines.push("");
	for (const task of tasksToRender) {
		const type = taskLabel(task);
		const status = taskStatusLabel(task);
		const resumable = task.resumable ? " resumable" : "";
		const error = task.error ? ` error: ${task.error}` : "";
		lines.push(`${task.id} [${type}] ${status}${resumable} ${elapsed(task)} ${task.description}${error}`);
	}
	lines.push(
		"",
		"Details/output: TaskBackgroundList shows output paths; read logs with Read(offset/limit).",
		"Control: TaskStop { task_id } stops background agents or bash jobs.",
	);
	return lines.join("\n");
}
