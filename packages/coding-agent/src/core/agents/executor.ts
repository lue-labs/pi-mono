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
import { normalizeAutoAliasString, parseModelPattern, tierModelCandidatesForParent } from "../model-resolver.ts";
import { type ReadonlySessionManager, SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { appendTaskMessage, type TaskMessageEvent } from "../tasks/messages.ts";
import { EXPLORE_BASH_POLICY, runWithBashPolicy } from "../tools/bash.ts";
import {
	buildAgentCourseCorrectionPrompt,
	buildAgentSystemAppend,
	buildChildTaskPrompt,
	clampThinkingForModel,
	formatModelForDetails,
	getChildResourceLoaderOptions,
	getFilteredForkMessages,
	resolveContextPolicy,
} from "./context.ts";
import { registerLiveSession, registerLiveSessionAlias, unregisterLiveSession } from "./live-sessions.ts";
import { writeAgentOutput } from "./output.ts";
import { findAgentDefinition, formatAvailableAgents, loadAgentRegistry } from "./registry.ts";
import type { AgentRecentRun, AgentRecentRunController } from "./status.ts";
import {
	agentRunUiStatus,
	attachAgentRecentRunController,
	attachAgentRecentRunMemberController,
	attachAgentRecentRunTerminalListener,
	detachAgentRecentRunMemberController,
	failAgentRecentRun,
	finishAgentRecentRun,
	formatAgentDurationMs,
	getAgentRecentRunGeneration,
	markAgentRecentRunBackgrounded,
	markAgentRecentRunMemberNeedsAttention,
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

// Tools globally denied to every Agent task regardless of depth. `agent` is not
// here: effective-tool resolution and the configured depth cap decide whether it
// is exposed, and executeAgentTool enforces the cap again at call time.
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
	/**
	 * Run id of the AgentRecentRun that spawned the session owning these services.
	 * Threaded so a nested delegation can link its own run back to its parent run
	 * for tree-structured visibility in the agents view. Undefined at top level.
	 */
	parentRunId?: string;
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
	/** A real child-session handle, scoped to its stable member id. */
	onMemberController?: (details: AgentRunDetails, controller: AgentRecentRunController) => void;
	onChildProviderRetry?: (event: { details: AgentRunDetails; activity: string }) => void;
	/**
	 * Fired exactly once when a background run reaches a terminal status or a
	 * persistent run intentionally parks between turns. Only wired by the
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
	/**
	 * Keep a single background run alive across turns. When set, the run parks
	 * (status "interrupted", controller + resumable session retained) after each
	 * turn instead of terminating, so the launcher can feed the next turn via
	 * `handle.resume()`. The persisted child session is reloaded on resume, so
	 * conversation history accumulates across turns. Only meaningful for
	 * `mode:"single"` background runs; ignored otherwise. Default (unset) keeps
	 * the prior terminate-on-completion behaviour.
	 */
	persistent?: boolean;
}

/**
 * A persistent background fork parks between turns rather than terminating.
 * "interrupted" is the only non-running status that preserves the run's live
 * controller and marks it resumable (see status.ts `applyRunDetails` /
 * `canResumeRun`), which is exactly what a long-lived launcher-fed agent needs.
 */
function isPersistentPark(input: AgentToolExecutionInput): boolean {
	return input.persistent === true && input.background === true && input.mode === "single";
}

interface RunChildOptions extends AgentExecutorOptions {
	registry: AgentRegistry;
	task: NormalizedAgentTaskConfig;
	memberId: string;
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
 * so lowercasing makes case aliases of the same capability resolve to each
 * other. Native legacy `Task` is the same delegation capability as `agent` /
 * `Agent`, so it shares their allow/deny and depth enforcement. Without this
 * canonicalization the allow-list intersection can be empty, or an alias can
 * bypass a capability restriction.
 */
function canonicalToolName(name: string): string {
	const canonical = name.toLowerCase();
	return canonical === "task" ? "agent" : canonical;
}

function forkBypassesProfileTools(agent: AgentDefinition): boolean {
	const hasAllowList = agent.tools !== undefined && agent.tools !== "*";
	const deniesNonAgentTool = agent.denyTools?.some((tool) => canonicalToolName(tool) !== "agent") ?? false;
	return hasAllowList || deniesNonAgentTool;
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

	// Agent definitions are child-scoped allow-lists. Resolve names to a parent
	// alias when one is active, but preserve declared names that are not active in
	// the parent: createAgentSession can register matching deferred/extension tools
	// inside the child and safely ignores names that are unavailable there.
	const agentTools = options.agent.tools ?? "*";
	let candidates: string[];
	if (requested) {
		candidates = requested.map((tool) => parentByCanonical.get(canonicalToolName(tool)) ?? tool);
		if (agentTools !== "*") {
			const allowed = new Set(agentTools.map(canonicalToolName));
			candidates = candidates.filter((tool) => allowed.has(canonicalToolName(tool)));
		}
	} else {
		const declared = agentTools === "*" ? options.parentActiveTools : agentTools;
		candidates = declared.map((tool) => parentByCanonical.get(canonicalToolName(tool)) ?? tool);
	}

	const deny = new Set(
		[
			...(options.agent.denyTools ?? []),
			...GLOBAL_DENY_TOOLS,
			...(options.allowAgentDelegation ? [] : ["agent"]),
		].map(canonicalToolName),
	);
	const isDenied = (tool: string): boolean => deny.has(canonicalToolName(tool));
	const effectiveTools = candidates.filter((tool) => !isDenied(tool));
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

function resolveAgentModelReference(options: {
	modelReference?: string;
	agent: AgentDefinition;
	defaults?: AgentDefaultSelection;
}): string | undefined {
	const defaultRef =
		options.defaults?.model && options.defaults.model !== "inherit" ? options.defaults.model : undefined;
	return (
		options.modelReference ??
		(options.agent.model && options.agent.model !== "inherit" ? options.agent.model : undefined) ??
		defaultRef
	);
}

function normalizeAgentAutoModelAlias(reference: string | undefined): string | undefined {
	return normalizeAutoAliasString("clawrouter", reference);
}

function isAutoModelAlias(reference: string | undefined): boolean {
	return normalizeAgentAutoModelAlias(reference) !== undefined;
}

type AgentTierAlias = "fast" | "medium" | "frontier" | "ultra";

function parseTierAlias(reference: string): { tier: AgentTierAlias; provider?: string } | undefined {
	const normalized = reference.trim().toLowerCase();
	if (normalized === "fast" || normalized === "medium" || normalized === "frontier" || normalized === "ultra") {
		return { tier: normalized };
	}
	const separator = normalized.indexOf("/");
	if (separator === -1) return undefined;
	const provider = normalized.slice(0, separator);
	const tier = normalized.slice(separator + 1);
	if (tier === "fast" || tier === "medium" || tier === "frontier" || tier === "ultra") {
		return { tier, provider };
	}
	return undefined;
}

const FRONTIER_MODEL_ID_PATTERN = /(?:opus|fable|-pro$|-max$|gpt-5\.5|gpt-5\.6(?!-luna))/i;

function warnIfFastAgentUsesExpensiveModel(options: {
	reference: string;
	agent: AgentDefinition;
	model: Model<Api> | undefined;
	parentModel: Model<Api> | undefined;
	fellBack: boolean;
	onWarning?: (warning: string) => void;
}): void {
	if (options.reference !== "fast" || !options.model) return;
	const frontier = FRONTIER_MODEL_ID_PATTERN.test(options.model.id);
	const parent = Boolean(
		options.parentModel &&
			options.model.provider === options.parentModel.provider &&
			options.model.id === options.parentModel.id,
	);
	if (!options.fellBack && !frontier && !parent) return;
	const modelKind = frontier ? "frontier" : parent ? "parent" : "fallback";
	const label = `${options.model.provider}/${options.model.id}`;
	options.onWarning?.(
		`Warning: ${options.agent.id} running on ${modelKind} model ${label} for fast alias — add a fast-tier mapping for this provider or pass an explicit cheap model`,
	);
}

function resolveTierAliasModel(
	tierAlias: { tier: AgentTierAlias; provider?: string },
	options: { parentModel: Model<Api> | undefined; modelRegistry: ModelRegistry },
): Model<Api> | undefined {
	const parentProvider = options.parentModel?.provider;
	const provider = tierAlias.provider ?? parentProvider;
	const candidateIds = tierModelCandidatesForParent({
		reference: tierAlias.tier,
		parentProvider: provider,
		parentModelId: provider === parentProvider ? options.parentModel?.id : undefined,
	});
	if (candidateIds.length === 0) return undefined;
	const available = options.modelRegistry.getAvailable();
	return candidateIds
		.map((id) => available.find((m) => m.provider === provider && m.id === id))
		.find((model): model is Model<Api> => Boolean(model));
}

export function resolveAgentModel(options: {
	modelReference?: string;
	agent: AgentDefinition;
	defaults?: AgentDefaultSelection;
	parentModel: Model<Api> | undefined;
	modelRegistry: ModelRegistry;
	onWarning?: (warning: string) => void;
}): Model<Api> | undefined {
	// Precedence: explicit task option > agent frontmatter > settings.subagents (provider override > defaults) > parent inheritance.
	const reference = resolveAgentModelReference(options);
	if (!reference) return options.parentModel;

	// Auto aliases are routed per-prompt by the `model:resolve` filter (semantic
	// router): runChild forwards them as requestedModel + routingMetadata into the
	// child session. The model returned here is only the concrete fallback used
	// when the router is unavailable — prefer the family-aware medium tier over
	// silently inheriting an expensive frontier parent.
	if (isAutoModelAlias(reference)) {
		return resolveTierAliasModel({ tier: "medium" }, options) ?? options.parentModel;
	}

	// Tier aliases resolve to the parent provider's mapped tier. `fast` is used by
	// read-only `explore`; `medium` is for normal subagents; `frontier`/`ultra` are
	// explicit opt-ins. Mixed proxy providers (e.g. `clawrouter`) prefer the
	// parent model family before falling back to the provider's tier candidates.
	const tierAlias = parseTierAlias(reference);
	if (tierAlias) {
		const hit = resolveTierAliasModel(tierAlias, options);
		warnIfFastAgentUsesExpensiveModel({
			reference: tierAlias.tier,
			agent: options.agent,
			model: hit ?? options.parentModel,
			parentModel: options.parentModel,
			fellBack: !hit,
			onWarning: options.onWarning,
		});
		return hit ?? options.parentModel;
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

function extractModelRoutingWarnings(messages: readonly { role: string; content?: unknown }[]): string[] {
	const warnings: string[] = [];
	for (const message of messages) {
		const custom = message as { role: string; customType?: string; content?: unknown };
		if (custom.role !== "custom" || custom.customType !== "model-routing-warning") continue;
		if (typeof custom.content === "string" && custom.content.length > 0) warnings.push(custom.content);
	}
	return warnings;
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

function buildChildRoutingMetadata(options: {
	agent: AgentDefinition;
	task: NormalizedAgentTaskConfig;
	childPrompt: string;
	childCwd: string;
	effectiveTools: string[];
	deniedTools: string[];
}): Record<string, unknown> {
	const promptText = [options.task.task, options.task.extraContext]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join("\n\n");
	return {
		source: "child-agent",
		appMode: "agent",
		agentId: options.agent.id,
		agentDescription: options.agent.description,
		agentSource: options.agent.source,
		contextMode: options.task.context,
		promptPreview: promptText.slice(0, 6000),
		promptLength: promptText.length,
		childPromptPreview: options.childPrompt.slice(0, 6000),
		childPromptLength: options.childPrompt.length,
		taskDescription: options.task.description,
		hasExtraContext: Boolean(options.task.extraContext),
		toolCount: options.effectiveTools.length,
		deniedToolCount: options.deniedTools.length,
		cwd: options.childCwd,
		cliMessageCount: 1,
		fileArgCount: 0,
	};
}

function createInitialRunDetails(options: {
	memberId: string;
	agent: AgentDefinition;
	task: NormalizedAgentTaskConfig;
	effectiveTools: string[];
	deniedTools: string[];
	model: Model<Api> | undefined;
	thinking: ThinkingLevel;
	warnings?: string[];
	startedAt: number;
}): AgentRunDetails {
	return {
		memberId: options.memberId,
		agent: options.agent.id,
		source: options.agent.source,
		task: options.task.task,
		description: options.task.description,
		status: "running",
		startedAt: options.startedAt,
		context: resolveContextPolicy(options.task.context),
		model: formatModelForDetails(options.model),
		thinking: options.thinking,
		warnings: options.warnings && options.warnings.length > 0 ? [...options.warnings] : undefined,
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

function appendRunActivitySnippet(details: AgentRunDetails, text: string, maxLength = 200): boolean {
	const snippet = previewValue(text, maxLength);
	if (!snippet || snippet === details.recentOutputSnippets[details.recentOutputSnippets.length - 1]) return false;
	details.recentOutputSnippets.push(snippet);
	details.recentOutputSnippets = details.recentOutputSnippets.slice(-5);
	return true;
}

function isRateLimitRetryText(text: string): boolean {
	return /\b429\b|rate.?limit|too many requests|overloaded/i.test(text);
}

function formatAutoRetryActivity(event: {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}): string {
	const kind = isRateLimitRetryText(event.errorMessage) ? "Rate limited/overloaded" : "Provider retry";
	const error = previewValue(event.errorMessage, 120) ?? "unknown error";
	return `${kind}; auto-retry ${event.attempt}/${event.maxAttempts} in ${formatAgentDurationMs(event.delayMs)}: ${error}`;
}

function formatAutoRetryFailure(event: { attempt: number; finalError?: string }): string {
	const error = previewValue(event.finalError ?? "unknown error", 120) ?? "unknown error";
	return `Provider retry failed after ${event.attempt} attempts: ${error}`;
}

function getLastCompletedAssistantMessage(messages: readonly AssistantMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error") {
			return message;
		}
	}
	return undefined;
}

function getLastAssistantUsage(messages: readonly AssistantMessage[]): Usage | undefined {
	return getLastCompletedAssistantMessage(messages)?.usage;
}

function getLastAssistantModelDetails(
	messages: readonly AssistantMessage[],
): { provider: string; id: string } | undefined {
	const message = getLastCompletedAssistantMessage(messages);
	if (!message) return undefined;
	return { provider: message.provider, id: message.responseModel ?? message.model };
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
	const messages = session.messages as AssistantMessage[];
	details.durationMs = Date.now() - startedAt;
	details.messageCount = session.messages.length;
	details.usage = getLastAssistantUsage(messages);
	details.model = getLastAssistantModelDetails(messages) ?? details.model;
}

interface DriveChildSessionOptions extends AgentExecutorOptions {
	task: NormalizedAgentTaskConfig;
	chainDir?: string;
	progressInput: AgentToolExecutionInput;
	progressRuns: AgentRunDetails[];
	details: AgentRunDetails;
	startedAt: number;
	prompt: string;
	/** Aggregate AgentRecentRun id for telemetry and the single-member live-session alias. */
	taskId?: string;
	memberAbort?: { signal: AbortSignal; status: () => "cancelled" | "interrupted" | undefined };
}

function getAbortedRunStatus(
	options: Pick<DriveChildSessionOptions, "abortStatus" | "memberAbort">,
): "cancelled" | "interrupted" {
	return options.memberAbort?.status() === "interrupted" || options.abortStatus?.() === "interrupted"
		? "interrupted"
		: "cancelled";
}

function findNeedsInputReason(content: unknown): string | undefined {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((part): part is TextContent =>
							Boolean(part && typeof part === "object" && part.type === "text"),
						)
						.map((part) => part.text)
						.join("\n")
				: "";
	const lines = text.split("\n");
	let lastNonblank = lines.length - 1;
	while (lastNonblank >= 0 && !lines[lastNonblank]?.trim()) lastNonblank -= 1;
	let fence: { marker: "`" | "~"; length: number } | undefined;
	for (const [index, line] of lines.entries()) {
		const fenceMatch = /^[ \t]*(`{3,}|~{3,})/.exec(line);
		if (fenceMatch?.[1]) {
			const marker = fenceMatch[1][0] as "`" | "~";
			if (!fence) fence = { marker, length: fenceMatch[1].length };
			else if (marker === fence.marker && fenceMatch[1].length >= fence.length) fence = undefined;
			continue;
		}
		if (fence || /^[ \t]*>/.test(line) || index !== lastNonblank) continue;
		const match = /^[ \t]*needs input:[ \t]*(\S.*?)[ \t]*$/i.exec(line);
		if (match?.[1]) return match[1].trim();
	}
	return undefined;
}

function appendAgentTaskMessage(
	memberId: string | undefined,
	runId: string | undefined,
	event: TaskMessageEvent,
): void {
	if (memberId) appendTaskMessage(memberId, event);
	if (runId && runId !== memberId) appendTaskMessage(runId, event);
}

function createMemberSessionControl(
	session: AgentSession,
	memberId: string,
	runId?: string,
): {
	controller: AgentRecentRunController;
	memberAbort: { signal: AbortSignal; status: () => "cancelled" | "interrupted" | undefined };
} {
	let memberAbortStatus: "cancelled" | "interrupted" | undefined;
	const memberAbort = new AbortController();
	return {
		controller: {
			interrupt: () => {
				memberAbortStatus = "interrupted";
				memberAbort.abort();
			},
			cancel: () => {
				memberAbortStatus = "cancelled";
				memberAbort.abort();
			},
			inject: async (message) => {
				await session.steer(message);
				appendAgentTaskMessage(memberId, runId, { kind: "user_injected", ts: Date.now(), text: message });
			},
		},
		memberAbort: { signal: memberAbort.signal, status: () => memberAbortStatus },
	};
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
	if (options.memberAbort && !options.memberAbort.signal.aborted) {
		options.memberAbort.signal.addEventListener("abort", abortChild, { once: true });
	}

	const memberId = details.memberId;
	if (memberId) registerLiveSession(memberId, session);
	if (memberId && options.taskId && options.progressInput.mode === "single") {
		registerLiveSessionAlias(options.taskId, memberId);
	}
	const unsubscribe = session.subscribe((event) => {
		let providerRetryActivity: string | undefined;
		if (!options.progressRuns.includes(details)) options.progressRuns.push(details);
		refreshRunDetailsFromSession(details, session, startedAt);
		if (event.type === "message_update" && event.message.role === "assistant") {
			const snippet = extractTextPreview(event.message.content, 200);
			if (snippet && appendRunActivitySnippet(details, snippet)) {
				appendAgentTaskMessage(memberId, options.taskId, { kind: "assistant_text", ts: Date.now(), text: snippet });
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			details.usage = event.message.usage;
			appendAgentTaskMessage(memberId, options.taskId, { kind: "assistant_end", ts: Date.now() });
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
			appendAgentTaskMessage(memberId, options.taskId, {
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
			appendAgentTaskMessage(memberId, options.taskId, {
				kind: "tool_end",
				ts: Date.now(),
				toolName: event.toolName,
				isError: event.isError,
				resultPreview: extractTextPreview(event.result.content, 200),
			});
		}
		if (event.type === "auto_retry_start") {
			const activity = formatAutoRetryActivity(event);
			providerRetryActivity = activity;
			details.currentToolName = undefined;
			details.currentToolArgsPreview = undefined;
			if (appendRunActivitySnippet(details, activity)) {
				appendAgentTaskMessage(memberId, options.taskId, {
					kind: "assistant_text",
					ts: Date.now(),
					text: activity,
				});
			}
		}
		if (event.type === "auto_retry_end" && !event.success) {
			const activity = formatAutoRetryFailure(event);
			if (appendRunActivitySnippet(details, activity)) {
				appendAgentTaskMessage(memberId, options.taskId, {
					kind: "assistant_text",
					ts: Date.now(),
					text: activity,
				});
			}
		}
		emitProgress(options.progressInput, options.progressRuns, options.onProgress);
		if (providerRetryActivity) options.onChildProviderRetry?.({ details, activity: providerRetryActivity });
	});

	try {
		if (options.signal?.aborted || options.memberAbort?.signal.aborted) {
			throw new Error(`Agent run ${getAbortedRunStatus(options)}`);
		}
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
		if (options.signal?.aborted || options.memberAbort?.signal.aborted) {
			throw new Error(`Agent run ${getAbortedRunStatus(options)}`);
		}
		const finalOutput = extractFinalAssistantText(session.messages);
		const inputReason = findNeedsInputReason(finalOutput);
		if (inputReason && options.progressInput.mode !== "single") {
			details.attentionReason = undefined;
			details.attentionMessage = undefined;
			throw new Error(
				`Agent ${options.progressInput.mode} mode cannot pause for human input; re-run this member as a single task. Question: ${inputReason}`,
			);
		}
		details.attentionReason = inputReason ? "user_input" : undefined;
		details.attentionMessage = inputReason;
		if (inputReason && details.memberId && options.taskId) {
			markAgentRecentRunMemberNeedsAttention(options.taskId, details.memberId, inputReason);
		}
		const output = await writeAgentOutput({
			cwd: options.parentServices.cwd,
			output: options.task.output,
			outputMode: options.task.outputMode,
			content: finalOutput,
			chainDir: options.chainDir,
		});
		details.status = inputReason ? "interrupted" : "completed";
		refreshRunDetailsFromSession(details, session, startedAt);
		// Lift child routing failures (auto alias, router unavailable / no decision)
		// into the parent-facing run warnings so the caller can judge the fallback
		// model and re-dispatch with an explicit provider/model override if wrong.
		const routingWarnings = extractModelRoutingWarnings(session.messages);
		if (routingWarnings.length > 0) {
			details.warnings = [
				...(details.warnings ?? []),
				...routingWarnings.map(
					(warning) =>
						`${warning} If this fallback model is wrong for the task, re-run the task with an explicit model override.`,
				),
			];
		}
		details.outputPath = output.outputPath;
		details.finalOutput = output.displayText;
		details.rawOutput = output.rawContent;
		return details;
	} catch (error) {
		details.status =
			options.signal?.aborted || options.memberAbort?.signal.aborted ? getAbortedRunStatus(options) : "failed";
		refreshRunDetailsFromSession(details, session, startedAt);
		details.error = error instanceof Error ? error.message : String(error);
		throw Object.assign(new Error(details.error), { details });
	} finally {
		if (memberId) unregisterLiveSession(memberId);
		if (options.signal) options.signal.removeEventListener("abort", abortChild);
		if (options.memberAbort) options.memberAbort.signal.removeEventListener("abort", abortChild);
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

	// Fork mode is a permissive self-fork: it inherits the parent's transcript,
	// model/thinking, and tools. When frozen parent system bytes are available we
	// also apply them below for a 1:1 cache-identity fork. Such a fork only reuses
	// the parent's warm prompt cache if it also runs on the parent's model +
	// thinking level, so the settings.subagents provider pin (the cheap model for
	// explore/general fan-out) must NOT apply here: dropping the resolved defaults
	// lets model/thinking fall through to the parent unless the caller passes an
	// explicit task-level override. Non-fork delegations (default/slim/none context)
	// keep the subagents defaults so they stay cheap. Without this, a configured
	// subagents model pin silently downgrades every context:"fork" caller
	// (pi-memory extraction, pi-recap, fusion, suggested-tasks) off the parent
	// model, cold-writing the whole inherited prefix on each run.
	const isForkMode = resolveContextPolicy(options.task.context).mode === "fork";
	const inheritedSystemPrompt = isForkMode ? options.parentSystemPrompt : undefined;
	const agentDefaults = isForkMode
		? undefined
		: resolveAgentDefaults({
				parentModel: options.parentModel,
				settingsManager: options.parentServices.settingsManager,
			});
	const selectedModelReference = resolveAgentModelReference({
		modelReference: options.task.model,
		agent,
		defaults: agentDefaults,
	});
	const requestedAutoModel = normalizeAgentAutoModelAlias(selectedModelReference);
	const warnings: string[] = [];
	if (isForkMode && forkBypassesProfileTools(agent)) {
		warnings.push(
			`context:"fork" is a permissive self-fork and does not apply the "${agent.id}" profile's ordinary tool allow/deny list; ` +
				`it preserves the caller's tools unless this task explicitly narrows them. Use context:"default" for filtered profile tools. ` +
				"Nested Agent access remains profile- and depth-capped.",
		);
	}
	const model = resolveAgentModel({
		modelReference: options.task.model,
		agent,
		defaults: agentDefaults,
		parentModel: options.parentModel,
		modelRegistry: options.parentServices.modelRegistry,
		onWarning: (warning) => warnings.push(warning),
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
	// Fork mode (isForkMode is computed above, where it also forces model/thinking
	// inheritance) governs tool inheritance too:
	// Use the parent's exact tool set by default, with no GLOBAL_DENY_TOOLS
	// filtering. An explicit task-level tools restriction intentionally narrows
	// the schema list and opts that call out of exact parent-prefix cache reuse.
	// Consequence: the `agent` schema can remain visible at the depth cap. The
	// trailing availability reminder states the effective capability, while
	// executeAgentTool enforces the cap at call time. Other modes also filter the
	// effective tools through the selected profile.
	// All other modes: standard agent-definition-based tool resolution.
	let effectiveTools: string[];
	let deniedTools: string[];
	// Nested-delegation gate: a task at `childDepth` may call Agent only while
	// under the configured cap and only when Agent survives effective-tool
	// resolution for the selected profile.
	const callerDepth = options.parentServices.depth ?? 0;
	const maxDelegationDepth = getMaxDelegationDepth(options.parentServices.settingsManager);
	const childDepth = callerDepth + 1;
	const childCanDelegate = canDelegateAtDepth(childDepth, maxDelegationDepth);
	const profileAllowsAgent = resolveEffectiveTools({
		parentActiveTools: options.parentActiveTools,
		agent,
		allowAgentDelegation: true,
	}).effectiveTools.some((tool) => canonicalToolName(tool) === "agent");
	if (isForkMode) {
		const requested = options.task.tools
			? new Set(options.task.tools.map((tool) => canonicalToolName(tool)))
			: undefined;
		effectiveTools = requested
			? options.parentActiveTools.filter((tool) => requested.has(canonicalToolName(tool)))
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
		memberId: options.memberId,
		agent,
		task: options.task,
		effectiveTools,
		deniedTools,
		model: effectiveModel,
		thinking,
		warnings,
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
	const taskCanDelegate =
		childCanDelegate && profileAllowsAgent && effectiveTools.some((tool) => canonicalToolName(tool) === "agent");
	const roleGuidance =
		agent.id !== "general" && (isForkMode || Boolean(options.task.systemPrompt))
			? { agent: agent.id, prompt: buildAgentSystemAppend(agent) }
			: undefined;
	const childPrompt = buildChildTaskPrompt(
		options.task,
		{
			canDelegate: taskCanDelegate,
			remaining: taskCanDelegate ? maxDelegationDepth - childDepth : 0,
		},
		roleGuidance,
	);
	const routingMetadata = requestedAutoModel
		? buildChildRoutingMetadata({
				agent,
				task: options.task,
				childPrompt,
				childCwd,
				effectiveTools,
				deniedTools,
			})
		: undefined;
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
	const { session, modelFallbackMessage, modelRoutingFailed } = await createAgentSessionFromServices({
		services: childServices,
		sessionManager: childSessionManager,
		model: effectiveModel,
		thinkingLevel: thinking,
		requestedModel: requestedAutoModel,
		routingMetadata,
		tools: effectiveTools,
		// Keep Agent schemas inherited by fork mode for cache identity, but bind the
		// execution engine only when both the selected profile and depth allow Agent.
		// The depth is threaded so nested calls are enforced again by executeAgentTool.
		disableAgentToolServices: !taskCanDelegate,
		agentToolServices: {
			cwd: childCwd,
			agentDir: options.parentServices.agentDir,
			authStorage: options.parentServices.authStorage,
			settingsManager: options.parentServices.settingsManager,
			modelRegistry: options.parentServices.modelRegistry,
			depth: childDepth,
			// Link this task's future delegations back to the run that spawned it.
			parentRunId: options.taskId,
		},
		// Telemetry identity: this run is `options.taskId`; its parent is the caller's
		// own run id (undefined at the top level). Lets observability exporters
		// correlate a sub-agent's spans and link them to the spawning run.
		agentRunIdentity: {
			runId: options.taskId,
			parentRunId: options.parentServices.parentRunId,
		},
		sessionStartEvent: { type: "session_start", reason: "startup", forkMetadata: options.task.forkMetadata },
		// Tag the session-level source so non-input hooks (session_start,
		// session_shutdown, turn_end, tool_call/tool_result, memory_note tool
		// execution) can gate on `ctx.source === "child-agent"`. The per-turn
		// `source: "child-agent"` passed to `session.prompt` below covers
		// input/before_agent_start independently.
		source: "child-agent",
	});
	details.model = formatModelForDetails(session.model ?? effectiveModel);
	details.thinking = session.thinkingLevel;
	// Surface child auto-routing notes in the parent-facing run warnings. Add
	// explicit re-dispatch advice only for true routing failures; successful
	// semantic-router selections should not look like fallback paths.
	if (requestedAutoModel && modelFallbackMessage) {
		const warning = modelRoutingFailed
			? `${modelFallbackMessage} If this fallback model is wrong for the task, re-run the task with an explicit model override.`
			: modelFallbackMessage;
		details.warnings = [...(details.warnings ?? []), warning];
	}

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
	} else if (inheritedSystemPrompt) {
		session.overrideBaseSystemPrompt(inheritedSystemPrompt);
	} else if (agent.cacheProfile === "stable" && policy.mode === "none") {
		session.overrideBaseSystemPrompt(buildAgentSystemAppend(agent));
	}

	// Hard turn cap for this child run (e.g. bounded extractor forks). Set on the
	// engine Agent before driving — the loop reads it via createLoopConfig.
	if (options.task.maxTurns !== undefined && options.task.maxTurns > 0) {
		session.agent.maxTurns = options.task.maxTurns;
	}

	details.loadedSkills = childServices.resourceLoader.getSkills().skills.map((skill) => skill.name);

	const memberControl = createMemberSessionControl(session, options.memberId, options.taskId);
	options.onMemberController?.(details, memberControl.controller);

	return driveChildSession(session, {
		...options,
		details,
		startedAt,
		prompt: childPrompt,
		memberAbort: memberControl.memberAbort,
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
	const status = agentRunUiStatus(run);
	const summary =
		status === "idle"
			? `Background agent ${run.id} is idle between persistent turns`
			: status === "completed"
				? `Background agent ${run.id} (${run.agents.join(", ")}) completed`
				: status === "failed"
					? `Background agent ${run.id} failed: ${run.error || "unknown error"}`
					: status === "cancelled"
						? `Background agent ${run.id} was cancelled`
						: status === "interrupted"
							? `Background agent ${run.id} was interrupted`
							: `Background agent ${run.id} reached status ${status}`;
	return {
		runId: run.id,
		status,
		parked: run.parked,
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
	const hasPendingWork = runs.length < input.tasks.length || runs.some((run) => run.status === "running");
	onProgress?.({
		mode: input.mode,
		status: hasPendingWork
			? "running"
			: runs.some((run) => run.status === "failed")
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

	// Resume must preserve the original fork contract just like initial dispatch:
	// parent model/thinking defaults and the canonical parent-tool subset. Frozen
	// system bytes are re-applied when available. Only the trailing course-correction
	// message changes.
	const isForkMode = resolveContextPolicy(task.context).mode === "fork";
	const inheritedSystemPrompt = isForkMode ? options.parentSystemPrompt : undefined;
	const agentDefaults = isForkMode
		? undefined
		: resolveAgentDefaults({
				parentModel: options.parentModel,
				settingsManager: options.parentServices.settingsManager,
			});
	const warnings: string[] = [];
	if (isForkMode && forkBypassesProfileTools(agent)) {
		warnings.push(
			`context:"fork" is a permissive self-fork and does not apply the "${agent.id}" profile's ordinary tool allow/deny list; ` +
				`it preserves the caller's tools unless this task explicitly narrows them. Use context:"default" for filtered profile tools. ` +
				"Nested Agent access remains profile- and depth-capped.",
		);
	}
	const model = resolveAgentModel({
		modelReference: task.model,
		agent,
		defaults: agentDefaults,
		parentModel: options.parentModel,
		modelRegistry: options.parentServices.modelRegistry,
		onWarning: (warning) => warnings.push(warning),
	});
	const thinking = resolveAgentThinking({
		taskThinking: task.thinking,
		toolThinking: input.thinking,
		agent,
		defaults: agentDefaults,
		parentThinkingLevel: options.parentThinkingLevel,
		model,
	});
	const effectiveModel = applyMaxOutputTokens(model, task.maxOutputTokens);
	const callerDepth = options.parentServices.depth ?? 0;
	const maxDelegationDepth = getMaxDelegationDepth(options.parentServices.settingsManager);
	const childDepth = callerDepth + 1;
	const childCanDelegate = canDelegateAtDepth(childDepth, maxDelegationDepth);
	const profileAllowsAgent = resolveEffectiveTools({
		parentActiveTools: options.parentActiveTools,
		agent,
		allowAgentDelegation: true,
	}).effectiveTools.some((tool) => canonicalToolName(tool) === "agent");
	let effectiveTools: string[];
	let deniedTools: string[];
	if (isForkMode) {
		const requested = task.tools ? new Set(task.tools.map((tool) => canonicalToolName(tool))) : undefined;
		effectiveTools = requested
			? options.parentActiveTools.filter((tool) => requested.has(canonicalToolName(tool)))
			: [...options.parentActiveTools];
		deniedTools = [];
	} else {
		const resolved = resolveEffectiveTools({
			parentActiveTools: options.parentActiveTools,
			agent,
			requestedTools: task.tools,
			allowAgentDelegation: childCanDelegate,
		});
		effectiveTools = resolved.effectiveTools;
		deniedTools = resolved.deniedTools;
	}
	const taskCanDelegate =
		childCanDelegate && profileAllowsAgent && effectiveTools.some((tool) => canonicalToolName(tool) === "agent");
	const startedAt = Date.now();
	const details = createInitialRunDetails({
		memberId: previousRun.memberId ?? `${recentRun.id}:1`,
		agent,
		task,
		effectiveTools,
		deniedTools,
		model: effectiveModel,
		thinking,
		warnings,
		startedAt,
	});
	const policy = details.context;
	// Re-apply the routed task.cwd on resume, mirroring the initial dispatch at
	// resolveChildCwd(options.task.cwd, options.parentServices.cwd) above. Without
	// this, resuming a parked persistent background run rebinds the child's tool
	// registry (bash/read/write/etc.) to the parent's cwd, even though the
	// original dispatch routed the session elsewhere (my-pi issue #916).
	const childCwd = resolveChildCwd(task.cwd, options.parentServices.cwd);
	const childServices = await createAgentSessionServices({
		cwd: childCwd,
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
		model: effectiveModel,
		thinkingLevel: thinking,
		tools: effectiveTools,
		disableAgentToolServices: !taskCanDelegate,
		agentToolServices: {
			cwd: childCwd,
			agentDir: options.parentServices.agentDir,
			authStorage: options.parentServices.authStorage,
			settingsManager: options.parentServices.settingsManager,
			modelRegistry: options.parentServices.modelRegistry,
			depth: childDepth,
			// Link this child's future delegations back to the run being resumed.
			parentRunId: recentRun.id,
		},
		// Telemetry identity: stable across resume — this run is `recentRun.id`, its
		// parent the run that originally spawned it.
		agentRunIdentity: {
			runId: recentRun.id,
			parentRunId: recentRun.parentRunId,
		},
		sessionStartEvent: {
			type: "session_start",
			reason: "resume",
			previousSessionFile: options.parentSessionManager.getSessionFile(),
			forkMetadata: task.forkMetadata,
		},
		source: "child-agent",
	});
	// Reapply the original system-prompt policy after opening the persisted
	// session. Session creation builds a fresh prompt even though the transcript
	// comes from the previous run.
	if (task.systemPrompt) {
		session.overrideBaseSystemPrompt(task.systemPrompt);
	} else if (inheritedSystemPrompt) {
		session.overrideBaseSystemPrompt(inheritedSystemPrompt);
	} else if (agent.cacheProfile === "stable" && policy.mode === "none") {
		session.overrideBaseSystemPrompt(buildAgentSystemAppend(agent));
	}

	details.loadedSkills = childServices.resourceLoader.getSkills().skills.map((skill) => skill.name);

	const runs: AgentRunDetails[] = [details];
	const courseCorrection =
		prompt?.trim() ||
		"Continue the interrupted Agent task from where you left off. Return the final report when done.";
	const resumePrompt = buildAgentCourseCorrectionPrompt(courseCorrection, {
		canDelegate: taskCanDelegate,
		remaining: taskCanDelegate ? maxDelegationDepth - childDepth : 0,
	});

	const memberId = details.memberId ?? `${recentRun.id}:1`;
	details.memberId = memberId;
	const memberControl = createMemberSessionControl(session, memberId, recentRun.id);
	options.onMemberController?.(details, memberControl.controller);

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
			memberAbort: memberControl.memberAbort,
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
		status: isPersistentPark(input) ? "interrupted" : "completed",
		parked: isPersistentPark(input),
		runs,
		runId: recentRun.id,
		background: true,
		chainDir: input.chainDir,
	};
	finishAgentRecentRun(recentRun, completedDetails, expectedGeneration);
	return completedDetails;
}

// —— executeAgentToolToCompletion ——
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
			for (const [index, task] of input.tasks.entries()) {
				const normalized = makeTask({ ...task, task: task.task.replaceAll("{previous}", previous) });
				const result = await runChild({
					...options,
					registry,
					task: normalized,
					memberId: `${recentRun.id}:${index + 1}`,
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
			const memberOrder = new Map(normalizedTasks.map((_, index) => [`${recentRun.id}:${index + 1}`, index]));
			const recordResult = (result: AgentRunDetails) => {
				if (!runs.includes(result)) runs.push(result);
				runs.sort(
					(a, b) =>
						(memberOrder.get(a.memberId ?? "") ?? Number.MAX_SAFE_INTEGER) -
						(memberOrder.get(b.memberId ?? "") ?? Number.MAX_SAFE_INTEGER),
				);
				emitProgress(input, runs, options.onProgress);
			};
			const { results, errors } = await mapWithConcurrency(normalizedTasks, concurrency, async (task, index) => {
				try {
					const result = await runChild({
						...options,
						registry,
						task,
						memberId: `${recentRun.id}:${index + 1}`,
						toolThinking: input.thinking,
						chainDir: input.chainDir,
						progressInput: input,
						progressRuns: runs,
						taskId: recentRun.id,
					});
					recordResult(result);
					return result;
				} catch (error) {
					const details = getErrorDetails(error);
					if (details) recordResult(details);
					throw error;
				}
			});
			runs.splice(0, runs.length, ...results);
			if (errors.length > 0) throw errors[0];
		} else {
			const result = await runChild({
				...options,
				registry,
				task: makeTask(input.tasks[0]),
				memberId: `${recentRun.id}:1`,
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
		status: isPersistentPark(input) ? "interrupted" : "completed",
		parked: isPersistentPark(input),
		runs,
		runId: recentRun.id,
		background: input.background === true,
		concurrency: input.mode === "parallel" ? concurrency : undefined,
		chainDir: input.chainDir,
	};
	finishAgentRecentRun(recentRun, completedDetails, expectedGeneration);
	return completedDetails;
}

function resolveExecutionConcurrency(input: AgentToolExecutionInput): number {
	return Math.max(1, Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY));
}

function runningBackgroundDetails(
	input: AgentToolExecutionInput,
	recentRun: AgentRecentRun,
	message: string,
): AgentToolDetails {
	return {
		mode: input.mode,
		status: "running",
		runs: recentRun.runs,
		runId: recentRun.id,
		background: true,
		message,
		concurrency: input.mode === "parallel" ? resolveExecutionConcurrency(input) : undefined,
		chainDir: input.chainDir,
	};
}

async function executeManagedAgentRun(
	input: AgentToolExecutionInput,
	options: AgentExecutorOptions,
	recentRun: AgentRecentRun,
	behavior: { returnImmediately: boolean; autoDetachOnProviderRetry?: boolean },
): Promise<AgentToolDetails> {
	let abortController = new AbortController();
	let abortStatus: AgentToolStatus | undefined;
	let activeRunPromise: Promise<void> = Promise.resolve();
	let lastActivityAt = Date.now();
	let monitor: NodeJS.Timeout | undefined;
	let detached = behavior.returnImmediately;
	let parentAbortListener: (() => void) | undefined;
	let terminalListenerAttached = false;
	let resolveDetach!: (details: AgentToolDetails) => void;
	const detachPromise = new Promise<AgentToolDetails>((resolve) => {
		resolveDetach = resolve;
	});
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
	const attachTerminalNotification = () => {
		if (terminalListenerAttached || !options.onBackgroundTerminal) return;
		terminalListenerAttached = true;
		const notify = options.onBackgroundTerminal;
		attachAgentRecentRunTerminalListener(recentRun.id, (run) => {
			notify(buildBackgroundCompletion(run));
		});
	};
	const detachFromParentAbort = () => {
		if (!parentAbortListener || !options.signal) return;
		options.signal.removeEventListener("abort", parentAbortListener);
		parentAbortListener = undefined;
	};
	const detachToBackground = (activity: string) => {
		if (detached || recentRun.status !== "running") return;
		detached = true;
		detachFromParentAbort();
		markAgentRecentRunBackgrounded(recentRun);
		attachTerminalNotification();
		resolveDetach(
			runningBackgroundDetails(
				input,
				recentRun,
				`Agent run ${recentRun.id} auto-backgrounded after child provider retry/backoff: ${activity}. It will continue in the background and send agent_completion when it finishes.`,
			),
		);
	};
	let resumeAggregate: (prompt?: string) => Promise<void>;
	let resumeInFlight: Promise<void> | undefined;
	const makeBackgroundOptions = (generation: number): AgentExecutorOptions => ({
		...options,
		signal: abortController.signal,
		abortStatus: () => abortStatus,
		onProgress: (progress) => {
			touchActivity();
			// Persistent forks park (interrupted) after each turn instead of
			// terminating. The child completing would otherwise emit a "completed"
			// aggregate here, marking the run terminal and deleting its controller
			// before the park runs — so the park's finishAgentRecentRun(interrupted)
			// must be the ONLY terminal transition. Keep the run "running" through
			// the completed progress; failures/cancels still flow normally.
			const next =
				isPersistentPark(input) && progress.status === "completed"
					? { ...progress, status: "running" as const }
					: progress;
			updateAgentRecentRunProgress(recentRun, next, generation);
			if (!behavior.returnImmediately && !detached) options.onProgress?.(next);
		},
		onChildProviderRetry: (event) => {
			touchActivity();
			options.onChildProviderRetry?.(event);
			if (behavior.autoDetachOnProviderRetry) detachToBackground(event.activity);
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
		onMemberController: (details, controller) => {
			if (!details.memberId) return;
			attachAgentRecentRunMemberController(recentRun.id, details.memberId, {
				...controller,
				resume:
					input.mode === "single" && input.background === true ? (prompt) => resumeAggregate(prompt) : undefined,
			});
			options.onMemberController?.(details, controller);
		},
	});
	const abortActiveSessions = () => {
		for (const session of activeSessions) {
			session.abortBash();
			void session.abort().catch(() => {});
		}
	};
	const launch = (run: (generation: number) => Promise<AgentToolDetails>): Promise<AgentToolDetails> => {
		const generation = getAgentRecentRunGeneration(recentRun);
		startMonitor(generation);
		const completion = run(generation)
			.catch((error) => {
				failAgentRecentRun(recentRun, error, generation);
				throw error;
			})
			.finally(() => {
				if (getAgentRecentRunGeneration(recentRun) === generation) stopMonitor();
			});
		activeRunPromise = completion.then(
			() => {},
			() => {},
		);
		return completion;
	};

	resumeAggregate = (prompt) => {
		if (resumeInFlight) return resumeInFlight;
		const expectedGeneration = getAgentRecentRunGeneration(recentRun);
		const operation = (async () => {
			await activeRunPromise;
			if (recentRun.status !== "interrupted" || getAgentRecentRunGeneration(recentRun) !== expectedGeneration) {
				throw new Error(`Agent run ${recentRun.id} is no longer resumable`);
			}
			const priorMemberId = recentRun.runs[0]?.memberId;
			if (priorMemberId) detachAgentRecentRunMemberController(priorMemberId);
			abortController = new AbortController();
			abortStatus = undefined;
			restartAgentRecentRun(recentRun);
			launch((generation) =>
				resumeSingleBackgroundRun(input, makeBackgroundOptions(generation), recentRun, generation, prompt),
			);
		})();
		resumeInFlight = operation.finally(() => {
			resumeInFlight = undefined;
		});
		return resumeInFlight;
	};

	if (!behavior.returnImmediately && options.signal) {
		parentAbortListener = () => {
			if (detached) return;
			abortStatus = options.abortStatus?.() ?? "cancelled";
			abortActiveSessions();
			abortController.abort();
		};
		if (options.signal.aborted) parentAbortListener();
		else options.signal.addEventListener("abort", parentAbortListener, { once: true });
	}

	if (behavior.returnImmediately) attachTerminalNotification();

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
		resume: resumeAggregate,
		inject: async (message) => {
			const sessions = [...activeSessions];
			if (sessions.length === 0) throw new Error("No active child session to receive input");
			await Promise.all(sessions.map((session) => session.steer(message)));
		},
	});

	const completion = launch((generation) =>
		executeAgentToolToCompletion(input, makeBackgroundOptions(generation), recentRun, generation),
	);
	if (behavior.returnImmediately) {
		void completion.catch(() => {});
		return runningBackgroundDetails(
			input,
			recentRun,
			`Background agent run ${recentRun.id} started. Use /agents-status ${recentRun.id} for details.`,
		);
	}

	try {
		return await Promise.race([completion, detachPromise]);
	} finally {
		if (!detached) detachFromParentAbort();
	}
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
			`Nested Agent delegation is not permitted at depth ${callerDepth} ` +
				`(subagents.maxDelegationDepth = ${delegationCap}). Complete the current task and return the result to the calling agent.`,
		);
	}
	const recentRun = startAgentRecentRun(input.mode, input.tasks, {
		background: input.background,
		// callerDepth = depth of the session that invoked `agent`; the run inherits it
		// so the agents view can mark nested delegations and link them to their parent.
		depth: callerDepth,
		parentRunId: options.parentServices.parentRunId,
		persistent: isPersistentPark(input),
		label: input.mode === "single" ? input.tasks[0]?.description : undefined,
	});
	if (input.background) {
		return executeManagedAgentRun(input, options, recentRun, { returnImmediately: true });
	}
	return executeManagedAgentRun(input, options, recentRun, {
		returnImmediately: false,
		// Auto-detach only when the parent session has a completion sink. Without it
		// (e.g. one-shot print/headless), foreground waiting is safer than returning a
		// dangling in-process child the parent can never be notified about.
		autoDetachOnProviderRetry: Boolean(options.onBackgroundTerminal),
	});
}
