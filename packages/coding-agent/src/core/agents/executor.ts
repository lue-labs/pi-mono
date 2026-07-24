import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { AgentTool, ThinkingLevel } from "@valkyriweb/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent, Tool, Usage } from "@valkyriweb/pi-ai";
import type { AgentSession } from "../agent-session.ts";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../agent-session-services.ts";
import type { AuthStorage } from "../auth-storage.ts";
import { createPromptCacheAffinityKey } from "../cache-affinity.ts";
import { DEFAULT_THINKING_LEVEL } from "../defaults.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { normalizeAutoAliasString, parseModelPattern, tierModelCandidatesForParent } from "../model-resolver.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { type ReadonlySessionManager, SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { appendTaskMessage } from "../tasks/messages.ts";
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
import { registerLiveSession, unregisterLiveSession } from "./live-sessions.ts";
import { writeAgentOutput } from "./output.ts";
import { findAgentDefinition, formatAvailableAgents, loadAgentRegistry } from "./registry.ts";
import type { AgentRecentRun } from "./status.ts";
import {
	agentRunUiStatus,
	attachAgentRecentRunController,
	attachAgentRecentRunTerminalListener,
	failAgentRecentRun,
	finishAgentRecentRun,
	formatAgentDurationMs,
	getAgentRecentRunGeneration,
	markAgentRecentRunBackgrounded,
	markAgentRecentRunNeedsAttention,
	reapAgentRecentRun,
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
const AUTOMATIC_WORKTREE_CWD = Symbol.for("pi.worktree.autoCwd");

export interface AgentToolParentServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	/** Canonical model/auth runtime backing modelRegistry; reused by child sessions to avoid rebuilding from disk. */
	modelRuntime?: ModelRuntime;
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
	/** Executable parent tools in wire order. Used only to fill handlers missing
	 * from a cache-compatible fork child's independently-built registry. */
	parentExecutableTools?: AgentTool[];
	/** Frozen provider-visible parent tool metadata, in wire order. */
	parentProviderTools?: Tool[];
	/** Parent prompt-cache lane reused when the child inherits its stable prefix. */
	parentCacheAffinityKey?: string;
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
	onChildProviderRetry?: (event: { details: AgentRunDetails; activity: string }) => void;
	/**
	 * Fired exactly once when a background run reaches a terminal status or a
	 * persistent run intentionally parks between turns. Only wired by the
	 * `executeAgentTool` background path — foreground runs return synchronously
	 * and don't need a push. Parent sessions use this to inject a structured
	 * `agent_completion` custom message instead of polling status.
	 */
	onBackgroundTerminal?: (notification: AgentBackgroundCompletion) => void;
	/** Register a terminal-listener cleanup with the parent session's disposer. */
	onBackgroundTerminalListener?: (unsubscribe: () => void) => void;
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

// `session.prompt()` resolves even when the run terminated on a provider error.
// Check the persisted branch: overflow recovery removes an error from live state
// before compaction, but the transcript retains it when recovery cannot continue.
function getTrailingAssistantError(sessionManager: ReadonlySessionManager): string | undefined {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason === "error") {
			return entry.message.errorMessage ?? "Child session stopped with a provider error";
		}
		return undefined;
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
	sessionManager: ReadonlySessionManager;
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
		let providerRetryActivity: string | undefined;
		if (!options.progressRuns.includes(details)) options.progressRuns.push(details);
		refreshRunDetailsFromSession(details, session, startedAt);
		if (event.type === "message_update" && event.message.role === "assistant") {
			const snippet = extractTextPreview(event.message.content, 200);
			if (snippet && appendRunActivitySnippet(details, snippet)) {
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
		if (event.type === "auto_retry_start") {
			const activity = formatAutoRetryActivity(event);
			providerRetryActivity = activity;
			details.currentToolName = undefined;
			details.currentToolArgsPreview = undefined;
			if (appendRunActivitySnippet(details, activity)) {
				if (taskId) appendTaskMessage(taskId, { kind: "assistant_text", ts: Date.now(), text: activity });
			}
		}
		if (event.type === "auto_retry_end" && !event.success) {
			const activity = formatAutoRetryFailure(event);
			if (appendRunActivitySnippet(details, activity)) {
				if (taskId) appendTaskMessage(taskId, { kind: "assistant_text", ts: Date.now(), text: activity });
			}
		}
		emitProgress(options.progressInput, options.progressRuns, options.onProgress);
		if (providerRetryActivity) options.onChildProviderRetry?.({ details, activity: providerRetryActivity });
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
		const trailingError = getTrailingAssistantError(options.sessionManager);
		if (trailingError) throw new Error(trailingError);
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

interface PreparedChildRunContext {
	agent: AgentDefinition;
	cacheCompatibleGeneral: boolean;
	inheritedSystemPrompt?: string;
	requestedAutoModel?: string;
	routingMetadata?: Record<string, unknown>;
	childPrompt: string;
	model: Model<Api> | undefined;
	thinking: ThinkingLevel;
	effectiveTools: string[];
	maxDelegationDepth: number;
	childDepth: number;
	taskCanDelegate: boolean;
	startedAt: number;
	details: AgentRunDetails;
	policy: AgentRunDetails["context"];
	childCwd: string;
	childServices: AgentSessionServices;
	agentToolServices: AgentToolParentServices;
}

/**
 * Resolve the execution contract shared by initial dispatch and persistent
 * resume. Keeping fork defaults, model/thinking, output cap, tools/depth, cwd,
 * and cwd-bound services here prevents either path from silently drifting.
 */
async function prepareChildRunContext(options: {
	registry: AgentRegistry;
	task: NormalizedAgentTaskConfig;
	toolThinking?: ThinkingLevel;
	executor: AgentExecutorOptions;
}): Promise<PreparedChildRunContext> {
	const { task, executor } = options;
	const agent = findAgentDefinition(options.registry, task.agent);
	if (!agent) {
		throw new Error(`Unknown agent "${task.agent}". Available agents: ${formatAvailableAgents(options.registry)}`);
	}

	// Fork mode is a permissive self-fork: it inherits the parent's transcript,
	// model/thinking, and tools. A default General run without an explicit cwd
	// override is fresh, but preserves the parent's stable provider prefix even
	// when the runtime places it in an automatic isolation worktree.
	// Explicit model/tool/system/cwd choices opt out because their bytes or runtime
	// semantics intentionally differ from the caller.
	const isForkMode = resolveContextPolicy(task.context).mode === "fork";
	const childCwd = resolveChildCwd(task.cwd, executor.parentServices.cwd);
	const hasAutomaticIsolationCwd =
		(task as NormalizedAgentTaskConfig & Record<PropertyKey, unknown>)[AUTOMATIC_WORKTREE_CWD] === true;
	const isUnrestrictedGeneral =
		agent.id === "general" &&
		agent.source === "builtin" &&
		agent.tools === "*" &&
		(agent.denyTools === undefined || agent.denyTools.length === 0);
	const isCacheCompatibleGeneral =
		isUnrestrictedGeneral &&
		task.context === "default" &&
		task.model === undefined &&
		task.tools === undefined &&
		task.thinking === undefined &&
		task.systemPrompt === undefined &&
		(task.cwd === undefined || hasAutomaticIsolationCwd);
	const inheritedSystemPrompt = isForkMode || isCacheCompatibleGeneral ? executor.parentSystemPrompt : undefined;
	const agentDefaults =
		isForkMode || isCacheCompatibleGeneral
			? undefined
			: resolveAgentDefaults({
					parentModel: executor.parentModel,
					settingsManager: executor.parentServices.settingsManager,
				});
	// A cache-compatible General run must retain the parent's concrete model and
	// thinking level. Ignore profile-level auto/tier routing here: it would make
	// the request model differ from the frozen parent cache lane.
	const cacheCompatibleAgent: AgentDefinition = isCacheCompatibleGeneral
		? { ...agent, model: "inherit", thinking: "inherit" }
		: agent;
	const selectedModelReference = resolveAgentModelReference({
		modelReference: task.model,
		agent: cacheCompatibleAgent,
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
		modelReference: task.model,
		agent: cacheCompatibleAgent,
		defaults: agentDefaults,
		parentModel: executor.parentModel,
		modelRegistry: executor.parentServices.modelRegistry,
		onWarning: (warning) => warnings.push(warning),
	});
	const thinking = resolveAgentThinking({
		taskThinking: task.thinking,
		toolThinking: options.toolThinking,
		agent: cacheCompatibleAgent,
		defaults: agentDefaults,
		parentThinkingLevel: executor.parentThinkingLevel,
		model,
	});
	const effectiveModel = applyMaxOutputTokens(model, task.maxOutputTokens);

	const callerDepth = executor.parentServices.depth ?? 0;
	const maxDelegationDepth = getMaxDelegationDepth(executor.parentServices.settingsManager);
	const childDepth = callerDepth + 1;
	const childCanDelegate = canDelegateAtDepth(childDepth, maxDelegationDepth);
	const profileAllowsAgent = resolveEffectiveTools({
		parentActiveTools: executor.parentActiveTools,
		agent,
		allowAgentDelegation: true,
	}).effectiveTools.some((tool) => canonicalToolName(tool) === "agent");
	const profileCanDelegate = childCanDelegate && profileAllowsAgent;
	let effectiveTools: string[];
	let deniedTools: string[];
	const preserveParentToolPrefix = isForkMode || (isUnrestrictedGeneral && task.tools === undefined);
	if (preserveParentToolPrefix) {
		const requested = task.tools ? new Set(task.tools.map((tool) => canonicalToolName(tool))) : undefined;
		effectiveTools = requested
			? executor.parentActiveTools.filter((tool) => requested.has(canonicalToolName(tool)))
			: [...executor.parentActiveTools];
		// Keep the Agent schema in the provider prefix even when nesting is denied.
		// createAgentSessionFromServices leaves its execution engine unbound, so a
		// model call fails closed without changing the parent's tool bytes or order.
		deniedTools = profileCanDelegate ? [] : effectiveTools.filter((tool) => canonicalToolName(tool) === "agent");
	} else {
		const resolved = resolveEffectiveTools({
			parentActiveTools: executor.parentActiveTools,
			agent,
			requestedTools: task.tools,
			allowAgentDelegation: profileCanDelegate,
		});
		effectiveTools = resolved.effectiveTools;
		deniedTools = resolved.deniedTools;
	}
	const taskCanDelegate = profileCanDelegate && effectiveTools.some((tool) => canonicalToolName(tool) === "agent");
	const startedAt = Date.now();
	const details = createInitialRunDetails({
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
	// Keep cache-compatible General's system prompt byte-identical to the parent.
	// Its role guidance belongs in the uncached task suffix; appending it to the
	// final system block invalidates that whole cache block.
	const roleGuidance =
		(agent.id !== "general" && (isForkMode || Boolean(task.systemPrompt))) || isCacheCompatibleGeneral
			? { agent: agent.id, prompt: buildAgentSystemAppend(agent) }
			: undefined;
	const childPrompt = buildChildTaskPrompt(
		task,
		{
			canDelegate: taskCanDelegate,
			remaining: taskCanDelegate ? maxDelegationDepth - childDepth : 0,
		},
		roleGuidance,
	);
	const routingMetadata = requestedAutoModel
		? buildChildRoutingMetadata({ agent, task, childPrompt, childCwd, effectiveTools, deniedTools })
		: undefined;
	const childRuntimeServices = {
		cwd: childCwd,
		agentDir: executor.parentServices.agentDir,
		authStorage: executor.parentServices.authStorage,
		settingsManager: executor.parentServices.settingsManager,
		modelRegistry: executor.parentServices.modelRegistry,
		// Children must share the parent's model universe; without this,
		// createAgentSessionServices rebuilds a runtime from disk and auto
		// routing/auth silently diverge from the parent registry.
		modelRuntime: executor.parentServices.modelRuntime ?? executor.parentServices.modelRegistry.getRuntime(),
	};
	const childServices = await createAgentSessionServices({
		...childRuntimeServices,
		resourceLoaderOptions: getChildResourceLoaderOptions(policy, agent),
	});

	return {
		agent,
		cacheCompatibleGeneral: isCacheCompatibleGeneral,
		inheritedSystemPrompt,
		requestedAutoModel,
		routingMetadata,
		childPrompt,
		model: effectiveModel,
		thinking,
		effectiveTools,
		maxDelegationDepth,
		childDepth,
		taskCanDelegate,
		startedAt,
		details,
		policy,
		childCwd,
		childServices,
		agentToolServices: { ...childRuntimeServices, depth: childDepth },
	};
}

function resolveResumedChildSessionOptions(options: {
	sessionManager: SessionManager;
	prepared: PreparedChildRunContext;
	maxOutputTokens?: number;
}): { model: Model<Api> | undefined; thinkingLevel: ThinkingLevel | undefined } {
	const { prepared } = options;
	if (!prepared.requestedAutoModel) {
		return { model: prepared.model, thinkingLevel: prepared.thinking };
	}

	// Auto aliases route once on the initial turn. Resume the selected model and
	// thinking level persisted in the child session instead of overriding them
	// with the alias's concrete fallback seed.
	const storedModel = options.sessionManager.buildSessionContext().model;
	const routedModel = storedModel
		? prepared.childServices.modelRuntime.getModel(storedModel.provider, storedModel.modelId)
		: undefined;
	if (!routedModel) {
		return { model: prepared.model, thinkingLevel: prepared.thinking };
	}
	return {
		model: applyMaxOutputTokens(routedModel, options.maxOutputTokens),
		thinkingLevel: undefined,
	};
}

function applyChildSessionResolution(options: {
	session: AgentSession;
	prepared: PreparedChildRunContext;
	modelFallbackMessage?: string;
	modelRoutingFailed?: boolean;
}): void {
	const { session, prepared, modelFallbackMessage, modelRoutingFailed } = options;
	prepared.details.model = formatModelForDetails(session.model ?? prepared.model);
	prepared.details.thinking = session.thinkingLevel;
	if (!prepared.requestedAutoModel || !modelFallbackMessage) return;

	const warning = modelRoutingFailed
		? `${modelFallbackMessage} If this fallback model is wrong for the task, re-run the task with an explicit model override.`
		: modelFallbackMessage;
	prepared.details.warnings = [...(prepared.details.warnings ?? []), warning];
}

function applyChildSessionPolicy(
	session: AgentSession,
	task: NormalizedAgentTaskConfig,
	prepared: PreparedChildRunContext,
	retainInheritedSystemPrompt: boolean,
): void {
	if (task.systemPrompt !== undefined) {
		session.overrideBaseSystemPrompt(task.systemPrompt);
	} else if (retainInheritedSystemPrompt && prepared.inheritedSystemPrompt !== undefined) {
		session.overrideBaseSystemPrompt(prepared.inheritedSystemPrompt);
	} else if (prepared.agent.cacheProfile === "stable" && prepared.policy.mode === "none") {
		session.overrideBaseSystemPrompt(buildAgentSystemAppend(prepared.agent));
	}

	// A model:resolve hook can replace the capped fallback with a registry model.
	// Reapply the task cap after session creation so routed and resumed turns match.
	const cappedModel = applyMaxOutputTokens(session.model, task.maxOutputTokens);
	if (cappedModel && cappedModel !== session.model) {
		session.agent.state.model = cappedModel;
	}

	// Each persistent resume creates a fresh AgentSession, so the per-run turn cap
	// must be restored alongside the prompt policy.
	if (task.maxTurns !== undefined && task.maxTurns > 0) {
		session.agent.maxTurns = task.maxTurns;
	}
}

function hasExactParentToolNames(session: AgentSession, parentProviderTools: readonly Tool[]): boolean {
	const childToolNames = session.getActiveToolNames();
	const parentToolNames = parentProviderTools.map((tool) => tool.name);
	return (
		childToolNames.length === parentToolNames.length &&
		childToolNames.every((name, index) => name === parentToolNames[index])
	);
}

function shouldRetainInheritedSystemPrompt(options: {
	session: AgentSession;
	task: NormalizedAgentTaskConfig;
	prepared: PreparedChildRunContext;
	parentProviderTools?: readonly Tool[];
}): boolean {
	const { session, task, prepared, parentProviderTools } = options;
	// A fork preserves its parent prefix until exact schema enforcement rejects a
	// missing handler. A default General child instead falls back to its local
	// prompt when its automatic worktree cannot reproduce a parent tool.
	return (
		prepared.inheritedSystemPrompt === undefined ||
		!prepared.cacheCompatibleGeneral ||
		parentProviderTools === undefined ||
		hasExactParentToolNames(session, parentProviderTools) ||
		task.context === "fork"
	);
}

/**
 * Reuse the parent's cache lane only after the child has its final model-facing
 * prefix. Fork mode preserves its normal explicit overrides; a parent affinity
 * key is an optimization, not permission to treat a changed request as cached.
 */
function applyParentCacheAffinityIfCompatible(options: {
	session: AgentSession;
	parentProviderTools?: readonly Tool[];
	parentCacheAffinityKey?: string;
	parentModel: Model<Api> | undefined;
	parentThinkingLevel: ThinkingLevel;
	parentSystemPrompt?: string;
	requireParentToolSchemas: boolean;
}): void {
	const {
		session,
		parentProviderTools,
		parentCacheAffinityKey,
		parentModel,
		parentThinkingLevel,
		parentSystemPrompt,
		requireParentToolSchemas,
	} = options;
	if (
		!parentProviderTools ||
		!parentModel ||
		parentSystemPrompt === undefined ||
		!session.model ||
		session.thinkingLevel !== parentThinkingLevel
	) {
		return;
	}

	const parentPrefixKey = createPromptCacheAffinityKey(parentModel, {
		systemPrompt: parentSystemPrompt,
		tools: [...parentProviderTools],
	});
	const childPrefixKey = createPromptCacheAffinityKey(session.model, {
		systemPrompt: session.agent.state.systemPrompt,
		tools: [...parentProviderTools],
	});
	if (childPrefixKey !== parentPrefixKey) return;

	if (!hasExactParentToolNames(session, parentProviderTools)) {
		if (requireParentToolSchemas) session.overrideActiveToolProviderSchemas(parentProviderTools);
		return;
	}

	// Overlay only after model, system prompt, and tool order/bytes prove that
	// this request has the parent's exact provider-visible cache prefix.
	session.overrideActiveToolProviderSchemas(parentProviderTools);
	if (parentCacheAffinityKey) session.overridePromptCacheAffinityKey(parentCacheAffinityKey);
}

function throwChildSetupFailure(details: AgentRunDetails, error: unknown): never {
	details.status = "failed";
	details.error = error instanceof Error ? error.message : String(error);
	throw Object.assign(new Error(details.error), { details });
}

async function runChild(options: RunChildOptions): Promise<AgentRunDetails> {
	if (options.signal?.aborted) throw new Error("Agent tool aborted");
	const prepared = await prepareChildRunContext({
		registry: options.registry,
		task: options.task,
		toolThinking: options.toolThinking,
		executor: options,
	});
	const {
		requestedAutoModel,
		routingMetadata,
		childPrompt,
		model: effectiveModel,
		thinking,
		effectiveTools,
		taskCanDelegate,
		startedAt,
		details,
		policy,
		childCwd,
		childServices,
		agentToolServices,
	} = prepared;
	const childSessionManager = SessionManager.create(childCwd);
	childSessionManager.newSession({ parentSession: options.parentSessionManager.getSessionFile() });
	details.sessionId = childSessionManager.getSessionId();
	details.sessionPath = childSessionManager.getSessionFile();
	let createdSession: Awaited<ReturnType<typeof createAgentSessionFromServices>>;
	try {
		createdSession = await createAgentSessionFromServices({
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
			...agentToolServices,
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
	} catch (error) {
		throwChildSetupFailure(details, error);
	}
	const { session, modelFallbackMessage, modelRoutingFailed } = createdSession;
	try {
		applyChildSessionResolution({ session, prepared, modelFallbackMessage, modelRoutingFailed });
	await session.bindExtensions({});
	await session.loadDeferredExtensions();
	session.setActiveToolsByName(effectiveTools);
	if (options.task.context === "fork" && options.task.tools === undefined && options.parentExecutableTools) {
		session.inheritMissingActiveTools(options.parentExecutableTools);
	}

	if (policy.includeTranscript) {
		session.state.messages = getFilteredForkMessages(options.parentSessionManager);
	}

	applyChildSessionPolicy(
		session,
		options.task,
		prepared,
		shouldRetainInheritedSystemPrompt({
			session,
			task: options.task,
			prepared,
			parentProviderTools: options.parentProviderTools,
		}),
	);
	applyParentCacheAffinityIfCompatible({
		session,
		parentProviderTools: options.parentProviderTools,
		parentCacheAffinityKey: options.parentCacheAffinityKey,
		parentModel: options.parentModel,
		parentThinkingLevel: options.parentThinkingLevel,
		parentSystemPrompt: options.parentSystemPrompt,
		requireParentToolSchemas: options.task.context === "fork" && options.task.tools === undefined,
	});

		details.loadedSkills = childServices.resourceLoader.getSkills().skills.map((skill) => skill.name);
	} catch (error) {
		refreshRunDetailsFromSession(details, session, startedAt);
		session.dispose();
		throwChildSetupFailure(details, error);
	}

	return driveChildSession(session, {
		...options,
		sessionManager: childSessionManager,
		details,
		startedAt,
		prompt: childPrompt,
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
	const prepared = await prepareChildRunContext({
		registry,
		task,
		toolThinking: input.thinking,
		executor: options,
	});
	const {
		effectiveTools,
		maxDelegationDepth,
		childDepth,
		taskCanDelegate,
		startedAt,
		details,
		childServices,
		agentToolServices,
	} = prepared;
	const childSessionManager = SessionManager.open(previousRun.sessionPath);
	const resumedSelection = resolveResumedChildSessionOptions({
		sessionManager: childSessionManager,
		prepared,
		maxOutputTokens: task.maxOutputTokens,
	});
	details.sessionId = childSessionManager.getSessionId();
	details.sessionPath = childSessionManager.getSessionFile();
	const { session, modelFallbackMessage, modelRoutingFailed } = await createAgentSessionFromServices({
		services: childServices,
		sessionManager: childSessionManager,
		model: resumedSelection.model,
		thinkingLevel: resumedSelection.thinkingLevel,
		tools: effectiveTools,
		disableAgentToolServices: !taskCanDelegate,
		agentToolServices: {
			...agentToolServices,
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
	applyChildSessionResolution({ session, prepared, modelFallbackMessage, modelRoutingFailed });
	await session.bindExtensions({});
	await session.loadDeferredExtensions();
	session.setActiveToolsByName(effectiveTools);
	if (task.context === "fork" && task.tools === undefined && options.parentExecutableTools) {
		session.inheritMissingActiveTools(options.parentExecutableTools);
	}
	applyChildSessionPolicy(
		session,
		task,
		prepared,
		shouldRetainInheritedSystemPrompt({
			session,
			task,
			prepared,
			parentProviderTools: options.parentProviderTools,
		}),
	);
	applyParentCacheAffinityIfCompatible({
		session,
		parentProviderTools: options.parentProviderTools,
		parentCacheAffinityKey: options.parentCacheAffinityKey,
		parentModel: options.parentModel,
		parentThinkingLevel: options.parentThinkingLevel,
		parentSystemPrompt: options.parentSystemPrompt,
		requireParentToolSchemas: task.context === "fork" && task.tools === undefined,
	});

	details.loadedSkills = childServices.resourceLoader.getSkills().skills.map((skill) => skill.name);

	const runs: AgentRunDetails[] = [details];
	const courseCorrection =
		prompt?.trim() ||
		"Continue the interrupted Agent task from where you left off. Return the final report when done.";
	const resumePrompt = buildAgentCourseCorrectionPrompt(courseCorrection, {
		canDelegate: taskCanDelegate,
		remaining: taskCanDelegate ? maxDelegationDepth - childDepth : 0,
	});

	try {
		await driveChildSession(session, {
			...options,
			task,
			sessionManager: childSessionManager,
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
			if (staleMs < BACKGROUND_STALE_PROGRESS_MS) return;
			if (activeSessions.size === 0) {
				// Zombie: stale past the threshold with no live child session left to
				// produce progress. Force-settle to terminal (CC-style reaper) instead
				// of flagging for attention — nothing can legitimately still be
				// driving this run, so waiting on the user is pure noise.
				stopMonitor();
				abortStatus = "cancelled";
				abortController.abort();
				reapAgentRecentRun(
					recentRun,
					`reaped: no progress for ${formatAgentDurationMs(staleMs)} and no live child session`,
					generation,
				);
				return;
			}
			// A live-but-quiet child may be mid long tool call (e.g. a silent
			// build); never kill it — surface an informational nudge only.
			markAgentRecentRunNeedsAttention(
				recentRun,
				`No child progress for ${formatAgentDurationMs(staleMs)}; inspect or stop it with /agents runs`,
			);
		}, BACKGROUND_MONITOR_INTERVAL_MS);
	};
	const attachTerminalNotification = () => {
		if (terminalListenerAttached || !options.onBackgroundTerminal) return;
		terminalListenerAttached = true;
		const notify = options.onBackgroundTerminal;
		const unsubscribe = attachAgentRecentRunTerminalListener(recentRun.id, (run) => {
			notify(buildBackgroundCompletion(run));
		});
		options.onBackgroundTerminalListener?.(unsubscribe);
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
		hidden: input.mode === "single" && input.tasks[0]?.hidden === true,
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
