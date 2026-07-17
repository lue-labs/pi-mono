import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import { type AgentToolParentServices, executeAgentTool } from "../agents/executor.js";
import type { AgentExecutionProgress, AgentRunDetails, AgentToolDetails, AgentToolMode } from "../agents/types.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { ReadonlySessionManager } from "../session-manager.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const contextModeSchema = Type.Union([
	Type.Literal("default"),
	Type.Literal("fork"),
	Type.Literal("slim"),
	Type.Literal("none"),
]);

const thinkingSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);

const outputModeSchema = Type.Union([Type.Literal("inline"), Type.Literal("file"), Type.Literal("both")]);
const agentActionSchema = Type.Union(
	[Type.Literal("spawn"), Type.Literal("create"), Type.Literal("list"), Type.Literal("get"), Type.Literal("update")],
	{
		description:
			"Execution mode. Omit or use 'spawn' to launch child agents; use create/list/get/update for session-scoped task tracking.",
	},
);
const taskStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("deleted"),
]);

const taskSchema = Type.Object({
	agent: Type.String({ description: "Agent id/name to run" }),
	task: Type.String({ description: "Task for the child agent" }),
	description: Type.Optional(Type.String({ description: "Short UI label" })),
	context: Type.Optional(contextModeSchema),
	extraContext: Type.Optional(Type.String({ description: "Additional task-specific context" })),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String())),
	thinking: Type.Optional(thinkingSchema),
	output: Type.Optional(Type.String({ description: "Path for parent to save final child report" })),
	outputMode: Type.Optional(outputModeSchema),
});

export const agentToolSchema = Type.Object({
	action: Type.Optional(agentActionSchema),
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(taskSchema, { maxItems: 8 })),
	chain: Type.Optional(Type.Array(taskSchema, { minItems: 1 })),
	concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 8, default: 4 })),
	context: Type.Optional(contextModeSchema),
	extraContext: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String())),
	thinking: Type.Optional(thinkingSchema),
	output: Type.Optional(Type.String()),
	outputMode: Type.Optional(outputModeSchema),
	chainDir: Type.Optional(Type.String({ description: "Base directory for relative chain outputs" })),
	agentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
	subject: Type.Optional(Type.String({ description: "Brief task title for action=create/update" })),
	activeForm: Type.Optional(
		Type.String({ description: "Present-continuous task label when in_progress, e.g. 'Running tests'" }),
	),
	taskId: Type.Optional(Type.String({ description: "Task id for action=get/update" })),
	status: Type.Optional(taskStatusSchema),
	owner: Type.Optional(Type.String()),
	blocks: Type.Optional(Type.Array(Type.String())),
	blockedBy: Type.Optional(Type.Array(Type.String())),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type AgentToolInput = Static<typeof agentToolSchema>;

type StoredTaskStatus = "pending" | "in_progress" | "completed";
interface StoredTask {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	status: StoredTaskStatus;
	owner?: string;
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
}
interface AgentTaskEntryData {
	tasks: StoredTask[];
	nextId: number;
}

const AGENT_TASKS_CUSTOM_TYPE = "coding-agent.agent.tasks";
const memoryTaskStores = new WeakMap<ReadonlySessionManager, AgentTaskEntryData>();
const fallbackTaskStore: AgentTaskEntryData = { tasks: [], nextId: 1 };

export interface AgentToolOptions {
	parentServices?: AgentToolParentServices;
	getParentActiveTools?: () => string[];
	getParentSessionManager?: () => ReadonlySessionManager;
	getParentModel?: () => Model<Api> | undefined;
	getParentThinkingLevel?: () => ThinkingLevel;
}

export function normalizeAgentToolMode(params: AgentToolInput): {
	mode: AgentToolMode;
	tasks: NonNullable<AgentToolInput["tasks"]>;
} {
	if (params.action && params.action !== "spawn") {
		throw new Error("normalizeAgentToolMode only supports spawn mode");
	}
	const hasSingle = Boolean(params.agent && params.task);
	const hasParallel = Boolean(params.tasks && params.tasks.length > 0);
	const hasChain = Boolean(params.chain && params.chain.length > 0);
	const count = [hasSingle, hasParallel, hasChain].filter(Boolean).length;
	if (count !== 1) {
		throw new Error("agent tool requires exactly one mode: {agent, task}, {tasks}, or {chain}");
	}
	if (hasSingle) {
		return {
			mode: "single",
			tasks: [
				{
					agent: params.agent ?? "",
					task: params.task ?? "",
					description: params.description,
					context: params.context,
					extraContext: params.extraContext,
					model: params.model,
					tools: params.tools,
					thinking: params.thinking,
					output: params.output,
					outputMode: params.outputMode,
				},
			],
		};
	}
	if (hasParallel) return { mode: "parallel", tasks: params.tasks ?? [] };
	return { mode: "chain", tasks: params.chain ?? [] };
}

function cloneTaskStore(store: AgentTaskEntryData): AgentTaskEntryData {
	return {
		tasks: store.tasks.map((task) => ({ ...task, blocks: [...task.blocks], blockedBy: [...task.blockedBy] })),
		nextId: store.nextId,
	};
}

function getTaskStore(sessionManager?: ReadonlySessionManager): AgentTaskEntryData {
	if (!sessionManager) return fallbackTaskStore;
	const cached = memoryTaskStores.get(sessionManager);
	if (cached) return cached;
	let latest: AgentTaskEntryData | undefined;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== AGENT_TASKS_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<AgentTaskEntryData> | undefined;
		if (!data || !Array.isArray(data.tasks) || typeof data.nextId !== "number") continue;
		latest = {
			nextId: data.nextId,
			tasks: data.tasks.filter((task): task is StoredTask => Boolean(task?.id && task.subject && task.description)),
		};
	}
	const store = latest ? cloneTaskStore(latest) : { tasks: [], nextId: 1 };
	memoryTaskStores.set(sessionManager, store);
	return store;
}

function persistTaskStore(sessionManager: ReadonlySessionManager | undefined, store: AgentTaskEntryData): void {
	if (!sessionManager) return;
	const appendCustomEntry = (
		sessionManager as unknown as { appendCustomEntry?: (customType: string, data?: unknown) => string }
	).appendCustomEntry;
	appendCustomEntry?.call(sessionManager, AGENT_TASKS_CUSTOM_TYPE, cloneTaskStore(store));
}

function formatTask(task: StoredTask): string {
	const owner = task.owner ? ` (${task.owner})` : "";
	const blocked = task.blockedBy.length > 0 ? ` [blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}]` : "";
	return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`;
}

function executeTaskAction(params: AgentToolInput, sessionManager?: ReadonlySessionManager): string {
	const store = getTaskStore(sessionManager);
	const action = params.action;
	if (action === "list") return store.tasks.length === 0 ? "No tasks found" : store.tasks.map(formatTask).join("\n");
	if (action === "get") {
		const task = store.tasks.find((candidate) => candidate.id === params.taskId);
		return task ? JSON.stringify(task, null, 2) : `Task not found: ${params.taskId ?? "<missing>"}`;
	}
	if (action === "create") {
		if (!params.subject || !params.description)
			throw new Error("agent action=create requires subject and description");
		const task: StoredTask = {
			id: String(store.nextId++),
			subject: params.subject,
			description: params.description,
			activeForm: params.activeForm,
			status: "pending",
			owner: params.owner,
			blocks: params.blocks ?? [],
			blockedBy: params.blockedBy ?? [],
			metadata: params.metadata,
		};
		store.tasks.push(task);
		persistTaskStore(sessionManager, store);
		return `Task #${task.id} created successfully: ${task.subject}`;
	}
	if (action === "update") {
		const index = store.tasks.findIndex((candidate) => candidate.id === params.taskId);
		if (index === -1) return `Task not found: ${params.taskId ?? "<missing>"}`;
		if (params.status === "deleted") {
			const [deleted] = store.tasks.splice(index, 1);
			persistTaskStore(sessionManager, store);
			return `Task #${deleted.id} deleted: ${deleted.subject}`;
		}
		const task = store.tasks[index];
		if (params.subject !== undefined) task.subject = params.subject;
		if (params.description !== undefined) task.description = params.description;
		if (params.activeForm !== undefined) task.activeForm = params.activeForm;
		if (params.status !== undefined) task.status = params.status;
		if (params.owner !== undefined) task.owner = params.owner;
		if (params.blocks !== undefined) task.blocks = params.blocks;
		if (params.blockedBy !== undefined) task.blockedBy = params.blockedBy;
		if (params.metadata !== undefined) {
			task.metadata = { ...(task.metadata ?? {}) };
			for (const [key, value] of Object.entries(params.metadata)) {
				if (value === null) delete task.metadata[key];
				else task.metadata[key] = value;
			}
			if (Object.keys(task.metadata).length === 0) task.metadata = undefined;
		}
		persistTaskStore(sessionManager, store);
		return `Task #${task.id} updated: ${task.subject}`;
	}
	throw new Error(`unsupported agent task action: ${String(action)}`);
}

function summarizeRuns(runs: AgentRunDetails[]): string {
	return runs
		.map((run, index) => {
			const label = run.description ? `${run.agent} (${run.description})` : run.agent;
			const status = run.status === "completed" ? "completed" : run.status;
			const suffix = run.outputPath ? ` -> ${run.outputPath}` : "";
			const error = run.error ? ` (${run.error})` : "";
			return `${index + 1}. ${label}: ${status}${suffix}${error}`;
		})
		.join("\n");
}

function formatProgress(progress: AgentExecutionProgress): string {
	const completed = progress.runs.filter((run) => run.status === "completed").length;
	const running = progress.runs.filter((run) => run.status === "running").length;
	const failed = progress.runs.filter((run) => run.status === "failed").length;
	const lines = [
		`${progress.mode}: ${completed}/${progress.runs.length} done${running ? `, ${running} running` : ""}${failed ? `, ${failed} failed` : ""}`,
	];
	const summary = summarizeRuns(progress.runs);
	if (summary) lines.push(summary);
	return lines.join("\n");
}

function formatFinalResult(details: AgentToolDetails): string {
	const lines = [`agent ${details.mode}: ${details.status}`];
	const summary = summarizeRuns(details.runs);
	if (summary) lines.push(summary);
	const outputs = details.runs
		.filter(
			(run) =>
				run.finalOutput && (!run.outputPath || run.finalOutput !== `Saved child agent output to ${run.outputPath}`),
		)
		.map((run) => `\n### ${run.agent}\n\n${run.finalOutput}`);
	if (outputs.length > 0) lines.push(outputs.join("\n"));
	return lines.join("\n");
}

async function confirmProjectAgentsIfNeeded(
	params: AgentToolInput,
	ctx: Parameters<ToolDefinition<typeof agentToolSchema>["execute"]>[4],
): Promise<void> {
	const scope = params.agentScope;
	if (scope !== "project" && scope !== "both") return;
	if (!ctx.hasUI) {
		throw new Error("Project agents require interactive confirmation in this runtime.");
	}
	const confirmed = await ctx.ui.confirm(
		"Run project agents?",
		"Project-local .pi/agents prompts are controlled by this repository and may instruct child agents to use active tools.",
	);
	if (!confirmed) {
		throw new Error("Project agent execution cancelled");
	}
}

export function createAgentToolDefinition(
	_cwd: string,
	options?: AgentToolOptions,
): ToolDefinition<typeof agentToolSchema, AgentToolDetails> {
	return {
		name: "agent",
		label: "agent",
		description:
			"Launch a built-in or configured Pi child agent, or manage session-scoped tasks with action=create/list/get/update. Spawn mode supports single {agent, task}, parallel {tasks}, and sequential chain {chain}.",
		promptSnippet: "Delegate work to child agents or manage session-scoped tasks",
		promptGuidelines: [
			"Use agent for delegated work that benefits from an isolated child context.",
			"Use action=create/list/get/update for complex multi-step work, explicit todo requests, plan tracking, and new instructions that should not be dropped.",
			"For task actions: mark tasks in_progress before starting, mark completed only after the work is fully done and verified, and leave blocked/partial work unfinished.",
			"When parallel exploration or review is needed, send multiple agent tool-use blocks in one assistant message; Pi runs those calls concurrently. Use tasks[] only for explicit batched fan-out inside one agent call.",
			"Do not use agent recursively; child agents cannot call agent.",
		],
		parameters: agentToolSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.action && params.action !== "spawn") {
				const text = executeTaskAction(params, options?.getParentSessionManager?.());
				return { content: [{ type: "text", text }] };
			}
			if (!options?.parentServices || !options.getParentActiveTools || !options.getParentSessionManager) {
				throw new Error("agent tool is unavailable in this runtime");
			}
			await confirmProjectAgentsIfNeeded(params, ctx);
			const mode = normalizeAgentToolMode(params);
			const details = await executeAgentTool(
				{
					mode: mode.mode,
					tasks: mode.tasks,
					concurrency: params.concurrency,
					context: params.context,
					extraContext: params.extraContext,
					model: params.model,
					tools: params.tools,
					thinking: params.thinking,
					output: params.output,
					outputMode: params.outputMode,
					chainDir: params.chainDir,
					agentScope: params.agentScope,
				},
				{
					parentServices: options.parentServices,
					parentActiveTools: options.getParentActiveTools(),
					parentSessionManager: options.getParentSessionManager(),
					parentModel: options.getParentModel?.(),
					parentThinkingLevel: options.getParentThinkingLevel?.() ?? "off",
					signal,
					onProgress: (progress) => {
						onUpdate?.({ content: [{ type: "text", text: formatProgress(progress) }], details: progress });
					},
				},
			);
			return { content: [{ type: "text", text: formatFinalResult(details) }], details };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let label = "agent";
			try {
				if (args.action && args.action !== "spawn") {
					label = `task ${args.action}${args.taskId ? ` #${args.taskId}` : ""}`;
				} else {
					const mode = normalizeAgentToolMode(args);
					const names = mode.tasks.map((task) => task.agent).join(", ");
					label = `${mode.mode}: ${names}`;
				}
			} catch {
				label = "agent: invalid mode";
			}
			text.setText(`${theme.fg("toolTitle", theme.bold("agent"))} ${theme.fg("accent", label)}`);
			return text;
		},
		renderResult(result, options, _theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			const text = result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			component.addChild(new Spacer(1));
			if (options.expanded) {
				component.addChild(new Text(text, 0, 0));
			} else {
				component.addChild(new Text(text.split("\n").slice(0, 8).join("\n"), 0, 0));
			}
			return component;
		},
	};
}

export function createAgentTool(cwd: string, options?: AgentToolOptions): AgentTool<typeof agentToolSchema> {
	return wrapToolDefinition(createAgentToolDefinition(cwd, options));
}

export type { AgentToolDetails };
