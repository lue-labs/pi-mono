/**
 * Unified background runtime controls.
 *
 * One id space over every long-running thing (background bash jobs + background
 * agent runs), dispatched through the `core/tasks` registry seam:
 *
 *   TaskStop(task_id)         → stop any runtime task
 *   TaskBackgroundList()      → list every background/runtime task
 *
 * Output is push-notified on completion and persisted to output files where
 * available. Model-facing readback happens with Read(path, offset, limit), not
 * a polling/pull tool.
 */

import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { findTaskAdapter, listTasks } from "../tasks/index.ts";
import type { TaskSnapshot } from "../tasks/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const taskStopSchema = Type.Object({
	task_id: Type.Optional(
		Type.String({ description: "Task id to stop (bash background job or background agent run)." }),
	),
	shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead." })),
});

export type TaskStopToolInput = Static<typeof taskStopSchema>;

const taskBackgroundListSchema = Type.Object({});

export type TaskBackgroundListToolInput = Static<typeof taskBackgroundListSchema>;

export function createTaskStopToolDefinition(): ToolDefinition<typeof taskStopSchema, TaskSnapshot | undefined> {
	return {
		name: "TaskStop",
		label: "TaskStop",
		description:
			"Stop a background task by task_id — a background bash job (SIGTERM to the process tree) or a background agent run (hard cancel). Idempotent: stopping an already-finished task is safe and just reports its state.",
		promptSnippet: "Stop a background task by task_id",
		parameters: taskStopSchema,
		async execute(_id, { task_id, shell_id }) {
			const id = task_id ?? shell_id;
			if (!id) {
				return { content: [{ type: "text", text: "TaskStop requires task_id." }], details: undefined };
			}
			const adapter = findTaskAdapter(id);
			if (!adapter?.kill) {
				return {
					content: [{ type: "text", text: `No stoppable background task with task_id=${id}.` }],
					details: undefined,
				};
			}
			const result = await adapter.kill(id);
			return { content: [{ type: "text", text: result.message }], details: result.snapshot };
		},
	};
}

export function createTaskStopTool() {
	return wrapToolDefinition(createTaskStopToolDefinition());
}

async function taskOutputPath(task: TaskSnapshot): Promise<string | undefined> {
	const adapter = findTaskAdapter(task.id);
	if (!adapter?.output) return undefined;
	try {
		const output = await adapter.output(task.id, { mode: "tail", maxLines: 1 });
		return output?.fullOutputPath;
	} catch {
		return undefined;
	}
}

function isBackgroundRuntimeTask(task: TaskSnapshot): boolean {
	return task.type !== "local_agent" || task.execution === "background";
}

async function renderTaskRow(task: TaskSnapshot): Promise<string> {
	const elapsed = ((task.endedAt ?? Date.now()) - task.startedAt) / 1000;
	const flavor = task.type === "local_bash" ? "bash" : task.type === "local_agent" ? "agent" : task.type;
	const outputPath = await taskOutputPath(task);
	const output = outputPath ? `  output=${outputPath}` : "";
	return `${task.id}  [${flavor}]  ${task.status}  ${elapsed.toFixed(1)}s  ${task.description}${output}`;
}

export function createTaskBackgroundListToolDefinition(): ToolDefinition<
	typeof taskBackgroundListSchema,
	TaskSnapshot[]
> {
	return {
		name: "TaskBackgroundList",
		label: "TaskBackgroundList",
		description:
			"List every background runtime task (background bash jobs and background agent runs) with id, kind, status, elapsed time, description, and output file path when available. Use output paths with Read(offset/limit) for logs/results and TaskStop for cancellation. This is separate from TaskList, which lists durable planning tasks.",
		promptSnippet: "List all background runtime tasks",
		parameters: taskBackgroundListSchema,
		async execute() {
			const tasks = listTasks()
				.filter(isBackgroundRuntimeTask)
				.sort((a, b) => a.startedAt - b.startedAt);
			if (tasks.length === 0) {
				return { content: [{ type: "text", text: "No background tasks." }], details: [] };
			}
			const lines = (await Promise.all(tasks.map(renderTaskRow))).join("\n");
			return { content: [{ type: "text", text: `${tasks.length} background task(s):\n${lines}` }], details: tasks };
		},
	};
}

export function createTaskBackgroundListTool() {
	return wrapToolDefinition(createTaskBackgroundListToolDefinition());
}
