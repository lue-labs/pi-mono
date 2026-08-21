import type { AgentTool, AgentToolResult, ThinkingLevel } from "@valkyriweb/pi-agent-core";
import { type Api, type Model, StringEnum } from "@valkyriweb/pi-ai";
import { Container, Spacer, Text } from "@valkyriweb/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { type AgentEngine, getContextAgentEngine } from "../agents/engine.ts";
import { type AgentToolParentServices, executeAgentTool } from "../agents/executor.ts";
import {
	cancelAgentRecentRun,
	findAgentRecentRun,
	formatAgentDurationMs,
	formatAgentStatus,
	formatAgentTokenCount,
	injectAgentRecentRun,
	interruptAgentRecentRun,
	resumeAgentRecentRun,
	subscribeAgentRecentRuns,
} from "../agents/status.ts";
import type {
	AgentBackgroundCompletion,
	AgentExecutionProgress,
	AgentRunDetails,
	AgentTaskConfig,
	AgentToolDetails,
	AgentToolMode,
} from "../agents/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const contextModeSchema = StringEnum(["default", "fork", "slim", "none"] as const, {
	description:
		'"default" starts a fresh named Agent with its profile tools; "fork" is a permissive self-fork that preserves the caller transcript, system prompt, and tools.',
});

const thinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const);

const outputModeSchema = StringEnum(["inline", "file", "both"] as const);
const controlActionSchema = StringEnum(["status", "detail", "interrupt", "cancel", "resume", "inject"] as const);

// Bare variant of the enum schemas used inside array-item copies: same const set (identical
// validation), no `description` payload. Keeps tasks[]/chain[] items byte-light while the
// single-mode top-level fields (below) keep full descriptions for solo callers.
const bareContextModeSchema = StringEnum(["default", "fork", "slim", "none"] as const);

// Bare variant of taskSchema for tasks[].items / chain[].items: strips every field description
// (advisory-only, never validated) while keeping identical field names, types, and optionality.
// See ~/Projects/personal/my-pi/docs/base-context-overhaul/agent-schema-dedupe.md Option D.
const bareTaskSchema = Type.Object({
	subagent_type: Type.Optional(Type.String()),
	agent: Type.Optional(Type.String()),
	prompt: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	context: Type.Optional(bareContextModeSchema),
	extraContext: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String())),
	thinking: Type.Optional(thinkingSchema),
	maxOutputTokens: Type.Optional(Type.Number({ minimum: 1 })),
	output: Type.Optional(Type.String()),
	outputMode: Type.Optional(outputModeSchema),
	cwd: Type.Optional(Type.String()),
});

export const agentToolSchema = Type.Object({
	action: Type.Optional(controlActionSchema),
	runId: Type.Optional(Type.String({ description: "Background run id for control actions" })),
	message: Type.Optional(
		Type.String({ description: "Optional resume/continue prompt for control actions; required for inject" }),
	),
	subagent_type: Type.Optional(
		Type.String({ description: "Agent id/name to run (preferred; Claude Code-compatible)" }),
	),
	agent: Type.Optional(Type.String({ description: "Legacy alias for subagent_type" })),
	prompt: Type.Optional(Type.String({ description: "Task for the selected Agent profile (preferred)" })),
	task: Type.Optional(Type.String({ description: "Legacy alias for prompt" })),
	description: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(bareTaskSchema, { maxItems: 8 })),
	chain: Type.Optional(Type.Array(bareTaskSchema, { minItems: 1 })),
	concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 8, default: 4 })),
	context: Type.Optional(contextModeSchema),
	extraContext: Type.Optional(
		Type.String({
			description:
				"Additional task-specific context. For explore, prefer a short context packet here instead of inheriting the calling session's transcript/project context.",
		}),
	),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool names available to this Agent task" })),
	thinking: Type.Optional(thinkingSchema),
	maxOutputTokens: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Cap this Agent run's provider output token limit. Can only lower the model's own cap.",
		}),
	),
	output: Type.Optional(Type.String()),
	outputMode: Type.Optional(outputModeSchema),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for this Agent task (single mode). Relative tool paths resolve against it. Defaults to the calling session's cwd. Use an absolute path for a different repo/directory.",
		}),
	),
	chainDir: Type.Optional(Type.String({ description: "Base directory for relative chain outputs" })),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run in the background and return immediately with a run id. Defaults to false (synchronous) — set true for long-running work you don't need the result from immediately.",
		}),
	),
	run_in_background: Type.Optional(Type.Boolean({ description: "Claude Code-compatible alias for background" })),
	agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const)),
});

export type AgentToolInput = Static<typeof agentToolSchema>;

export interface AgentToolOptions {
	toolName?: "agent" | "Agent" | "Task";
	label?: string;
	description?: string;
	engine?: AgentEngine;
	getEngine?: () => AgentEngine | undefined;
	parentServices?: AgentToolParentServices;
	getParentActiveTools?: () => string[];
	getParentSessionManager?: () => ReadonlySessionManager;
	getParentModel?: () => Model<Api> | undefined;
	getParentThinkingLevel?: () => ThinkingLevel;
	/**
	 * Returns the parent's frozen turn-start system prompt.
	 * Captured at tool execute() time (after before_agent_start has set it for the turn).
	 * Injected into context:"fork" children so their API requests share the parent's
	 * cached prefix (system + tools + messages must all be byte-identical for a hit).
	 */
	getParentSystemPrompt?: () => string;
	/**
	 * Fired exactly once when a background run reaches terminal status or a
	 * persistent run intentionally parks. Parent sessions wire this to inject a
	 * structured `agent_completion` message instead of polling.
	 */
	onBackgroundTerminal?: (notification: AgentBackgroundCompletion) => void;
}

function countExecutionModes(params: AgentToolInput): number {
	return [
		Boolean(params.agent && params.task),
		Boolean(params.tasks && params.tasks.length > 0),
		Boolean(params.chain && params.chain.length > 0),
	].filter(Boolean).length;
}

type AgentToolParams = AgentToolInput & Record<string, unknown>;
type AgentTaskParams = NonNullable<AgentToolInput["tasks"]>[number] & Record<string, unknown>;
type NormalizedAgentTaskParams = AgentTaskParams & AgentTaskConfig;

const unsupportedFutureFields = ["worktree", "remote", "team_name", "name", "mode"] as const;
// Process-local provenance for trusted extensions; Symbol properties do not survive
// ordinary serialized tool-call metadata and are not a security boundary.
const AUTOMATIC_WORKTREE_CWD = Symbol.for("pi.worktree.autoCwd");

function rejectUnsupportedFutureFields(params: Record<string, unknown>): void {
	for (const field of unsupportedFutureFields) {
		if (field in params) {
			throw new Error(`agent tool field ${field} is not supported yet`);
		}
	}
}

function resolveStringAlias(
	params: Record<string, unknown>,
	primaryName: string,
	aliasName: string,
): string | undefined {
	const primary = params[primaryName];
	const alias = params[aliasName];
	if (typeof primary === "string" && typeof alias === "string" && primary !== alias) {
		throw new Error(`Conflicting agent tool aliases: ${primaryName} and ${aliasName} differ`);
	}
	return typeof primary === "string" ? primary : typeof alias === "string" ? alias : undefined;
}

function resolveBooleanAlias(
	params: Record<string, unknown>,
	primaryName: string,
	aliasName: string,
): boolean | undefined {
	const primary = params[primaryName];
	const alias = params[aliasName];
	if (typeof primary === "boolean" && typeof alias === "boolean" && primary !== alias) {
		throw new Error(`Conflicting agent tool aliases: ${primaryName} and ${aliasName} differ`);
	}
	return typeof primary === "boolean" ? primary : typeof alias === "boolean" ? alias : undefined;
}

function normalizeAgentTaskAliases(task: AgentTaskParams, field: "tasks" | "chain"): NormalizedAgentTaskParams {
	rejectUnsupportedFutureFields(task);
	const agent = resolveStringAlias(task, "agent", "subagent_type") ?? task.agent;
	const childTask = resolveStringAlias(task, "task", "prompt") ?? task.task;
	if (!agent || !childTask) {
		throw new Error(
			`agent tool ${field} entries require subagent_type and prompt (legacy agent and task are still accepted)`,
		);
	}
	return {
		...task,
		agent,
		task: childTask,
	};
}

/**
 * Coerce a `tasks`/`chain` value that some providers serialize as a JSON
 * string into the array shape declared by the schema. Schema validation
 * isn't always enforced by the provider before the tool runs, so without
 * this guard a stringified array crashes `.map` deep inside normalization
 * with the unhelpful `tasks?.map is not a function`. A single object is
 * also wrapped — same providers occasionally drop the outer array entirely.
 */
function coerceTaskList(value: unknown, field: "tasks" | "chain"): NonNullable<AgentToolInput["tasks"]> | undefined {
	if (value === undefined || value === null) return undefined;
	let candidate: unknown = value;
	if (typeof candidate === "string") {
		try {
			candidate = JSON.parse(candidate);
		} catch {
			throw new Error(`agent tool ${field} must be a JSON array of task objects, got an unparseable string`);
		}
	}
	if (Array.isArray(candidate)) return candidate as NonNullable<AgentToolInput["tasks"]>;
	if (typeof candidate === "object") {
		return [candidate] as NonNullable<AgentToolInput["tasks"]>;
	}
	throw new Error(`agent tool ${field} must be an array of task objects, got ${typeof candidate}`);
}

export function normalizeAgentToolAliases(params: AgentToolInput): AgentToolInput {
	const input = params as AgentToolParams;
	rejectUnsupportedFutureFields(input);
	const tasks = coerceTaskList(params.tasks, "tasks");
	const chain = coerceTaskList(params.chain, "chain");
	return {
		...params,
		agent: resolveStringAlias(input, "agent", "subagent_type") ?? params.agent,
		task: resolveStringAlias(input, "task", "prompt") ?? params.task,
		background: resolveBooleanAlias(input, "background", "run_in_background") ?? params.background,
		tasks: tasks?.map((task) => normalizeAgentTaskAliases(task as AgentTaskParams, "tasks")),
		chain: chain?.map((task) => normalizeAgentTaskAliases(task as AgentTaskParams, "chain")),
	};
}

export function normalizeAgentToolMode(params: AgentToolInput): {
	mode: AgentToolMode;
	tasks: AgentTaskConfig[];
} {
	const normalized = normalizeAgentToolAliases(params);
	const hasSingle = Boolean(normalized.agent && normalized.task);
	const tasks = normalized.tasks as AgentTaskConfig[] | undefined;
	const chain = normalized.chain as AgentTaskConfig[] | undefined;
	const hasParallel = Boolean(tasks && tasks.length > 0);
	const count = countExecutionModes(normalized);
	if (count !== 1) {
		throw new Error(
			"agent tool requires exactly one mode: {subagent_type, prompt} (or legacy {agent, task}), {tasks}, or {chain}",
		);
	}
	if (hasSingle) {
		const task: AgentTaskConfig & Record<PropertyKey, unknown> = {
			agent: normalized.agent ?? "",
			task: normalized.task ?? "",
			description: normalized.description,
			context: normalized.context,
			extraContext: normalized.extraContext,
			model: normalized.model,
			tools: normalized.tools,
			thinking: normalized.thinking,
			maxOutputTokens: normalized.maxOutputTokens,
			output: normalized.output,
			outputMode: normalized.outputMode,
			cwd: normalized.cwd,
		};
		const automaticWorktreeCwd = (normalized as AgentToolInput & Record<PropertyKey, unknown>)[
			AUTOMATIC_WORKTREE_CWD
		];
		if (automaticWorktreeCwd === true) task[AUTOMATIC_WORKTREE_CWD] = true;
		return {
			mode: "single",
			tasks: [task],
		};
	}
	if (hasParallel) return { mode: "parallel", tasks: tasks ?? [] };
	return { mode: "chain", tasks: chain ?? [] };
}

function formatUsage(run: AgentRunDetails): string | undefined {
	if (!run.usage) return undefined;
	return `${formatAgentTokenCount(run.usage.totalTokens)} tok`;
}

function formatRunStats(run: AgentRunDetails): string {
	return [
		`${run.toolCallCount} tool ${run.toolCallCount === 1 ? "use" : "uses"}`,
		formatUsage(run),
		formatAgentDurationMs(run.durationMs),
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
}

function formatModelLabel(model: { provider: string; id: string } | Model<Api> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function formatCallModelLabel(reference: string | undefined, parentModel: Model<Api> | undefined): string | undefined {
	if (!reference || reference === "inherit") return formatModelLabel(parentModel);
	return reference;
}

function formatCompactAgentMetadata(parts: { model?: string; thinking?: ThinkingLevel }[]): string {
	const models = [...new Set(parts.map((part) => part.model).filter((model): model is string => Boolean(model)))];
	const thinkingLevels = [
		...new Set(parts.map((part) => part.thinking ?? "off").filter((level): level is ThinkingLevel => Boolean(level))),
	];
	return [
		models.length > 0 ? `model ${models.join(", ")}` : undefined,
		thinkingLevels.length > 0 ? `thinking ${thinkingLevels.join(", ")}` : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
}

function previewText(text: string, maxLength = 120): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function formatToolActivity(run: AgentRunDetails): string {
	if (run.currentToolName) {
		return `${run.currentToolName}${run.currentToolArgsPreview ? `: ${previewText(run.currentToolArgsPreview)}` : ""}`;
	}
	const lastTool = run.recentToolCalls[run.recentToolCalls.length - 1];
	if (lastTool) {
		return `${lastTool.name}${lastTool.argsPreview ? `: ${previewText(lastTool.argsPreview)}` : ""}`;
	}
	const snippet = run.recentOutputSnippets[run.recentOutputSnippets.length - 1];
	if (snippet) return previewText(snippet);
	if (run.status === "running") return `Working on: ${previewText(run.description ?? run.task)}`;
	if (run.status === "completed") return "Done";
	return run.error ? previewText(run.error) : run.status;
}

function formatRunWarnings(run: AgentRunDetails, prefix: string): string | undefined {
	if (!run.warnings || run.warnings.length === 0) return undefined;
	return run.warnings.map((warning) => `${prefix}${warning}`).join("\n");
}

function summarizeRuns(runs: AgentRunDetails[]): string {
	return runs
		.map((run, index) => {
			const isLast = index === runs.length - 1;
			const branch = isLast ? "└─" : "├─";
			const indent = isLast ? "   " : "│  ";
			const label = run.description ? `${run.agent} (${run.description})` : run.agent;
			const refs = [
				run.sessionId ? `session ${run.sessionId}` : undefined,
				run.outputPath ? `output ${run.outputPath}` : undefined,
			]
				.filter((part): part is string => Boolean(part))
				.join(" · ");
			const refSuffix = refs ? ` · ${refs}` : "";
			const status = run.status === "running" ? "running" : run.status;
			const metadata = formatCompactAgentMetadata([{ model: formatModelLabel(run.model), thinking: run.thinking }]);
			const warnings = formatRunWarnings(run, indent);
			return `${branch} ${label} · ${status}${metadata ? ` · ${metadata}` : ""} · ${formatRunStats(run)}${refSuffix}\n${indent}⎿  ${formatToolActivity(run)}${warnings ? `\n${warnings}` : ""}`;
		})
		.join("\n");
}

function formatExpandedRun(run: AgentRunDetails, index: number): string {
	const lines = [
		`${index + 1}. ${run.description ?? run.task} · ${run.agent}: ${run.status}`,
		`   model: ${formatModelLabel(run.model) ?? "inherit"} · thinking: ${run.thinking ?? "off"}`,
		`   tools: ${run.toolCallCount} · messages: ${run.messageCount} · duration: ${formatAgentDurationMs(run.durationMs)}${formatUsage(run) ? ` · ${formatUsage(run)}` : ""}`,
	];
	if (run.currentToolName)
		lines.push(
			`   current: ${run.currentToolName}${run.currentToolArgsPreview ? ` ${run.currentToolArgsPreview}` : ""}`,
		);
	if (run.sessionPath || run.sessionId) lines.push(`   session: ${run.sessionPath ?? run.sessionId}`);
	if (run.outputPath) lines.push(`   output: ${run.outputPath}`);
	const warnings = formatRunWarnings(run, "   ");
	if (warnings) lines.push(warnings);
	if (run.invokedSkills.count > 0)
		lines.push(`   invoked skills: ${run.invokedSkills.names.join(", ")} (${run.invokedSkills.count})`);
	if (run.loadedSkills.length > 0) lines.push(`   loaded skills: ${run.loadedSkills.join(", ")}`);
	if (run.recentToolCalls.length > 0) {
		lines.push("   recent tools:");
		for (const tool of run.recentToolCalls.slice(-5)) {
			lines.push(
				`   - ${tool.name}${tool.argsPreview ? ` ${tool.argsPreview}` : ""}${tool.isError ? " (error)" : ""}`,
			);
		}
	}
	if (run.recentOutputSnippets.length > 0) {
		lines.push("   recent output:");
		for (const snippet of run.recentOutputSnippets.slice(-3)) lines.push(`   > ${snippet}`);
	}
	if (run.error) lines.push(`   error: ${run.error}`);
	if (run.finalOutput) lines.push(`   final output:\n${run.finalOutput}`);
	return lines.join("\n");
}

interface AgentRendererState {
	runId?: string;
	details?: AgentToolDetails | AgentExecutionProgress;
	unsubscribe?: () => void;
	dispose?: () => void;
}

function detailsFromRecentRun(run: NonNullable<ReturnType<typeof findAgentRecentRun>>): AgentToolDetails {
	return {
		mode: run.mode,
		status: run.status,
		runs: run.runs,
		runId: run.id,
		background: run.execution === "background",
		resumable: run.resumable,
		parked: run.parked,
	};
}

function updateAgentRendererState(
	state: AgentRendererState,
	details: AgentToolDetails | AgentExecutionProgress | undefined,
	invalidate: () => void,
): void {
	if (!details) return;
	state.dispose ??= () => {
		state.unsubscribe?.();
		state.unsubscribe = undefined;
		state.runId = undefined;
	};
	state.details = details;
	const runId = "runId" in details ? details.runId : undefined;
	const background = "background" in details && details.background === true;
	if (!runId || !background) return;
	if (state.runId === runId) {
		const run = findAgentRecentRun(runId);
		if (run) state.details = detailsFromRecentRun(run);
		return;
	}
	state.unsubscribe?.();
	state.runId = runId;
	const refresh = (deferInvalidate = false) => {
		const run = findAgentRecentRun(runId);
		if (!run) {
			state.unsubscribe?.();
			state.unsubscribe = undefined;
			return;
		}
		state.details = detailsFromRecentRun(run);
		if (deferInvalidate) queueMicrotask(invalidate);
		else invalidate();
		if (run.status !== "running") {
			state.unsubscribe?.();
			state.unsubscribe = undefined;
		}
	};
	state.unsubscribe = subscribeAgentRecentRuns(() => refresh());
	refresh(true);
}

function getPresentedAgentDetails(state: AgentRendererState): AgentToolDetails | AgentExecutionProgress | undefined {
	if (!state.runId) return state.details;
	const run = findAgentRecentRun(state.runId);
	return run ? detailsFromRecentRun(run) : state.details;
}

function actionMarker(state: "preparing" | "running" | "success" | "error", theme: Theme): string {
	switch (state) {
		case "preparing":
			return theme.fg("dim", "·");
		case "running":
			return theme.fg("accent", "•");
		case "success":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
	}
}

function callActionState(
	context: { argsComplete: boolean; executionStarted: boolean; isPartial: boolean; isError: boolean },
	details: AgentToolDetails | AgentExecutionProgress | undefined,
): "preparing" | "running" | "success" | "error" {
	if (
		context.isError ||
		details?.status === "failed" ||
		details?.status === "cancelled" ||
		(details?.status === "interrupted" && !details.parked)
	) {
		return "error";
	}
	if (details?.status === "completed" || details?.parked) return "success";
	if (details?.status === "running") return "running";
	if (!context.argsComplete || !context.executionStarted) return "preparing";
	return context.isPartial ? "running" : "success";
}

function taskDisplayName(task: AgentTaskConfig): string {
	return task.description ?? task.task;
}

function findRunForTask(
	runs: AgentRunDetails[],
	task: AgentTaskConfig,
	used: Set<number>,
): AgentRunDetails | undefined {
	const index = runs.findIndex(
		(run, candidate) =>
			!used.has(candidate) &&
			run.agent === task.agent &&
			run.task === task.task &&
			run.description === task.description,
	);
	if (index === -1) return undefined;
	used.add(index);
	return runs[index];
}

function formatAgentActivity(run: AgentRunDetails | undefined, parked: boolean): string {
	if (!run) return "Initializing";
	if (run.status === "completed") return `Done · ${formatRunStats(run)}`;
	if (run.status === "failed") return `Failed${run.error ? ` · ${previewText(run.error)}` : ""}`;
	if (run.status === "cancelled" || run.status === "interrupted") return parked ? "Idle" : "Interrupted";
	return formatToolActivity(run);
}

function formatAgentCallRows(
	tasks: AgentTaskConfig[],
	details: AgentToolDetails | AgentExecutionProgress | undefined,
	parentModel: Model<Api> | undefined,
	parentThinking: ThinkingLevel,
	theme: Theme,
): string[] {
	const used = new Set<number>();
	return tasks.map((task, index) => {
		const run = findRunForTask(details?.runs ?? [], task, used);
		const branch = index === tasks.length - 1 ? "└" : "├";
		const model = run ? formatModelLabel(run.model) : formatCallModelLabel(task.model, parentModel);
		const modelText = run
			? model
			: task.model && task.model !== "inherit"
				? model
					? `requested ${model}`
					: "requested model"
				: model
					? `inherits ${model}`
					: "inherits parent model";
		const thinking = run?.thinking ?? task.thinking ?? parentThinking;
		const continuation = index === tasks.length - 1 ? "     " : "  │  ";
		return [
			`${theme.fg("dim", `  ${branch} `)}${theme.fg("accent", taskDisplayName(task))}${theme.fg("muted", ` · ${task.agent}`)}`,
			`${theme.fg("dim", continuation)}${theme.fg("muted", `${modelText} · thinking ${thinking}`)}`,
			`${theme.fg("dim", continuation)}${theme.fg("dim", `⎿ ${formatAgentActivity(run, details?.parked === true)}`)}`,
		].join("\n");
	});
}

function runControlHint(runId?: string): string | undefined {
	return runId
		? `Control: /agents-status ${runId}, /agents interrupt ${runId}, /agents cancel ${runId}, /agents resume ${runId} [-- prompt]`
		: undefined;
}

function formatProgress(progress: AgentExecutionProgress): string {
	const completed = progress.runs.filter((run) => run.status === "completed").length;
	const running = progress.runs.filter((run) => run.status === "running").length;
	const failed = progress.runs.filter((run) => run.status === "failed").length;
	const total = progress.runs.length;
	const noun = total === 1 ? "agent" : "agents";
	const headline = running > 0 ? `Running ${total} ${noun}…` : `${completed}/${total} ${noun} finished`;
	const status = `${headline}${running ? ` · ${running} running` : ""}${failed ? ` · ${failed} failed` : ""}`;
	const summary = summarizeRuns(progress.runs);
	return summary ? `${progress.mode}: ${status}\n${summary}` : `${progress.mode}: ${status}`;
}

function formatFinalResult(details: AgentToolDetails): string {
	if (details.background && details.status === "running") {
		return [
			`Agent ${details.mode}: background running${details.runId ? ` · ${details.runId}` : ""}`,
			details.message,
			runControlHint(details.runId),
		]
			.filter((line): line is string => Boolean(line))
			.join("\n");
	}
	const failed = details.runs.filter((run) => run.status === "failed").length;
	const completed = details.runs.filter((run) => run.status === "completed").length;
	const total = details.runs.length;
	const noun = total === 1 ? "agent" : "agents";
	const lines = [
		`Agent ${details.mode}: ${details.status} · ${completed}/${total} ${noun} finished${failed ? ` · ${failed} failed` : ""}`,
	];

	const summary = summarizeRuns(details.runs);
	if (summary) lines.push(summary);
	const outputs = details.runs
		.filter(
			(run) => run.finalOutput && (!run.outputPath || run.finalOutput !== `Saved Agent output to ${run.outputPath}`),
		)
		.map((run) => `\n### ${run.agent}\n\n${run.finalOutput}`);
	if (outputs.length > 0) lines.push(outputs.join("\n"));
	return lines.join("\n");
}

function detailsFromControlResult(
	result: Awaited<ReturnType<typeof interruptAgentRecentRun>>,
): AgentToolDetails | undefined {
	if (!result.run) return undefined;
	return {
		mode: result.run.mode,
		status: result.run.status,
		runs: result.run.runs,
		runId: result.run.id,
		background: result.run.execution === "background",
		resumable: result.run.resumable,
		message: result.message,
	};
}

async function executeLegacyAgentControlAction(params: AgentToolInput): Promise<AgentToolResult<AgentToolDetails>> {
	if (!params.runId) throw new Error(`agent control action ${params.action} requires runId`);
	if (params.action === "inject") {
		if (!params.message) throw new Error("agent control action inject requires message");
		// Prefer live steering; interrupt+resume is destructive and must never be
		// used on a run that cannot resume (it would discard all of its work).
		const injected = await injectAgentRecentRun(params.runId, params.message);
		// A run only becomes resumable after an interrupt, and only when it is a
		// single background run with one live child session. Interrupting anything
		// else (a parallel fan-out) throws its work away with no way back.
		const unresumable = !injected.ok && !(injected.run?.mode === "single" && injected.run.execution === "background");
		if (injected.ok || unresumable) {
			const text = injected.ok
				? injected.message
				: `${params.runId} cannot accept an injected message (${injected.message}); the run was left untouched`;
			return {
				content: [{ type: "text", text: `${text}\n\n${formatAgentStatus(undefined, params.runId)}` }],
				details: detailsFromControlResult(injected),
			};
		}
		await interruptAgentRecentRun(params.runId);
		const resumed = await resumeAgentRecentRun(params.runId, params.message);
		const detailText = formatAgentStatus(undefined, params.runId);
		return {
			content: [{ type: "text", text: `${resumed.message}\n\n${detailText}` }],
			details: detailsFromControlResult(resumed),
		};
	}
	const result =
		params.action === "interrupt"
			? await interruptAgentRecentRun(params.runId)
			: params.action === "cancel"
				? await cancelAgentRecentRun(params.runId)
				: await resumeAgentRecentRun(params.runId, params.message);
	const detailText = formatAgentStatus(undefined, params.runId);
	return {
		content: [{ type: "text", text: `${result.message}\n\n${detailText}` }],
		details: detailsFromControlResult(result),
	};
}

async function executeAgentControlAction(
	params: AgentToolInput,
	engine?: AgentEngine,
): Promise<AgentToolResult<AgentToolDetails>> {
	if (countExecutionModes(params) > 0) {
		throw new Error(
			"agent tool control actions cannot be combined with {subagent_type, prompt} (or legacy {agent, task}), {tasks}, or {chain}",
		);
	}
	const action = params.action;
	if (!action) throw new Error("Missing agent control action");
	if (action === "status" || action === "detail") {
		return { content: [{ type: "text", text: formatAgentStatus(undefined, params.runId) }] };
	}
	if (!engine) return executeLegacyAgentControlAction(params);
	const details = await engine.control(params);
	const detailText = formatAgentStatus(undefined, params.runId);
	return {
		content: [{ type: "text", text: `${details?.message ?? "Agent control action completed"}\n\n${detailText}` }],
		details,
	};
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
		"Project-local .pi/agents prompts are controlled by this repository and may instruct Agent runs to use active tools.",
	);
	if (!confirmed) {
		throw new Error("Project agent execution cancelled");
	}
}

export function createAgentToolDefinition(
	_cwd: string,
	options?: AgentToolOptions,
): ToolDefinition<typeof agentToolSchema, AgentToolDetails> {
	const toolName = options?.toolName ?? "agent";
	// TUI label is capitalized for consistency with Anthropic's "Agent"/"Task" tool naming;
	// the underlying tool id (toolName) stays lowercase so existing tool-call wiring is unchanged.
	const label = options?.label ?? toolName.charAt(0).toUpperCase() + toolName.slice(1);
	return {
		name: toolName,
		label,
		description:
			options?.description ??
			"Run a Pi Agent task with a selected profile, optionally in parallel, sequentially, or in the background.",

		promptSnippet: "Run an Agent task with bounded tools",
		promptGuidelines: [
			"Use Agent for complex or multi-file work. For a single known file, symbol, or value, use direct tools instead; do not duplicate an investigation after dispatching it.",
			"Profiles: `explore` — read-only search with read-only bash; `decompose` — read-only task splitting; `plan` — read-only strategy; `reviewer` — read-only correctness review; `worker` — scoped implementation; `general` — mixed investigation, edits, shell, and verification.",
			"Write an outcome contract: desired outcome and why; relevant paths and file structure; known or ruled-out context; tools and skills; constraints and acceptance criteria; expected report; and self-verification evidence. State real sequencing invariants, then let the selected model choose its method.",
			"Run independent tasks in parallel; use `chain` only when later work depends on earlier results.",
			"Background completion arrives as `agent_completion`; do not poll. The final response returns here, not directly to the user. Validate evidence and inspect claimed file changes.",
			'`context: "fork"` is a permissive self-fork that preserves the caller transcript, system prompt, and tools. Use `context: "default"` for an isolated named profile and its filtered tools; use `cwd` for another directory.',
			"Nested Agent calls are depth-capped; each task receives its effective Agent availability.",
		],
		parameters: agentToolSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const normalizedParams = normalizeAgentToolAliases(params);
			const engine = options?.engine ?? options?.getEngine?.() ?? getContextAgentEngine();
			if (normalizedParams.action) return executeAgentControlAction(normalizedParams, engine);
			await confirmProjectAgentsIfNeeded(normalizedParams, ctx);
			const mode = normalizeAgentToolMode(normalizedParams);
			const input = {
				mode: mode.mode,
				tasks: mode.tasks,
				concurrency: normalizedParams.concurrency,
				context: normalizedParams.context,
				extraContext: normalizedParams.extraContext,
				model: normalizedParams.model,
				tools: normalizedParams.tools,
				thinking: normalizedParams.thinking,
				output: normalizedParams.output,
				outputMode: normalizedParams.outputMode,
				chainDir: normalizedParams.chainDir,
				background: normalizedParams.background,
				agentScope: normalizedParams.agentScope,
			};
			const progressHandler = (progress: AgentExecutionProgress) => {
				onUpdate?.({ content: [{ type: "text", text: formatProgress(progress) }], details: progress });
			};
			let details: AgentToolDetails;
			if (engine) {
				details = await engine.run(input, { signal, onProgress: progressHandler });
			} else {
				if (!options?.parentServices || !options.getParentActiveTools || !options.getParentSessionManager) {
					throw new Error("agent tool is unavailable in this runtime");
				}
				details = await executeAgentTool(input, {
					parentServices: options.parentServices,
					parentActiveTools: options.getParentActiveTools(),
					parentSessionManager: options.getParentSessionManager(),
					parentModel: options.getParentModel?.(),
					parentThinkingLevel: options.getParentThinkingLevel?.() ?? "off",
					parentSystemPrompt: options.getParentSystemPrompt?.(),
					onBackgroundTerminal: options.onBackgroundTerminal,
					signal,
					onProgress: progressHandler,
				});
			}
			return { content: [{ type: "text", text: formatFinalResult(details) }], details };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const state = (context.state ?? {}) as AgentRendererState;
			const details = getPresentedAgentDetails(state);
			try {
				const normalizedArgs = normalizeAgentToolAliases(args);
				if (normalizedArgs.action) {
					const actionState = callActionState(context, undefined);
					const action =
						actionState === "error"
							? `${normalizedArgs.action} failed`
							: actionState === "success"
								? `${normalizedArgs.action} complete`
								: normalizedArgs.action;
					text.setText(
						`${actionMarker(actionState, theme)} ${theme.fg("toolTitle", theme.bold(`Agent ${action}`))}${normalizedArgs.runId ? theme.fg("muted", ` · ${normalizedArgs.runId}`) : ""}`,
					);
					return text;
				}
				const mode = normalizeAgentToolMode(normalizedArgs);
				const parentModel = options?.getParentModel?.();
				const parentThinking = options?.getParentThinkingLevel?.() ?? "off";
				const actionState = callActionState(context, details);
				const count = mode.tasks.length;
				const noun = count === 1 ? "agent" : "agents";
				const verb =
					actionState === "preparing"
						? "Preparing delegation"
						: actionState === "running"
							? `Delegating ${count} ${noun}`
							: actionState === "error"
								? "Delegation failed"
								: `Delegated ${count} ${noun}`;
				const metadata = [
					mode.mode !== "single" ? mode.mode : undefined,
					normalizedArgs.background ? "background" : undefined,
				]
					.filter((part): part is string => Boolean(part))
					.join(" · ");
				const rows = formatAgentCallRows(mode.tasks, details, parentModel, parentThinking, theme);
				text.setText(
					`${actionMarker(actionState, theme)} ${theme.fg("toolTitle", theme.bold(verb))}${metadata ? theme.fg("muted", ` · ${metadata}`) : ""}${rows.length > 0 ? `\n${rows.join("\n")}` : ""}`,
				);
			} catch (error) {
				// Streaming tool-call arguments arrive incrementally, so a half-parsed
				// `tasks`/`chain` entry legitimately misses required fields until the
				// call is complete. Rendering that as a failure showed phantom "✗ Agent
				// … require subagent_type and prompt" errors for calls that then ran fine.
				if (!context.argsComplete) {
					text.setText(
						`${actionMarker("preparing", theme)} ${theme.fg("toolTitle", theme.bold(`${label} preparing delegation`))}`,
					);
					return text;
				}
				const message = error instanceof Error ? error.message : "invalid mode";
				text.setText(
					`${theme.fg("error", "✗")} ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("error", message)}`,
				);
			}
			return text;
		},
		renderResult(result, renderOptions, _theme, context) {
			const state = (context.state ?? {}) as AgentRendererState;
			const detailsChanged = state.details !== result.details;
			updateAgentRendererState(state, result.details, context.invalidate);
			if (detailsChanged && !state.runId && typeof context.invalidate === "function") context.invalidate();
			const details = getPresentedAgentDetails(state) ?? result.details;
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (renderOptions.expanded && details) {
				const status = details.parked && details.status === "interrupted" ? "idle" : details.status;
				const expandedText = [`Agent ${details.mode}: ${status}`, ...details.runs.map(formatExpandedRun)].join(
					"\n",
				);
				component.addChild(new Spacer(1));
				component.addChild(new Text(expandedText, 0, 0));
			} else if (!details) {
				const text = result.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				component.addChild(new Spacer(1));
				component.addChild(new Text(text.split("\n").slice(0, 2).join("\n"), 0, 0));
			}
			return component;
		},
	};
}

export function createAgentTool(cwd: string, options?: AgentToolOptions): AgentTool<typeof agentToolSchema> {
	return wrapToolDefinition(createAgentToolDefinition(cwd, options));
}

export function createUppercaseAgentToolDefinition(
	cwd: string,
	options?: AgentToolOptions,
): ToolDefinition<typeof agentToolSchema, AgentToolDetails> {
	return createAgentToolDefinition(cwd, {
		...options,
		toolName: "Agent",
		label: "Agent",
		description: "Run a Pi Agent task through the Claude Code-compatible Agent tool.",
	});
}

export function createUppercaseAgentTool(cwd: string, options?: AgentToolOptions): AgentTool<typeof agentToolSchema> {
	return wrapToolDefinition(createUppercaseAgentToolDefinition(cwd, options));
}

export function createTaskToolDefinition(
	cwd: string,
	options?: AgentToolOptions,
): ToolDefinition<typeof agentToolSchema, AgentToolDetails> {
	return createAgentToolDefinition(cwd, {
		...options,
		toolName: "Task",
		label: "Task",
		description: "Run a Pi Agent task through the legacy Task alias.",
	});
}

export function createTaskTool(cwd: string, options?: AgentToolOptions): AgentTool<typeof agentToolSchema> {
	return wrapToolDefinition(createTaskToolDefinition(cwd, options));
}

export type { AgentToolDetails };
