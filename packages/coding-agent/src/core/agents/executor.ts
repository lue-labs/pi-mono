import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@valkyriweb/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent, Usage } from "@valkyriweb/pi-ai";
import type { AgentSession } from "../agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../agent-session-services.ts";
import type { AuthStorage } from "../auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "../defaults.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { fastModelPerProvider, mediumModelPerProvider, parseModelPattern } from "../model-resolver.ts";
import { type ReadonlySessionManager, SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { appendTaskMessage } from "../tasks/messages.ts";
import { EXPLORE_BASH_POLICY, runWithBashPolicy } from "../tools/bash.ts";
import {
	buildAgentSystemAppend,
	buildChildTaskPrompt,
	clampThinkingForModel,
	formatModelForDetails,
	getChildResourceLoaderOptions,
	getFilteredForkMessages,
	resolveContextPolicy,
} from "./context.ts";
import { registerLiveSession, unregisterLiveSession } from "./live-sessions.ts";
import { writeAgentOutput } from "./output.ts";
import { findAgentDefinition, formatAvailableAgents, loadAgentRegistry } from "./registry.ts";
import type { AgentRecentRun } from "./status.ts";
import {
	attachAgentRecentRunController,
	attachAgentRecentRunTerminalListener,
	failAgentRecentRun,
	finishAgentRecentRun,
	formatAgentDurationMs,
	getAgentRecentRunGeneration,
	markAgentRecentRunNeedsAttention,
	restartAgentRecentRun,
	startAgentRecentRun,
	updateAgentRecentRunProgress,
} from "./status.ts";
import type {
	AgentBackgroundCompletion,
	AgentDefaultSelection,
	AgentDefinition,
	AgentExecutionProgress,
	AgentOutputMode,
	AgentRegistry,
	AgentRunDetails,
	AgentScope,
	AgentTaskConfig,
	AgentToolDetails,
	AgentToolMode,
	AgentToolStatus,
	ContextMode,
	NormalizedAgentTaskConfig,
} from "./types.ts";

// Tools globally denied to every child regardless of depth. `agent` is NOT here:
// nested delegation is gated per-depth via `allowAgentDelegation` (computed from
// `subagents.maxDelegationDepth`) so children below the cap can fan out while the
// boundary is enforced by withholding the child's engine binding (agentToolServices).
const GLOBAL_DENY_TOOLS = new Set<string>();
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MAX_PARALLEL_TASKS = 8;
const BACKGROUND_MONITOR_INTERVAL_MS = 30_000;
const BACKGROUND_STALE_PROGRESS_MS = 10 * 60_000;

export interface AgentToolParentServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	/**
	 * Delegation depth of the session that owns these services. Top-level
	 * interactive session = 0 (or undefined); each nested child increments by 1.
	 * Gates whether this session's children may themselves delegate.
	 */
	depth?: number;
}

export interface AgentExecutorOptions {
	parentServices: AgentToolParentServices;
	parentActiveTools: string[];
	parentSessionManager: ReadonlySessionManager;
	parentModel: Model<Api> | undefined;
	parentThinkingLevel: ThinkingLevel;
	/**
	 * Frozen turn-start system prompt captured at agent tool execute() time.
	 * When provided, context:"fork" children inherit it 1:1 instead of rebuilding —
	 * ensures system + tools bytes are cache-identical to the parent's API prefix.
	 */
	parentSystemPrompt?: string;
	onProgress?: (progress: AgentExecutionProgress) => void;
	signal?: AbortSignal;
	abortStatus?: () => AgentToolStatus | undefined;
	onChildSessionStart?: (session: AgentSession, details: AgentRunDetails) => void;
	onChildSessionEnd?: (session: AgentSession, details: AgentRunDetails) => void;
	/**
	 * Fired exactly once when a background run reaches a terminal status
	 * (completed | failed | cancelled | interrupted). Only wired by the
	 * `executeAgentTool` background path — foreground runs return synchronously
	 * and don't need a push. Parent sessions use this to inject a structured
	 * `agent_completion` custom message instead of polling status.
	 */
	onBackgroundTerminal?: (notification: AgentBackgroundCompletion) => void;
}

export interface AgentToolExecutionInput {
	mode: AgentToolMode;
	tasks: AgentTaskConfig[];
	concurrency?: number;
	context?: ContextMode;
	extraContext?: string;
	model?: string;
	tools?: string[];
	thinking?: ThinkingLevel;
	output?: string;
	outputMode?: AgentOutputMode;
	chainDir?: string;
	agentScope?: AgentScope;
	background?: boolean;
}

interface RunChildOptions extends AgentExecutorOptions {
	registry: AgentRegistry;
	task: NormalizedAgentTaskConfig;
	toolModel?: string;
	toolThinking?: ThinkingLevel;
	chainDir?: string;
	progressInput: AgentToolExecutionInput;
	progressRuns: AgentRunDetails[];
	/** Recent-run id; sinks live events into core/tasks message buffer. */
	taskId?: string;
}

/**
 * Resolve and validate a child session's working directory. Expands a leading
 * `~`/`~/...` to the home dir, resolves relative paths against the parent cwd,
 * and confirms the result exists and is a directory. Throws a clear error
 * (listing the resolved path) instead of letting the child boot in a bad cwd.
 */
export function resolveChildCwd(taskCwd: string | undefined, parentCwd: string): string {
	if (taskCwd === undefined || taskCwd.trim() === "") return parentCwd;
	const expanded =
		taskCwd === "~" || taskCwd.startsWith("~/") ? resolve(homedir(), taskCwd.slice(1).replace(/^\/+/, "")) : taskCwd;
	const resolved = isAbsolute(expanded) ? expanded : resolve(parentCwd, expanded);
	if (!existsSync(resolved)) {
		throw new Error(`Agent cwd does not exist: ${resolved} (from "${taskCwd}")`);
	}
	if (!statSync(resolved).isDirectory()) {
		throw new Error(`Agent cwd is not a directory: ${resolved} (from "${taskCwd}")`);
	}
	return resolved;
}

function normalizeOutputMode(mode: AgentOutputMode | undefined): AgentOutputMode {
	return mode ?? "inline";
}

function normalizeTask(
	task: AgentTaskConfig,
	input: AgentToolExecutionInput,
	definition?: AgentDefinition,
): NormalizedAgentTaskConfig {
	const context =
		task.context ??
		input.context ??
		definition?.defaultContext ??
		(definition?.cacheProfile === "stable" ? "none" : "default");
	return {
		...task,
		extraContext: task.extraContext ?? input.extraContext,
		model: task.model ?? input.model,
		tools: task.tools ?? input.tools,
		thinking: task.thinking ?? input.thinking,
		output: task.output ?? input.output,
		outputMode: normalizeOutputMode(task.outputMode ?? input.outputMode),
		context,
	};
}

/**
 * Canonicalize a tool name for capability matching. Built-in agent definitions
 * declare lowercase core names (`read`, `grep`, `bash`), but a profile may rename
 * the same capability under an aliased name — e.g. a native-tool override that
 * registers `Read`/`Grep`/`Bash` and exposes deferred tools as `mcp__pi__Find`.
 * Active tool names come from the internal registry (`agent.state.tools[].name`),
 * so case is the only skew; lowercasing makes aliases of the same capability
 * resolve to each other. Without it the allow-list intersection is empty and the
 * child runs with NO tools (model then emits tool calls as literal text, 0 uses).
 */
function canonicalToolName(name: string): string {
	return name.toLowerCase();
}

/** Read the configured nested-delegation cap (0 = no nesting). Clamped to 16. */
export function getMaxDelegationDepth(settingsManager: SettingsManager): number {
	const raw = settingsManager.getSubagentSettings().maxDelegationDepth;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
	return Math.min(Math.floor(raw), 16);
}

/**
 * Top-level (depth 0) always delegates. A nested child at depth `d` may delegate
 * (spawn a depth `d+1` child) only while `d < maxDepth`.
 */
export function canDelegateAtDepth(depth: number, maxDepth: number): boolean {
	return depth === 0 || depth < maxDepth;
}

export function resolveEffectiveTools(options: {
	parentActiveTools: string[];
	agent: AgentDefinition;
	requestedTools?: string[];
	/** When false (default), the `agent` tool is denied to the child. */
	allowAgentDelegation?: boolean;
}): { effectiveTools: string[]; deniedTools: string[] } {
	// Map canonical name -> actual active tool name so matches resolve back to the
	// real registered alias the child session must request.
	const parentByCanonical = new Map<string, string>();
	for (const tool of options.parentActiveTools) {
		const key = canonicalToolName(tool);
		if (!parentByCanonical.has(key)) parentByCanonical.set(key, tool);
	}
	const hasParent = (tool: string): boolean => parentByCanonical.has(canonicalToolName(tool));
	const requested = options.requestedTools;
	if (requested) {
		const inactive = requested.filter((tool) => !hasParent(tool));
		if (inactive.length > 0) {
			throw new Error(`Requested inactive tool(s): ${inactive.join(", ")}`);
		}
	}

	// Resolve candidates to the actual active alias names.
	let candidates = (requested ?? options.parentActiveTools).map(
		(tool) => parentByCanonical.get(canonicalToolName(tool)) ?? tool,
	);
	const agentTools = options.agent.tools ?? "*";
	if (agentTools !== "*") {
		const allowed = new Set(agentTools.map(canonicalToolName));
		candidates = candidates.filter((tool) => allowed.has(canonicalToolName(tool)));
	}

	const deny = new Set(
		[
			...(options.agent.denyTools ?? []),
			...GLOBAL_DENY_TOOLS,
			...(options.allowAgentDelegation ? [] : ["agent"]),
		].map(canonicalToolName),
	);
	const isDenied = (tool: string): boolean => deny.has(canonicalToolName(tool));
	const effectiveTools = candidates.filter((tool) => hasParent(tool) && !isDenied(tool));
	const deniedTools = candidates.filter((tool) => isDenied(tool));

	// Bundle the bash job-control trio: when `bash`/`Bash` is granted, also grant
	// the parent's output/kill companions if active and not denied. Otherwise a
	// child can spawn run_in_background:true jobs but never read or stop them.
	if (effectiveTools.some((tool) => canonicalToolName(tool) === "bash")) {
		// Each group lists the known name variants for one capability; the active
		// alias may be either the lowercase core name or a capitalized override.
		const companionGroups = [
			["bash_output", "BashOutput"],
			["bash_kill", "KillShell"],
		];
		for (const variants of companionGroups) {
			for (const variant of variants) {
				const actual = parentByCanonical.get(canonicalToolName(variant));
				if (actual && !isDenied(actual) && !effectiveTools.includes(actual)) {
					effectiveTools.push(actual);
					break;
				}
			}
		}
	}

	return { effectiveTools: [...new Set(effectiveTools)], deniedTools: [...new Set(deniedTools)] };
}

export function resolveAgentModel(options: {
	modelReference?: string;
	agent: AgentDefinition;
	defaults?: AgentDefaultSelection;
	parentModel: Model<Api> | undefined;
	modelRegistry: ModelRegistry;
}): Model<Api> | undefined {
	// Precedence: explicit task option > agent frontmatter > settings.subagents (provider override > defaults) > parent inheritance.
	const defaultRef =
		options.defaults?.model && options.defaults.model !== "inherit" ? options.defaults.model : undefined;
	const reference =
		options.modelReference ??
		(options.agent.model && options.agent.model !== "inherit" ? options.agent.model : undefined) ??
		defaultRef;
	if (!reference) return options.parentModel;

	// `"fast"` / `"medium"` aliases: resolve to the parent provider's mapped tier.
	// `fast` is used by the read-only `explore` agent to avoid burning the parent's
	// expensive model on grep/find/read workloads; `medium` is the mid-tier for
	// extractors and structured workloads that need more than Haiku/Mini. Both
	// fall back to the parent model when the provider has no mapping or the mapped
	// id is not available — never throws.
	if (reference === "fast" || reference === "medium") {
		const parentProvider = options.parentModel?.provider;
		const table = reference === "fast" ? fastModelPerProvider : mediumModelPerProvider;
		const mappedId = parentProvider ? table[parentProvider] : undefined;
		if (mappedId) {
			const available = options.modelRegistry.getAvailable();
			const hit = available.find((m) => m.provider === parentProvider && m.id === mappedId);
			if (hit) return hit;
		}
		return options.parentModel;
	}

	const result = parseModelPattern(reference, options.modelRegistry.getAvailable());
	if (!result.model) {
		throw new Error(`Unknown or unavailable model: ${reference}`);
	}
	return result.model;
}

export function resolveAgentThinking(options: {
	taskThinking?: ThinkingLevel;
	toolThinking?: ThinkingLevel;
	agent: AgentDefinition;
	defaults?: AgentDefaultSelection;
	parentThinkingLevel: ThinkingLevel;
	model: Model<Api> | undefined;
}): ThinkingLevel {
	const agentThinking =
		options.agent.thinking && options.agent.thinking !== "inherit" ? options.agent.thinking : undefined;
	const defaultThinking =
		options.defaults?.thinking && options.defaults.thinking !== "inherit"
			? (options.defaults.thinking as ThinkingLevel)
			: undefined;
	// Precedence mirrors resolveAgentModel — task > tool > agent frontmatter > settings.subagents > parent.
	const selected =
		options.taskThinking ??
		options.toolThinking ??
		agentThinking ??
		defaultThinking ??
		options.parentThinkingLevel ??
		DEFAULT_THINKING_LEVEL;
	return clampThinkingForModel(options.model, selected);
}

/**
 * Reads settings.subagents and folds providers[parent.provider] over defaults
 * to produce the AgentDefaultSelection to pass into resolveAgentModel/Thinking.
 */
export function resolveAgentDefaults(options: {
	parentModel: Model<Api> | undefined;
	settingsManager: SettingsManager;
}): AgentDefaultSelection {
	const settings = options.settingsManager.getSubagentSettings();
	const providerDefaults = options.parentModel ? settings.providers?.[options.parentModel.provider] : undefined;
	return { ...(settings.defaults ?? {}), ...(providerDefaults ?? {}) };
}

function extractFinalAssistantText(messages: readonly { role: string; content?: unknown }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const textParts = message.content
			.filter((part): part is { type: "text"; text: string } => {
				return Boolean(
					part &&
						typeof part === "object" &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string",
				);
			})
			.map((part) => part.text);
		if (textParts.length > 0) return textParts.join("\n");
	}
	return "";
}

function createInitialRunDetails(options: {
	agent: AgentDefinition;
	task: NormalizedAgentTaskConfig;
	effectiveTools: string[];
	deniedTools: string[];
	model: Model<Api> | undefined;
	thinking: ThinkingLevel;
	startedAt: number;
}): AgentRunDetails {
	return {
		agent: options.agent.id,
		source: options.agent.source,
		task: options.task.task,
		description: options.task.description,
		status: "running",
		context: resolveContextPolicy(options.task.context),
		model: formatModelForDetails(options.model),
		thinking: options.thinking,
		effectiveTools: options.effectiveTools,
		deniedTools: options.deniedTools,
		durationMs: Date.now() - options.startedAt,
		toolCallCount: 0,
		messageCount: 0,
		recentToolCalls: [],
		recentOutputSnippets: [],
		loadedSkills: [],
		invokedSkills: { count: 0, names: [] },
	};
}

function previewValue(value: unknown, maxLength = 240): string | undefined {
	if (value === undefined) return undefined;
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function extractTextPreview(content: unknown, maxLength = 240): string | undefined {
	if (typeof content === "string") return previewValue(content, maxLength);
	if (!Array.isArray(content)) return previewValue(content, maxLength);
	const text = content
		.filter((part): part is TextContent => {
			return Boolean(
				part &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			);
		})
		.map((part) => part.text)
		.join("\n");
	return previewValue(text, maxLength);
}

function getLastAssistantUsage(
	messages: readonly { role: string; usage?: Usage; stopReason?: string }[],
): Usage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			message.role === "assistant" &&
			message.usage &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		) {
			return message.usage;
		}
	}
	return undefined;
}

function recordSkillInvocation(details: AgentRunDetails, toolName: string, args: unknown): void {
	if (toolName !== "skill" && toolName !== "skill_search") return;
	details.invokedSkills.count += 1;
	const argRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
	const candidates = [argRecord?.name, argRecord?.parent, argRecord?.child].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	for (const candidate of candidates) {
		if (!details.invokedSkills.names.includes(candidate)) details.invokedSkills.names.push(candidate);
	}
}

function refreshRunDetailsFromSession(
	details: AgentRunDetails,
	session: { messages: readonly unknown[] },
	startedAt: number,
): void {
	details.durationMs = Date.now() - startedAt;
	details.messageCount = session.messages.length;
	details.usage = getLastAssistantUsage(session.messages as AssistantMessage[]);
}

interface DriveChildSessionOptions extends AgentExecutorOptions {
	task: NormalizedAgentTaskConfig;
	chainDir?: string;
	progressInput: AgentToolExecutionInput;
	progressRuns: AgentRunDetails[];
	details: AgentRunDetails;
	startedAt: number;
	prompt: string;
	/** Task id (= AgentRecentRun.id) for live message ring buffer in core/tasks. */
	taskId?: string;
}

function getAbortedRunStatus(options: AgentExecutorOptions): "cancelled" | "interrupted" {
	return options.abortStatus?.() === "interrupted" ? "interrupted" : "cancelled";
}

async function driveChildSession(session: AgentSession, options: DriveChildSessionOptions): Promise<AgentRunDetails> {
	const { details, startedAt } = options;
	options.onChildSessionStart?.(session, details);
	const abortChild = () => {
		session.abortBash();
		void session.abort().catch(() => {});
	};
	if (options.signal && !options.signal.aborted) {
		options.signal.addEventListener("abort", abortChild, { once: true });
	}

	const taskId = options.taskId;
	if (taskId) registerLiveSession(taskId, session);
	const unsubscribe = session.subscribe((event) => {
		if (!options.progressRuns.includes(details)) options.progressRuns.push(details);
		refreshRunDetailsFromSession(details, session, startedAt);
		if (event.type === "message_update" && event.message.role === "assistant") {
			const snippet = extractTextPreview(event.message.content, 200);
			if (snippet && snippet !== details.recentOutputSnippets[details.recentOutputSnippets.length - 1]) {
				details.recentOutputSnippets.push(snippet);
				details.recentOutputSnippets = details.recentOutputSnippets.slice(-5);
				if (taskId) appendTaskMessage(taskId, { kind: "assistant_text", ts: Date.now(), text: snippet });
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			details.usage = event.message.usage;
			if (taskId) appendTaskMessage(taskId, { kind: "assistant_end", ts: Date.now() });
		}
		if (event.type === "tool_execution_start") {
			details.toolCallCount += 1;
			details.currentToolName = event.toolName;
			details.currentToolArgsPreview = previewValue(event.args);
			details.recentToolCalls.push({
				name: event.toolName,
				argsPreview: details.currentToolArgsPreview,
				startedAt: Date.now(),
			});
			details.recentToolCalls = details.recentToolCalls.slice(-8);
			recordSkillInvocation(details, event.toolName, event.args);
			if (taskId)
				appendTaskMessage(taskId, {
					kind: "tool_start",
					ts: Date.now(),
					toolName: event.toolName,
					argsPreview: details.currentToolArgsPreview,
				});
		}
		if (event.type === "tool_execution_end") {
			const active = details.recentToolCalls.find((tool) => !tool.endedAt && tool.name === event.toolName);
			if (active) {
				active.endedAt = Date.now();
				active.isError = event.isError;
				active.resultPreview = extractTextPreview(event.result.content, 200);
			}
			details.currentToolName = undefined;
			details.currentToolArgsPreview = undefined;
			if (taskId)
				appendTaskMessage(taskId, {
					kind: "tool_end",
					ts: Date.now(),
					toolName: event.toolName,
					isError: event.isError,
					resultPreview: extractTextPreview(event.result.content, 200),
				});
		}
		emitProgress(options.progressInput, options.progressRuns, options.onProgress);
	});

	try {
		if (options.signal?.aborted) throw new Error(`Agent run ${getAbortedRunStatus(options)}`);
		// `explore` is gated to read-only bash via an AsyncLocalStorage policy read
		// by the bash tool. Soft guard, not a sandbox — see EXPLORE_BASH_POLICY.
		// `source: "child-agent"` tags every in-process delegated run (built-in
		// `agent` tool + `ctx.forkAgent`) distinctly from `"extension"` (which
		// means "an extension hook called steer/sendCustomMessage"). Memory
		// extensions gate recall / persistent-memory inject on this in their
		// `input` and `before_agent_start` handlers. Replaces the legacy
		// `PI_MEMORY_SUBAGENT=1` env contract for in-process children.
		const runPrompt = () => session.prompt(options.prompt, { expandPromptTemplates: false, source: "child-agent" });
		await (details.agent === "explore" ? runWithBashPolicy(EXPLORE_BASH_POLICY, runPrompt) : runPrompt());
		if (options.signal?.aborted) throw new Error(`Agent run ${getAbortedRunStatus(options)}`);
		const finalOutput = extractFinalAssistantText(session.messages);
		const output = await writeAgentOutput({
			cwd: options.parentServices.cwd,
			output: options.task.output,
			outputMode: options.task.outputMode,
			content: finalOutput,
			chainDir: options.chainDir,
		});
		details.status = "completed";
		refreshRunDetailsFromSession(details, session, startedAt);
		details.outputPath = output.outputPath;
		details.finalOutput = output.displayText;
		details.rawOutput = output.rawContent;
		return details;
	} catch (error) {
		details.status = options.signal?.aborted ? getAbortedRunStatus(options) : "failed";
		refreshRunDetailsFromSession(details, session, startedAt);
		details.error = error instanceof Error ? error.message : String(error);
		throw Object.assign(new Error(details.error), { details });
	} finally {
		if (taskId) unregisterLiveSession(taskId);
		if (options.signal) options.signal.removeEventListener("abort", abortChild);
		unsubscribe();
		options.onChildSessionEnd?.(session, details);
		session.dispose();
	}
}

function applyMaxOutputTokens(
	model: Model<Api> | undefined,
	maxOutputTokens: number | undefined,
): Model<Api> | undefined {
	if (
		!model ||
		maxOutputTokens === undefined ||
		!Number.isFinite(maxOutputTokens) ||
		maxOutputTokens <= 0 ||
		maxOutputTokens >= model.maxTokens
	) {
		return model;
	}
	return { ...model, maxTokens: maxOutputTokens };
}

async function runChild(options: RunChildOptions): Promise<AgentRunDetails> {
	if (options.signal?.aborted) throw new Error("Agent tool aborted");
	const agent = findAgentDefinition(options.registry, options.task.agent);
	if (!agent) {
		throw new Error(
			`Unknown agent "${options.task.agent}". Available agents: ${formatAvailableAgents(options.registry)}`,
		);
	}

	const agentDefaults = resolveAgentDefaults({
		parentModel: options.parentModel,
		settingsManager: options.parentServices.settingsManager,
	});
	const model = resolveAgentModel({
		modelReference: options.task.model,
		agent,
		defaults: agentDefaults,
		parentModel: options.parentModel,
		modelRegistry: options.parentServices.modelRegistry,
	});
	const thinking = resolveAgentThinking({
		taskThinking: options.task.thinking,
		toolThinking: options.toolThinking,
		agent,
		defaults: agentDefaults,
		parentThinkingLevel: options.parentThinkingLevel,
		model,
	});
	const effectiveModel = applyMaxOutputTokens(model, options.task.maxOutputTokens);
	// Fork mode: context:"fork" + parentSystemPrompt available.
	// Use parent's exact tool set — 1:1 inheritance, no GLOBAL_DENY_TOOLS filtering.
	// Tool schemas must be byte-identical to the parent's API request for a cache hit.
	// Consequence: the `agent` tool schema stays in the child's tool list, so the
	// runtime guard against recursive delegation is *prompt-level* via the
	// CHILD_AGENT_REMINDER prefix injected by buildChildTaskPrompt (mirrors
	// Claude Code's <system-reminder> pattern). Default/slim modes keep the
	// hard GLOBAL_DENY_TOOLS filter as defense-in-depth.
	// All other modes: standard agent-definition-based tool resolution.
	const isForkMode =
		resolveContextPolicy(options.task.context).includeTranscript && Boolean(options.parentSystemPrompt);
	let effectiveTools: string[];
	let deniedTools: string[];
	// Nested-delegation gate: a child at `childDepth` may itself delegate only while
	// under the configured cap. When it may not, we withhold its engine binding
	// (agentToolServices) below so any `agent` call fails closed.
	const callerDepth = options.parentServices.depth ?? 0;
	const maxDelegationDepth = getMaxDelegationDepth(options.parentServices.settingsManager);
	const childDepth = callerDepth + 1;
	const childCanDelegate = canDelegateAtDepth(childDepth, maxDelegationDepth);
	if (isForkMode) {
		const parentSet = new Set(options.parentActiveTools);
		effectiveTools = options.task.tools
			? options.task.tools.filter((t) => parentSet.has(t))
			: [...options.parentActiveTools];
		deniedTools = [];
	} else {
		const resolved = resolveEffectiveTools({
			parentActiveTools: options.parentActiveTools,
			agent,
			requestedTools: options.task.tools,
			allowAgentDelegation: childCanDelegate,
		});
		effectiveTools = resolved.effectiveTools;
		deniedTools = resolved.deniedTools;
	}
	const startedAt = Date.now();
	const details = createInitialRunDetails({
		agent,
		task: options.task,
		effectiveTools,
		deniedTools,
		model: effectiveModel,
		thinking,
		startedAt,
	});
	const policy = details.context;
	// Optional cwd override (e.g. a git worktree, or exploring another repo) for
	// isolated child sessions. Normalize before use: expand a leading `~`, resolve
	// relative paths against the parent cwd, and validate the target is a real
	// directory — otherwise a child silently roots somewhere wrong and every
	// relative tool path resolves against the bad dir (the classic "explore
	// guessed the wrong cwd" failure).
	const childCwd = resolveChildCwd(options.task.cwd, options.parentServices.cwd);
	const childServices = await createAgentSessionServices({
		cwd: childCwd,
		agentDir: options.parentServices.agentDir,
		authStorage: options.parentServices.authStorage,
		settingsManager: options.parentServices.settingsManager,
		modelRegistry: options.parentServices.modelRegistry,
		resourceLoaderOptions: getChildResourceLoaderOptions(policy, agent),
	});
	const childSessionManager = SessionManager.create(childCwd);
	childSessionManager.newSession({ parentSession: options.parentSessionManager.getSessionFile() });
	details.sessionId = childSessionManager.getSessionId();
	details.sessionPath = childSessionManager.getSessionFile();
	const { session } = await createAgentSessionFromServices({
		services: childServices,
		sessionManager: childSessionManager,
		model: effectiveModel,
		thinkingLevel: thinking,
		tools: effectiveTools,
		// Record this child's delegation depth on its own agent-tool services. When the
		// child later calls `agent`, executeAgentTool reads this depth and enforces the
		// cap (subagents.maxDelegationDepth). Without this the depth would always read 0
		// and nesting would be unbounded.
		agentToolServices: {
			cwd: childCwd,
			agentDir: options.parentServices.agentDir,
			authStorage: options.parentServices.authStorage,
			settingsManager: options.parentServices.settingsManager,
			modelRegistry: options.parentServices.modelRegistry,
			depth: childDepth,
		},
		sessionStartEvent: { type: "session_start", reason: "startup", forkMetadata: options.task.forkMetadata },
		// Tag the session-level source so non-input hooks (session_start,
		// session_shutdown, turn_end, tool_call/tool_result, memory_note tool
		// execution) can gate on `ctx.source === "child-agent"`. The per-turn
		// `source: "child-agent"` passed to `session.prompt` below covers
		// input/before_agent_start independently.
		source: "child-agent",
	});

	if (policy.includeTranscript) {
		session.state.messages = getFilteredForkMessages(options.parentSessionManager);
	}

	// System-prompt override priority:
	//   1. Task-level `systemPrompt` (explicit caller-supplied bytes)
	//   2. Fork-mode parentSystemPrompt (cache-share with parent's API request)
	//   3. Stable-profile agent prompt when running with context:"none"
	//      (cross-session/cross-cwd byte stability)
	//   4. Otherwise: keep the freshly-built prompt from session creation.
	// Must run after session creation (which builds a fresh prompt) and after
	// message assignment (order doesn't matter for the prompt).
	if (options.task.systemPrompt) {
		session.overrideBaseSystemPrompt(options.task.systemPrompt);
	} else if (isForkMode && options.parentSystemPrompt) {
		session.overrideBaseSystemPrompt(options.parentSystemPrompt);
	} else if (agent.cacheProfile === "stable" && policy.mode === "none") {
		session.overrideBaseSystemPrompt(buildAgentSystemAppend(agent));
	}

	// Hard turn cap for this child run (e.g. bounded extractor forks). Set on the
	// engine Agent before driving — the loop reads it via createLoopConfig.
	if (options.task.maxTurns !== undefined && options.task.maxTurns > 0) {
		session.agent.maxTurns = options.task.maxTurns;
	}

	details.loadedSkills = childServices.resourceLoader.getSkills().skills.map((skill) => skill.name);

	return driveChildSession(session, {
		...options,
		details,
		startedAt,
		prompt: buildChildTaskPrompt(options.task, {
			canDelegate: childCanDelegate,
			remaining: childCanDelegate ? maxDelegationDepth - childDepth : 0,
		}),
	});
}

// Cap result text we inline into the completion notification. The full text is
// always available on disk via `outputPaths` / `sessionPaths`; the message is a
// summary, not the full payload.
const BACKGROUND_RESULT_PREVIEW_CHARS = 4000;

function truncatePreview(text: string | undefined, limit: number): string | undefined {
	if (!text) return undefined;
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit - 1)}\u2026`;
}

function buildBackgroundCompletion(run: AgentRecentRun): AgentBackgroundCompletion {
	const totalTokens = run.runs.reduce((sum, child) => {
		const t = (child.usage as { totalTokens?: number } | undefined)?.totalTokens;
		return typeof t === "number" ? sum + t : sum;
	}, 0);
	const toolCallCount = run.runs.reduce((sum, child) => sum + (child.toolCallCount ?? 0), 0);
	const firstFinal = run.runs.find(
		(child) => typeof child.finalOutput === "string" && child.finalOutput.length > 0,
	)?.finalOutput;
	const summary =
		run.status === "completed"
			? `Background agent ${run.id} (${run.agents.join(", ")}) completed`
			: run.status === "failed"
				? `Background agent ${run.id} failed: ${run.error || "unknown error"}`
				: run.status === "cancelled"
					? `Background agent ${run.id} was cancelled`
					: run.status === "interrupted"
						? `Background agent ${run.id} was interrupted`
						: `Background agent ${run.id} reached status ${run.status}`;
	return {
		runId: run.id,
		status: run.status,
		mode: run.mode,
		agents: [...run.agents],
		tasks: [...run.tasks],
		summary,
		result: truncatePreview(firstFinal, BACKGROUND_RESULT_PREVIEW_CHARS),
		outputPaths: [...run.outputPaths],
		sessionPaths: run.sessionRefs.map((ref) => ref.sessionPath).filter((path): path is string => Boolean(path)),
		error: run.error,
		durationMs: run.durationMs,
		totalTokens: totalTokens > 0 ? totalTokens : undefined,
		toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
	};
}

function emitProgress(
	input: AgentToolExecutionInput,
	runs: AgentRunDetails[],
	onProgress?: (progress: AgentExecutionProgress) => void,
): void {
	onProgress?.({
		mode: input.mode,
		status: runs.some((run) => run.status === "failed")
			? "failed"
			: runs.some((run) => run.status === "cancelled")
				? "cancelled"
				: runs.some((run) => run.status === "interrupted")
					? "interrupted"
					: runs.every((run) => run.status === "completed")
						? "completed"
						: "running",
		runs: [...runs],
		concurrency: input.concurrency,
		chainDir: input.chainDir,
	});
}

async function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	run: (item: T, index: number) => Promise<AgentRunDetails>,
): Promise<{ results: AgentRunDetails[]; errors: unknown[] }> {
	const results: Array<AgentRunDetails | undefined> = new Array(items.length);
	const errors: unknown[] = [];
	let nextIndex = 0;
	const workerCount = Math.min(concurrency, items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			try {
				results[index] = await run(items[index], index);
			} catch (error) {
				errors.push(error);
				const details = getErrorDetails(error);
				if (details) results[index] = details;
			}
		}
	});
	await Promise.all(workers);
	return { results: results.filter((result): result is AgentRunDetails => Boolean(result)), errors };
}

function getErrorDetails(error: unknown): AgentRunDetails | undefined {
	if (error && typeof error === "object" && "details" in error) {
		return (error as { details?: AgentRunDetails }).details;
	}
	return undefined;
}

async function resumeSingleBackgroundRun(
	input: AgentToolExecutionInput,
	options: AgentExecutorOptions,
	recentRun: AgentRecentRun,
	expectedGeneration: number,
	prompt?: string,
): Promise<AgentToolDetails> {
	if (input.mode !== "single") throw new Error("Only single background agent runs can be resumed");
	const previousRun = recentRun.runs[0];
	if (!previousRun?.sessionPath) throw new Error(`${recentRun.id} has no child session path to resume`);
	if (!existsSync(previousRun.sessionPath)) {
		throw new Error(`${recentRun.id} child session path no longer exists: ${previousRun.sessionPath}`);
	}

	const registry = await loadAgentRegistry({ cwd: options.parentServices.cwd, agentScope: input.agentScope });
	const originalTask = input.tasks[0];
	const definition = findAgentDefinition(registry, originalTask.agent);
	const task = normalizeTask(originalTask, input, definition);
	const agent = findAgentDefinition(registry, task.agent);
	if (!agent) {
		throw new Error(`Unknown agent "${task.agent}". Available agents: ${formatAvailableAgents(registry)}`);
	}

	const agentDefaults = resolveAgentDefaults({
		parentModel: options.parentModel,
		settingsManager: options.parentServices.settingsManager,
	});
	const model = resolveAgentModel({
		modelReference: task.model,
		agent,
		defaults: agentDefaults,
		parentModel: options.parentModel,
		modelRegistry: options.parentServices.modelRegistry,
	});
	const thinking = resolveAgentThinking({
		taskThinking: task.thinking,
		toolThinking: input.thinking,
		agent,
		defaults: agentDefaults,
		parentThinkingLevel: options.parentThinkingLevel,
		model,
	});
	const callerDepth = options.parentServices.depth ?? 0;
	const maxDelegationDepth = getMaxDelegationDepth(options.parentServices.settingsManager);
	const childDepth = callerDepth + 1;
	const childCanDelegate = canDelegateAtDepth(childDepth, maxDelegationDepth);
	const { effectiveTools, deniedTools } = resolveEffectiveTools({
		parentActiveTools: options.parentActiveTools,
		agent,
		requestedTools: task.tools,
		allowAgentDelegation: childCanDelegate,
	});
	const startedAt = Date.now();
	const details = createInitialRunDetails({
		agent,
		task,
		effectiveTools,
		deniedTools,
		model,
		thinking,
		startedAt,
	});
	const policy = details.context;
	const childServices = await createAgentSessionServices({
		cwd: options.parentServices.cwd,
		agentDir: options.parentServices.agentDir,
		authStorage: options.parentServices.authStorage,
		settingsManager: options.parentServices.settingsManager,
		modelRegistry: options.parentServices.modelRegistry,
		resourceLoaderOptions: getChildResourceLoaderOptions(policy, agent),
	});
	const childSessionManager = SessionManager.open(previousRun.sessionPath);
	details.sessionId = childSessionManager.getSessionId();
	details.sessionPath = childSessionManager.getSessionFile();
	const { session } = await createAgentSessionFromServices({
		services: childServices,
		sessionManager: childSessionManager,
		model,
		thinkingLevel: thinking,
		tools: effectiveTools,
		agentToolServices: {
			cwd: options.parentServices.cwd,
			agentDir: options.parentServices.agentDir,
			authStorage: options.parentServices.authStorage,
			settingsManager: options.parentServices.settingsManager,
			modelRegistry: options.parentServices.modelRegistry,
			depth: childDepth,
		},
		sessionStartEvent: {
			type: "session_start",
			reason: "resume",
			previousSessionFile: options.parentSessionManager.getSessionFile(),
			forkMetadata: task.forkMetadata,
		},
		source: "child-agent",
	});
	details.loadedSkills = childServices.resourceLoader.getSkills().skills.map((skill) => skill.name);

	const runs: AgentRunDetails[] = [details];
	const resumePrompt =
		prompt?.trim() ||
		"Continue the interrupted delegated task from where you left off. Return the final report when done.";

	try {
		await driveChildSession(session, {
			...options,
			task,
			chainDir: input.chainDir,
			progressInput: input,
			progressRuns: runs,
			details,
			startedAt,
			prompt: resumePrompt,
			taskId: recentRun.id,
		});
	} catch (error) {
		const failed = getErrorDetails(error);
		if (!failed) {
			failAgentRecentRun(recentRun, error, expectedGeneration);
			throw error;
		}
		const failedDetails: AgentToolDetails = {
			mode: input.mode,
			status: failed.status === "cancelled" || failed.status === "interrupted" ? failed.status : "failed",
			runs,
			runId: recentRun.id,
			background: true,
			chainDir: input.chainDir,
		};
		finishAgentRecentRun(recentRun, failedDetails, expectedGeneration);
		return failedDetails;
	}

	const completedDetails: AgentToolDetails = {
		mode: input.mode,
		status: "completed",
		runs,
		runId: recentRun.id,
		background: true,
		chainDir: input.chainDir,
	};
	finishAgentRecentRun(recentRun, completedDetails, expectedGeneration);
	return completedDetails;
}

async function executeAgentToolToCompletion(
	input: AgentToolExecutionInput,
	options: AgentExecutorOptions,
	recentRun: AgentRecentRun,
	expectedGeneration = getAgentRecentRunGeneration(recentRun),
): Promise<AgentToolDetails> {
	const registry = await loadAgentRegistry({ cwd: options.parentServices.cwd, agentScope: input.agentScope });
	const runs: AgentRunDetails[] = [];
	const concurrency = Math.max(1, Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY));
	if (input.mode === "parallel" && input.tasks.length > MAX_PARALLEL_TASKS) {
		throw new Error(`Parallel agent mode supports at most ${MAX_PARALLEL_TASKS} tasks`);
	}

	const makeTask = (task: AgentTaskConfig): NormalizedAgentTaskConfig => {
		const definition = findAgentDefinition(registry, task.agent);
		return normalizeTask(task, input, definition);
	};

	try {
		if (input.mode === "chain") {
			let previous = "";
			for (const task of input.tasks) {
				const normalized = makeTask({ ...task, task: task.task.replaceAll("{previous}", previous) });
				const result = await runChild({
					...options,
					registry,
					task: normalized,
					toolThinking: input.thinking,
					chainDir: input.chainDir,
					progressInput: input,
					progressRuns: runs,
					taskId: recentRun.id,
				});
				if (!runs.includes(result)) runs.push(result);
				previous = result.rawOutput ?? result.finalOutput ?? "";
				emitProgress(input, runs, options.onProgress);
			}
		} else if (input.mode === "parallel") {
			const normalizedTasks = input.tasks.map(makeTask);
			const { results, errors } = await mapWithConcurrency(normalizedTasks, concurrency, async (task) => {
				const result = await runChild({
					...options,
					registry,
					task,
					toolThinking: input.thinking,
					chainDir: input.chainDir,
					progressInput: input,
					progressRuns: runs,
					taskId: recentRun.id,
				});
				if (!runs.includes(result)) runs.push(result);
				emitProgress(input, runs, options.onProgress);
				return result;
			});
			runs.splice(0, runs.length, ...results);
			if (errors.length > 0) throw errors[0];
		} else {
			const result = await runChild({
				...options,
				registry,
				task: makeTask(input.tasks[0]),
				toolThinking: input.thinking,
				chainDir: input.chainDir,
				progressInput: input,
				progressRuns: runs,
				taskId: recentRun.id,
			});
			if (!runs.includes(result)) runs.push(result);
			emitProgress(input, runs, options.onProgress);
		}
	} catch (error) {
		const details = getErrorDetails(error);
		if (!details) {
			if (options.signal?.aborted) {
				const abortedDetails: AgentToolDetails = {
					mode: input.mode,
					status: getAbortedRunStatus(options),
					runs,
					runId: recentRun.id,
					background: input.background === true,
					concurrency,
					chainDir: input.chainDir,
				};
				finishAgentRecentRun(recentRun, abortedDetails, expectedGeneration);
				return abortedDetails;
			}
			failAgentRecentRun(recentRun, error, expectedGeneration);
			throw error;
		}
		if (!runs.includes(details)) runs.push(details);
		const failedDetails: AgentToolDetails = {
			mode: input.mode,
			status: details.status === "cancelled" || details.status === "interrupted" ? details.status : "failed",
			runs,
			runId: recentRun.id,
			background: input.background === true,
			concurrency,
			chainDir: input.chainDir,
		};
		finishAgentRecentRun(recentRun, failedDetails, expectedGeneration);
		return failedDetails;
	}

	const completedDetails: AgentToolDetails = {
		mode: input.mode,
		status: "completed",
		runs,
		runId: recentRun.id,
		background: input.background === true,
		concurrency: input.mode === "parallel" ? concurrency : undefined,
		chainDir: input.chainDir,
	};
	finishAgentRecentRun(recentRun, completedDetails, expectedGeneration);
	return completedDetails;
}

export async function executeAgentTool(
	input: AgentToolExecutionInput,
	options: AgentExecutorOptions,
): Promise<AgentToolDetails> {
	// Hard nested-delegation boundary. The caller's depth lives on its own agent-tool
	// services; top-level = 0 (always allowed). This is mode-agnostic (covers fork
	// children whose inherited tool list still carries the `agent` schema).
	const callerDepth = options.parentServices.depth ?? 0;
	const delegationCap = getMaxDelegationDepth(options.parentServices.settingsManager);
	if (!canDelegateAtDepth(callerDepth, delegationCap)) {
		throw new Error(
			`Nested agent delegation is not permitted at depth ${callerDepth} ` +
				`(subagents.maxDelegationDepth = ${delegationCap}). Complete this sub-task yourself and report back.`,
		);
	}
	const recentRun = startAgentRecentRun(input.mode, input.tasks, { background: input.background });
	if (!input.background) return executeAgentToolToCompletion(input, options, recentRun);

	let abortController = new AbortController();
	let abortStatus: AgentToolStatus | undefined;
	let activeRunPromise: Promise<void> = Promise.resolve();
	let lastActivityAt = Date.now();
	let monitor: NodeJS.Timeout | undefined;
	const activeSessions = new Set<AgentSession>();
	const touchActivity = () => {
		lastActivityAt = Date.now();
	};
	const stopMonitor = () => {
		if (monitor) clearInterval(monitor);
		monitor = undefined;
	};
	const startMonitor = (generation: number) => {
		stopMonitor();
		touchActivity();
		monitor = setInterval(() => {
			if (getAgentRecentRunGeneration(recentRun) !== generation || recentRun.status !== "running") {
				stopMonitor();
				return;
			}
			const staleMs = Date.now() - lastActivityAt;
			if (staleMs >= BACKGROUND_STALE_PROGRESS_MS) {
				markAgentRecentRunNeedsAttention(
					recentRun,
					`No child progress for ${formatAgentDurationMs(staleMs)}; inspect or stop it with /agents runs`,
				);
			}
		}, BACKGROUND_MONITOR_INTERVAL_MS);
	};
	const makeBackgroundOptions = (generation: number): AgentExecutorOptions => ({
		...options,
		signal: abortController.signal,
		abortStatus: () => abortStatus,
		onProgress: (progress) => {
			touchActivity();
			updateAgentRecentRunProgress(recentRun, progress, generation);
		},
		onChildSessionStart: (session, details) => {
			touchActivity();
			activeSessions.add(session);
			options.onChildSessionStart?.(session, details);
		},
		onChildSessionEnd: (session, details) => {
			touchActivity();
			activeSessions.delete(session);
			options.onChildSessionEnd?.(session, details);
		},
	});
	const abortActiveSessions = () => {
		for (const session of activeSessions) {
			session.abortBash();
			void session.abort().catch(() => {});
		}
	};
	const launch = (run: (generation: number) => Promise<AgentToolDetails>) => {
		const generation = getAgentRecentRunGeneration(recentRun);
		startMonitor(generation);
		activeRunPromise = run(generation)
			.then(
				() => {},
				(error) => {
					failAgentRecentRun(recentRun, error, generation);
				},
			)
			.finally(() => {
				if (getAgentRecentRunGeneration(recentRun) === generation) stopMonitor();
			});
	};

	if (options.onBackgroundTerminal) {
		const notify = options.onBackgroundTerminal;
		attachAgentRecentRunTerminalListener(recentRun.id, (run) => {
			notify(buildBackgroundCompletion(run));
		});
	}

	attachAgentRecentRunController(recentRun.id, {
		interrupt: async () => {
			abortStatus = "interrupted";
			abortActiveSessions();
			abortController.abort();
			await activeRunPromise;
		},
		cancel: async () => {
			abortStatus = "cancelled";
			abortActiveSessions();
			abortController.abort();
			await activeRunPromise;
		},
		resume: async (prompt) => {
			await activeRunPromise;
			abortController = new AbortController();
			abortStatus = undefined;
			restartAgentRecentRun(recentRun);
			launch((generation) =>
				resumeSingleBackgroundRun(input, makeBackgroundOptions(generation), recentRun, generation, prompt),
			);
		},
		inject: async (message) => {
			const sessions = [...activeSessions];
			if (sessions.length === 0) throw new Error("No active child session to receive input");
			await Promise.all(sessions.map((session) => session.steer(message)));
		},
	});

	launch((generation) =>
		executeAgentToolToCompletion(input, makeBackgroundOptions(generation), recentRun, generation),
	);
	return {
		mode: input.mode,
		status: "running",
		runs: [],
		runId: recentRun.id,
		background: true,
		message: `Background agent run ${recentRun.id} started. Use /agents-status ${recentRun.id} for details.`,
		concurrency:
			input.mode === "parallel"
				? Math.max(1, Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY))
				: undefined,
		chainDir: input.chainDir,
	};
}
