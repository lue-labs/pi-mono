/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@valkyriweb/pi-agent-core";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "@valkyriweb/pi-ai";
import { contentText } from "@valkyriweb/pi-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@valkyriweb/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import {
	AGENTS_ENGINE_SERVICE_ID,
	type AgentEngine,
	type AgentParentSnapshot,
	createAgentEngine,
	runWithAgentEngineResolver,
} from "./agents/engine.ts";
import type { AgentToolParentServices } from "./agents/executor.ts";
import type { AgentBackgroundCompletion } from "./agents/types.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { createPromptCacheAffinityKey } from "./cache-affinity.ts";
import { type CacheHealthMetrics, computeCacheHealth } from "./cache-health.ts";
import { CacheHeartbeatManager } from "./cache-heartbeat.ts";
import {
	COMPACTION_FAILURE_TRIP_COUNT,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	evaluateRapidRefill,
	generateBranchSummary,
	isTransientCompactionError,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { CONTEXT_USAGE_SERVICE_ID, type ContextUsageSnapshotService } from "./context-usage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { isDeferredTool } from "./deferred-tools.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import { applyFilters, extensionHookNames } from "./extensions/extension-hooks.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionSlotUIActions,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { getExtensionProcessService } from "./extensions/loader.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { ForkAgentOptions, ForkAgentResult, TranscriptEntry } from "./extensions/types.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	ResidentPruneResult,
	SessionEntry,
	SessionManager,
} from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import {
	capModelFacingToolResultText,
	replaceOversizedToolResultImages,
	replaceUnsupportedToolResultImages,
	retireOutOfBudgetContextImages,
	stripModelFacingContextImages,
} from "./tool-artifacts.ts";

import {
	type BackgroundShellNotification,
	type BashOperations,
	createLocalBashOperations,
	subscribeBashBgNotificationForOwner,
} from "./tools/bash.ts";
import { allToolNames, createAllToolDefinitions, type ToolName } from "./tools/index.ts";

import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

function estimateSystemPromptTokens(systemPrompt: string): number {
	return Math.ceil(systemPrompt.length / 4);
}

export interface PendingAutoModelRequest {
	requestedModel: string;
	routingMetadata?: Record<string, unknown>;
}

const IDLE_CACHE_HINT_MS = 55 * 60 * 1000;

/** Order-independent equality for two string sets. */
function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) {
		if (!b.has(value)) return false;
	}
	return true;
}

/** Order-independent key+value equality for two string maps. */
function sameStringMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
	if (a.size !== b.size) return false;
	for (const [key, value] of a) {
		if (b.get(key) !== value) return false;
	}
	return true;
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "resident_prune";
			reason: "manual" | "threshold" | "overflow";
			result: ResidentPruneResult;
	  }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| {
			type: "model_changed";
			model: Model<any>;
			previousModel: Model<any> | undefined;
			source: "set" | "cycle" | "restore";
	  }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "idle_cache_hint"; idleMs: number; cacheTtlMs: number; message: string }
	| {
			type: "cache_heartbeat";
			scope: "base" | "session";
			model: string;
			provider: string;
			cacheRead: number;
			cacheWrite: number;
			input: number;
			cacheHitRate: number | undefined;
	  }
	| (CacheHealthMetrics & {
			sessionId: string;
			turn: number;
			model: string;
			timestamp: string;
	  })
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

/**
 * Identity of the agent run a session represents, for observability/telemetry
 * correlation. Stamped onto emitted `tool_call`/`tool_result` events as
 * `agentId` (this run) and `parentAgentId` (the run that spawned it). Both
 * undefined for the top-level interactive session (it is not an agent run).
 */
export interface AgentRunIdentity {
	/** This session's own agent-run id (`AgentRecentRun.id`). */
	runId?: string;
	/** The run that spawned this session; undefined at top level. */
	parentRunId?: string;
}

type AgentRunEventIdentity = {
	agentId?: string;
	parentAgentId?: string;
};

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Initial active built-in tool names. Default: all built-in tools. */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Services shared with native child agent sessions. */
	agentToolServices?: AgentToolParentServices;
	/** Identity of this session's agent run, for telemetry correlation across nested sub-agents. */
	agentRunIdentity?: AgentRunIdentity;
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Auto-model alias waiting for semantic input before resolving to a concrete model. */
	pendingAutoModelRequest?: PendingAutoModelRequest;
	/**
	 * Origin of this session. Exposed on `ExtensionContext.source` so hooks
	 * can distinguish user-driven sessions (interactive TUI, `pi --print`,
	 * RPC) from machine-driven ones (in-process child-agent runs spawned by
	 * the built-in `agent` tool / `ctx.forkAgent`, or out-of-process Pi
	 * children spawned with `pi --source child-agent`). Defaults to
	 * `"interactive"`. Replaces the legacy `PI_MEMORY_SUBAGENT=1` env
	 * contract used by dream-memory / pi-memory.
	 */
	source?: InputSource;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: (reason?: unknown) => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
	/**
	 * Wiring for the B5 imperative show/hide API (`pi.showMainPane` /
	 * `pi.showOverlay`). Provided only by UI-capable modes (interactive); when
	 * omitted, the default no-op stubs silently swallow show/hide requests.
	 */
	slotUIActions?: ExtensionSlotUIActions;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
// ============================================================================
// AgentSession Class
// ============================================================================

// web_fetch/web_search are now client-side extension tools (Claude Code parity)
// and provider-agnostic; no per-provider add/strip is needed. Server-tool opt-in
// happens via ToolDefinition.anthropicServerTool in pi-ai's convertOneTool.
function syncClaudeBridgeNativeTools(toolNames: string[], _model: Model<any> | undefined): string[] {
	return toolNames;
}

function isToolAvailableForModel(definition: unknown, model: Model<any> | undefined): boolean {
	const providers =
		typeof definition === "object" && definition !== null && "providers" in definition
			? (definition as { providers?: unknown }).providers
			: undefined;
	if (!Array.isArray(providers)) return true;
	return !!model?.provider && providers.includes(model.provider);
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _abortAndResumeQueuedPromise: Promise<void> | undefined;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	/** Consecutive rapid-refill streak: incremented when a new auto-compaction fires within
	 *  RAPID_REFILL_WINDOW turns of the previous one; trips the thrashing breaker at
	 *  RAPID_REFILL_TRIP_COUNT (CC 2.1.201 autocompact-thrashing detector parity). */
	private _consecutiveRapidRefills = 0;
	/** Consecutive auto-compaction failures; trips the failure circuit breaker at
	 *  COMPACTION_FAILURE_TRIP_COUNT and disables auto-compaction for the rest of the session. */
	private _consecutiveCompactionFailures = 0;
	/** Set once the failure circuit breaker trips; short-circuits all further auto-compaction
	 *  attempts for the remainder of this session. */
	private _autoCompactDisabledThisSession = false;
	/** Set when the agent loop was stopped at a turn boundary by the mid-run compaction cap. */
	private _midRunCompactionStop = false;
	/** Set by extensions that need the current run to park after the active turn completes. */
	private _extensionStopAfterTurnReason: string | undefined = undefined;
	private _lastIdleCacheHintAssistantTimestamp: number | undefined = undefined;
	/** Prompt-cache heartbeats (fork-owned); state and scheduling live in cache-heartbeat.ts. */
	private readonly _cacheHeartbeat: CacheHeartbeatManager;
	/** Debounce timer for wakeOnIdle continuation turns (see sendCustomMessage). */
	private _idleWakeTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private _disposed = false;
	private _unsubscribeBashBgNotification?: () => void;
	private _backgroundAgentTerminalUnsubscribers = new Set<() => void>();

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _agentToolServices?: AgentToolParentServices;
	private _agentRunIdentity?: AgentRunIdentity;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: (reason?: unknown) => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _extensionSlotUIActions?: ExtensionSlotUIActions;

	private _modelRuntime: ModelRuntime;
	private _modelRegistry: ModelRegistry;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	// Post-registration deferral seam (cache-critical). Names here are forced to
	// `deferLoading:true` on every registry rebuild so they ride tools[] as
	// `defer_loading` stubs instead of full schemas. Source of truth — applied by
	// _applyDeferredOverrides() inside _refreshToolRegistry(). See
	// setDeferredToolOverrides().
	private _deferredOverrides: Set<string> = new Set();
	// Post-registration namespace seam (cache-critical). Maps tool name -> namespace
	// label, stamped onto the freshly rebuilt registry/definitions on every rebuild
	// so provider serializers can group related tools natively. Source of truth —
	// applied by _applyToolNamespaces() inside _refreshToolRegistry(). See
	// setToolNamespaces().
	private _toolNamespaces: Map<string, string> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();
	private _activeToolProviderSchemaOverrides?: Map<string, Tool>;
	private _activeToolProviderSchemaOrder?: string[];
	private _inheritedForkToolFallbacks?: Map<string, AgentTool>;
	private _activeToolProviderSchemaCache = new WeakMap<AgentTool, AgentTool>();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	// When true, before_agent_start extension handlers must not overwrite agent.state.systemPrompt.
	// Set by overrideBaseSystemPrompt() for fork children inheriting the parent's frozen prompt.
	private _systemPromptFrozen = false;
	// Set when a synchronous `_rebuildSystemPrompt` (tool/skill change) replaces
	// the base prompt with an UNFILTERED build. `_runAgentPrompt` re-applies the
	// `systemPrompt:build` filters before sending so cache-stabilising transforms
	// (date strip, base-boundary relocation) are not lost — see _rebuildSystemPrompt.
	private _systemPromptNeedsRefilter = false;
	private _systemPromptOverride?: string;
	private _source: InputSource = "interactive";
	private _pendingAutoModelRequest?: PendingAutoModelRequest;
	/** Session calls that can start or resume a turn, including asynchronous preflight. */
	private _activeTurnCalls = 0;
	/** Turn calls entered by the current async context, so isIdle can exclude the caller's own call. */
	private _turnCallScope = new AsyncLocalStorage<number>();

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._agentToolServices = config.agentToolServices;
		this._agentRunIdentity = config.agentRunIdentity;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._pendingAutoModelRequest = config.pendingAutoModelRequest;
		if (config.source) this._source = config.source;
		// Background bash ownership belongs to every AgentSession, not only the
		// interactive TUI. One owner-scoped lifecycle subscription gives child,
		// RPC, and print sessions exactly one wake per lifecycle event.
		this._unsubscribeBashBgNotification = subscribeBashBgNotificationForOwner(this.sessionId, (notification) => {
			if (notification.type === "shell_needs_input") this.emitBashStall(notification);
			else this.emitBashCompletion(notification);
		});

		// Host reads are live (getters/closures) — never snapshots of session state.
		const session = this;
		this._cacheHeartbeat = new CacheHeartbeatManager({
			get disposed() {
				return session._disposed;
			},
			get model() {
				return session.model;
			},
			get systemPrompt() {
				return session.systemPrompt;
			},
			get sessionId() {
				return session.sessionId;
			},
			settingsManager: this.settingsManager,
			agent: this.agent,
			findLastAssistantMessage: () => this._findLastAssistantMessage(),
			emit: (event) => this._emit(event),
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	/** Origin of this session — see `AgentSessionConfig.source`. */
	get source(): InputSource {
		return this._source;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			if (!result) return { model };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		} catch {
			return { model };
		}
	}

	private _agentRunEventIdentity(): AgentRunEventIdentity {
		const identity = this._agentRunIdentity;
		return {
			...(identity?.runId !== undefined ? { agentId: identity.runId } : {}),
			...(identity?.parentRunId !== undefined ? { parentAgentId: identity.parentRunId } : {}),
		};
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
					...this._agentRunEventIdentity(),
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			const hookResult = runner.hasHandlers("tool_result")
				? await runner.emitToolResult({
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
						usage: result.usage,
						...this._agentRunEventIdentity(),
					})
				: undefined;

			const hookContent = hookResult?.content;
			// Untyped JS extension tools can omit content (#6259/#6276); normalize
			// before the artifact/cap pipeline, which requires an array.
			const postHookContent = hookContent ?? result.content ?? [];
			// Runs after the extension hook so images injected or replaced by extensions are normalized too.
			const autoResizedContent = await normalizeToolResultImages(postHookContent, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
			});
			const normalizedContent = replaceUnsupportedToolResultImages(autoResizedContent, this._cwd, toolCall.id);
			const finalContent = normalizedContent ?? autoResizedContent;
			const imageCappedContent = replaceOversizedToolResultImages(finalContent, this._cwd, toolCall.id);
			const imageSafeContent = imageCappedContent ?? finalContent;
			const cappedContent = capModelFacingToolResultText(imageSafeContent, this._cwd, toolCall.id, toolCall.name);
			const shouldReturnContent =
				hookContent !== undefined ||
				autoResizedContent !== postHookContent ||
				normalizedContent !== undefined ||
				imageCappedContent !== undefined ||
				cappedContent !== undefined;
			if (!hookResult && !shouldReturnContent) {
				return undefined;
			}

			return {
				...(shouldReturnContent ? { content: cappedContent ?? imageSafeContent } : {}),
				details: hookResult ? hookResult.details : result.details,
				isError: hookResult?.isError ?? isError,
				usage: hookResult?.usage ?? result.usage,
			};
		};

		// Mid-run compaction cap: a run that keeps going (pending tool results,
		// queued steering/follow-up) can drift far past the compaction threshold
		// before it ends — the post-run check defers threshold compaction to the
		// next prompt. Stop the loop at the turn boundary instead;
		// _handlePostAgentRun then compacts and resumes the interrupted run.
		// Runs ending naturally (no more work) keep the defer semantics.
		this.agent.shouldStopAfterTurn = ({ message, toolResults }) => {
			if (this._extensionStopAfterTurnReason !== undefined) {
				this._extensionStopAfterTurnReason = undefined;
				return true;
			}

			if (toolResults.length === 0 && !this.agent.hasQueuedMessages()) return false;
			const settings = this.settingsManager.getCompactionSettings(this.model?.contextWindow);
			if (!settings.enabled) return false;
			const contextWindow = this.model?.contextWindow ?? 0;
			if (!shouldCompact(calculateContextTokens(message.usage), contextWindow, settings)) return false;
			// Avoid stopping for compaction when the fixed prefix already exceeds its threshold.
			if (contextWindow - settings.reserveTokens < this._estimateFixedPrefixTokens()) return false;
			this._midRunCompactionStop = true;
			return true;
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			try {
				l(event);
			} catch (error) {
				console.error("AgentSession event listener failed", error);
			}
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		if (event.type === "agent_start") {
			this._extensionStopAfterTurnReason = undefined;
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
		if (event.type === "agent_end") {
			this._extensionStopAfterTurnReason = undefined;
			// Free base64 payloads of images that fell out of the model-facing
			// budget. This turn's messages were persisted synchronously on
			// message_end, and the retired set is a subset of what the transient
			// provider view already replaces, so this is durable-safe and
			// cache-neutral (my-pi#1147). Exception: before the first assistant
			// message lands, the deferred first flush still buffers entries that
			// share object references with resident state — retiring then would
			// write placeholders into the durable JSONL, so skip until flushed.
			if (!this.sessionManager.hasPendingDurableEntries()) {
				retireOutOfBudgetContextImages(this.agent.state.messages);
			}
		}

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}

				this._appendCacheHealthEntry(assistantMsg);
			}
		}
	};

	/**
	 * Estimate token count for the immovable prefix (system prompt + tool schemas)
	 * that compaction cannot remove. Used by the fixed-prefix-overflow guard to
	 * detect when compaction would be a structural no-op. Uses the same chars/4
	 * heuristic as estimateSystemPromptTokens/estimateTokens elsewhere in this file.
	 */
	private _estimateFixedPrefixTokens(): number {
		const systemPromptTokens = estimateSystemPromptTokens(this.systemPrompt);
		const tools = this.agent.state.tools;
		const toolsTokens = tools && tools.length > 0 ? Math.ceil(JSON.stringify(tools).length / 4) : 0;
		return systemPromptTokens + toolsTokens;
	}

	/**
	 * Count assistant turns since the most recent compaction (or total assistant
	 * turns if there is no compaction yet). Shared by cache-health bookkeeping
	 * and the auto-compaction rapid-refill breaker so both use one definition
	 * of "turns since compaction".
	 */
	private _assistantTurnsAfterCompaction(branch: ReturnType<SessionManager["getBranch"]>): number {
		const assistantEntries = branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		const assistantTurn = assistantEntries.length;
		const latestCompaction = getLatestCompactionEntry(branch);
		return latestCompaction
			? branch
					.slice(branch.findIndex((entry) => entry.id === latestCompaction.id) + 1)
					.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length
			: assistantTurn;
	}

	private _appendCacheHealthEntry(message: AssistantMessage): void {
		const branch = this.sessionManager.getBranch();
		const assistantTurn = branch.filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		).length;
		const latestCompaction = getLatestCompactionEntry(branch);
		const assistantTurnsAfterCompaction = this._assistantTurnsAfterCompaction(branch);
		const postCompactionTurn = latestCompaction !== null && assistantTurnsAfterCompaction <= 1;
		const currentAssistantIndex = branch.length - 1;
		let previousAssistantIndex = -1;
		for (let i = currentAssistantIndex - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				previousAssistantIndex = i;
				break;
			}
		}
		const previousAssistantEntry = previousAssistantIndex >= 0 ? branch[previousAssistantIndex] : undefined;
		const entriesSincePreviousAssistant = branch.slice(previousAssistantIndex + 1, currentAssistantIndex);
		const exemptions = entriesSincePreviousAssistant.some((entry) => entry.type === "model_change")
			? ["model_change" as const]
			: [];
		// Non-tool-result user input between assistant turns triggers Anthropic's
		// thinking-block strip; cache-health uses it to classify the expected
		// one-time prefix rewrite as thinking_strip_likely.
		// Whether an entry is a boundary is decided by what it becomes on the wire,
		// so ask the converter rather than re-listing roles here. Injected
		// notifications, bash records, and branch/compaction summaries all become
		// `role:"user"`; a `!!`-prefixed bash record is dropped from context and is
		// correctly not a boundary. Enumerating roles by hand drifted from this and
		// mislabelled the resulting breaks as cache_write_unhealthy.
		const followsUserTurn = entriesSincePreviousAssistant.some(
			(entry) => entry.type === "message" && convertToLlm([entry.message])[0]?.role === "user",
		);
		const currentEntry = branch[currentAssistantIndex];
		const model = (message as { model?: string }).model ?? this.model?.id ?? "unknown";
		const timestamp =
			currentEntry?.timestamp ??
			(Number.isFinite(message.timestamp) ? new Date(message.timestamp).toISOString() : new Date().toISOString());
		const previousAssistant =
			previousAssistantEntry?.type === "message" && previousAssistantEntry.message.role === "assistant"
				? {
						usage: (previousAssistantEntry.message as AssistantMessage).usage,
						timestamp: previousAssistantEntry.timestamp,
						model: (previousAssistantEntry.message as AssistantMessage & { model?: string }).model,
					}
				: undefined;
		const health = {
			...computeCacheHealth({
				usage: message.usage,
				timestamp,
				model,
				assistantTurn,
				postCompactionTurn,
				exemptions,
				previousAssistant,
				followsUserTurn,
			}),
			sessionId: this.sessionManager.getSessionId(),
			turn: assistantTurn,
			model,
			timestamp,
		};
		this.sessionManager.appendCustomEntry("cache_health", health);
		if (health.warnings.length > 0) this._emit(health);
	}

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _emitIdleCacheHintIfNeeded(assistantMessage: AssistantMessage): void {
		if (assistantMessage.stopReason === "aborted" || assistantMessage.stopReason === "error") return;
		if (this._lastIdleCacheHintAssistantTimestamp === assistantMessage.timestamp) return;

		const cacheTokens = assistantMessage.usage.cacheRead + assistantMessage.usage.cacheWrite;
		if (cacheTokens <= 0) return;

		const idleMs = Date.now() - assistantMessage.timestamp;
		if (idleMs < IDLE_CACHE_HINT_MS) return;

		this._lastIdleCacheHintAssistantTimestamp = assistantMessage.timestamp;
		this._emit({
			type: "idle_cache_hint",
			idleMs,
			cacheTtlMs: IDLE_CACHE_HINT_MS,
			message:
				"This session has been idle long enough that prompt-cache warmth may be gone. For broad follow-up work, prefer cache-efficient forks (`explore`/`decompose`) or compact first if you need a handoff summary.",
		});
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return;
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		this._disposed = true;
		for (const unsubscribe of this._backgroundAgentTerminalUnsubscribers) unsubscribe();
		this._backgroundAgentTerminalUnsubscribers.clear();
		this._unsubscribeBashBgNotification?.();
		this._unsubscribeBashBgNotification = undefined;
		// Fire extension dispose hooks before invalidating the runner so handlers
		// can still observe their own state. Errors are isolated per handler.
		this._extensionRunner.fireSessionDispose();
		// Abort any in-flight session work so nothing keeps running past dispose.
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}
		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		this._cacheHeartbeat.dispose();
		if (this._idleWakeTimer) {
			clearTimeout(this._idleWakeTimer);
			this._idleWakeTimer = undefined;
		}
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Auto-model alias selected but not yet semantically resolved. */
	get pendingAutoModelAlias(): string | undefined {
		return this._pendingAutoModelRequest?.requestedModel;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		// Full busy predicate (regression #295): raw streaming windows, compaction,
		// and in-flight turn calls all report busy. Turn calls entered by the
		// current async context are excluded so extension handlers that run inside
		// a turn (agent_settled, command handlers resuming from waitForIdle) see
		// the session's state, not their own call (regression #6363).
		const foreignTurnCalls = this._activeTurnCalls - (this._turnCallScope.getStore() ?? 0);
		return (
			foreignTurnCalls <= 0 &&
			!this.isStreaming &&
			!this.agent.state.isStreaming &&
			!this.isCompacting &&
			!this.agent.isProcessing
		);
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/**
	 * Override the base system prompt with pre-built bytes and freeze it.
	 *
	 * Used by fork children to inherit the parent's frozen turn-start system prompt,
	 * ensuring cache-identical API request prefixes (system + tools + messages must
	 * all match for a cache hit). Called after session creation, before the first
	 * agent.prompt() invocation.
	 *
	 * Setting the frozen flag prevents before_agent_start extension handlers from
	 * re-applying goal context / active-recall rewrites on top of a prompt that
	 * already contains them — which would produce double-injected bytes and a
	 * guaranteed cache miss on every turn.
	 */
	overrideBaseSystemPrompt(prompt: string): void {
		this._baseSystemPrompt = prompt;
		this.agent.state.systemPrompt = prompt;
		this._systemPromptFrozen = true;
	}

	/**
	 * Returns the system prompt as it would appear after all `before_agent_start`
	 * handlers have applied their rewrites in preview mode (no side effects).
	 * Used by diagnostic UIs (e.g. /context) so the displayed prompt matches
	 * what the LLM will actually see, even before the first turn.
	 */
	async getEffectiveSystemPrompt(): Promise<string> {
		if (!this._baseSystemPromptOptions) return this.systemPrompt;
		return this._extensionRunner.previewSystemPromptRewrites(this._baseSystemPrompt, this._baseSystemPromptOptions);
	}

	/**
	 * Apply child-only transforms to a prompt inherited from another session.
	 * The executor calls this before freezing a fork prefix; the parent session
	 * and its cache-bearing prompt remain untouched.
	 */
	getForkSystemPrompt(systemPrompt: string): string {
		return this._extensionRunner.applyForkSystemPromptTransforms(systemPrompt);
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Executable active tools in provider order. Internal fork lifecycle input:
	 * children prefer their own freshly-built handlers, then reuse a parent tool
	 * only when that handler is absent (for example, a deferred process tool that
	 * was activated after the parent session started). */
	getActiveExecutableTools(): AgentTool[] {
		return [...this.agent.state.tools];
	}

	inheritMissingActiveTools(parentTools: readonly AgentTool[]): void {
		const childByName = new Map(this.agent.state.tools.map((tool) => [tool.name, tool]));
		this._inheritedForkToolFallbacks = new Map(parentTools.map((tool) => [tool.name, tool]));
		this.agent.state.tools = parentTools.map((parentTool) => childByName.get(parentTool.name) ?? parentTool);
	}

	/** Provider-visible metadata for the currently active tools, in wire order. */
	getActiveToolProviderSchemas(): Tool[] {
		return this.agent.state.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			deferLoading: tool.deferLoading,
			alwaysLoad: tool.alwaysLoad,
			searchHint: tool.searchHint,
			namespace: tool.namespace,
			providers: tool.providers,
			anthropicServerTool: tool.anthropicServerTool,
		}));
	}

	/**
	 * Overlay frozen provider metadata while retaining this session's local
	 * execute handlers. Used by cache-compatible children so tools serialize
	 * exactly like the parent without inheriting parent-bound closures.
	 */
	overrideActiveToolProviderSchemas(schemas: readonly Tool[]): void {
		const currentNames = this.getActiveToolNames();
		const schemaNames = schemas.map((schema) => schema.name);
		if (
			currentNames.length !== schemaNames.length ||
			currentNames.some((name, index) => name !== schemaNames[index])
		) {
			throw new Error(
				`Cannot preserve parent tool schemas: child tools [${currentNames.join(", ")}] do not match parent tools [${schemaNames.join(", ")}]`,
			);
		}
		this._activeToolProviderSchemaOverrides = new Map(schemas.map((schema) => [schema.name, schema]));
		this._activeToolProviderSchemaOrder = schemaNames;
		this._activeToolProviderSchemaCache = new WeakMap();
		this.agent.state.tools = this._applyActiveToolProviderSchemaOverrides(this.agent.state.tools);
	}

	/** Reuse a parent's cache-affinity lane for an inherited prompt prefix. */
	overridePromptCacheAffinityKey(key: string): void {
		this.agent.cacheAffinityKey = key;
	}

	/** The exact affinity key the SDK would send for the current model-facing prefix. */
	getPromptCacheAffinityKey(): string | undefined {
		const model = this.model;
		if (!model) return undefined;
		return this.agent.cacheAffinityKey ?? createPromptCacheAffinityKey(model, this.agent.state);
	}

	private _applyActiveToolProviderSchemaOverrides(tools: AgentTool[]): AgentTool[] {
		const overrides = this._activeToolProviderSchemaOverrides;
		if (!overrides) return tools;
		const expectedNames = this._activeToolProviderSchemaOrder ?? [];
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		const aligned = expectedNames.map((name) => byName.get(name) ?? this._inheritedForkToolFallbacks?.get(name));
		if (aligned.some((tool) => !tool)) {
			const actualNames = tools.map((tool) => tool.name);
			throw new Error(
				`Cannot preserve parent tool schemas after registry refresh: child tools [${actualNames.join(", ")}] do not match parent tools [${expectedNames.join(", ")}]`,
			);
		}
		return (aligned as AgentTool[]).map((tool) => {
			const schema = overrides.get(tool.name);
			if (!schema) return tool;
			const cached = this._activeToolProviderSchemaCache.get(tool);
			if (cached) return cached;
			const overlaid = { ...tool, ...schema };
			this._activeToolProviderSchemaCache.set(tool, overlaid);
			return overlaid;
		});
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	getToolDefinitions(): ToolDefinition[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition }) => definition);
	}

	/**
	 * Resumability seam for interactive (UI-only) tools - see ToolDefinition.resumePendingCall.
	 *
	 * If the transcript's last message is an assistant turn with exactly one
	 * unresolved tool call, and that tool opted in via resumePendingCall,
	 * re-execute it now (e.g. AskUserQuestion re-presents its dialog after a
	 * killed/resumed session) and feed the real result back into the agent loop
	 * via agent.prompt() - the same path a live tool result takes, so session
	 * persistence and extension events stay consistent.
	 *
	 * No-ops (returns false) when there is no pending call, more than one
	 * pending call, or the tool doesn't opt in - every other tool keeps today's
	 * behavior (a stale call is left for the generic orphaned-tool-call
	 * synthetic-error fallback, so a resumed session never silently re-runs e.g.
	 * a pending bash/edit call). All pending-question state lives in the
	 * transcript's already-persisted tool call - nothing here touches the
	 * cached system prefix (prompt-cache golden rule).
	 */
	async resumePendingInteractiveToolCall(): Promise<boolean> {
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		if (!last || last.role !== "assistant") return false;

		const toolCalls = (last as AssistantMessage).content.filter((block) => block.type === "toolCall");
		if (toolCalls.length !== 1) return false;
		const toolCall = toolCalls[0] as { id: string; name: string; arguments: Record<string, unknown> };

		const definition = this.getToolDefinition(toolCall.name);
		if (!definition?.resumePendingCall) return false;

		const tool = this.agent.state.tools.find((candidate) => candidate.name === toolCall.name);
		if (!tool) return false;

		if (this.agent.state.isStreaming) return false;

		return this._withActiveTurnCall(async () => {
			const result = await tool.execute(toolCall.id, toolCall.arguments, undefined, undefined);
			const toolResultMessage: ToolResultMessage = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: result.content,
				details: result.details,
				isError: false,
				timestamp: Date.now(),
			};
			await this.agent.prompt(toolResultMessage);
			return true;
		});
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		// Fix #3 full variant (cache-break-investigation-2026-05-16.md §7.3 c):
		// builtin and alwaysLoad-tagged tools that were active before this call
		// stay active. Bridge log shows Bash/Edit/Write/Grep/Read each removed
		// ~2,560× per 18d — most plausibly extensions calling setActiveTools()
		// with a narrow list that doesn't re-include builtins (e.g. pi-tool-search
		// computing a curated active set, deferred-tool activation paths).
		//
		// Protection is additive and gated:
		//   - Only restores tools that were ALREADY active. Sessions created
		//     with `noTools: "builtin"` (builtins registered but inactive) stay
		//     inactive — we never add a tool that wasn't already active.
		//   - Only restores builtins (`allToolNames` set) and `alwaysLoad:true`
		//     tools. Extension tools and deferred tools follow the caller's
		//     replacement list as before.
		const orderedNames: string[] = [...toolNames];
		const previousActive = new Set(this.getActiveToolNames());
		for (const name of previousActive) {
			const tool = this._toolRegistry.get(name);
			if (!tool) continue;
			if (allToolNames.has(name as ToolName) || tool.alwaysLoad === true) {
				orderedNames.push(name);
			}
		}

		const activeToolNames =
			this.model?.provider === "claude-bridge"
				? syncClaudeBridgeNativeTools(orderedNames, this.model)
				: this.model?.api === "openai-codex-responses"
					? orderedNames.filter((name) => /^[a-zA-Z0-9_-]+$/.test(name))
					: orderedNames;

		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		const seenToolNames = new Set<string>();
		for (const name of activeToolNames) {
			if (seenToolNames.has(name)) continue;
			const tool = this._toolRegistry.get(name);
			if (tool && isToolAvailableForModel(tool, this.model)) {
				seenToolNames.add(name);
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		// CACHE CRITICAL (cache law #4): if the rebuilt tools[] is element-for-element
		// reference-identical to the current state, do NOT rewrite state.tools or
		// rebuild the system prompt — an unconditional refresh bursts the
		// within-session tools[] (and system) cache prefix. This absorbs the no-op
		// _refreshToolRegistry → setActiveToolsByName churn on tools_changed events.
		//
		// Reference-equality (not name-set equality) is the correct guard: pi rebuilds
		// the registry with NEW object refs whenever a definition changes (e.g. a tool
		// gains deferLoading, or an allowlist empties out), so a genuine change yields
		// different refs and the rebuild proceeds; only a true no-op call (same refs in
		// same order) early-returns. This mirrors pi-ai's convertedToolCache WeakMap,
		// which memoizes serialization by tool reference.
		//
		// Skip the guard until the base prompt has been built at least once
		// (_baseSystemPromptOptions is set only by _rebuildSystemPrompt). On init the
		// empty→empty case is reference-equal but the prompt has never been built, and
		// there is no warm cache to protect — the first build must run.
		const providerStableTools = this._applyActiveToolProviderSchemaOverrides(tools);
		const current = this.agent.state.tools;
		if (
			this._baseSystemPromptOptions &&
			current.length === providerStableTools.length &&
			current.every((t, i) => t === providerStableTools[i])
		)
			return;

		this.agent.state.tools = providerStableTools;
		if (this._systemPromptFrozen) return;

		// Rebuild base system prompt with new tool set. The rebuild is UNFILTERED
		// (skips systemPrompt:build); mark for re-filtering before the next send.
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
		this._systemPromptNeedsRefilter = true;
	}

	/**
	 * Post-registration deferral seam (cache-critical).
	 *
	 * Marks already-registered tools as `deferLoading:true` so EVERY consumer
	 * agrees the tool is a deferred stub rather than a full schema:
	 * `getToolDefinitions()`, core `isDeferredTool`, and the pi-ai providers that
	 * serialize `defer_loading`. This lets an extension (e.g. tool-search) make a
	 * tool deferrable without the tool's own registration opting in.
	 *
	 * Generic and idempotent. Apply ONCE before the first request: calling with an
	 * unchanged override set is a no-op so the within-session `tools[]` cache prefix
	 * is not burst by a needless refresh. Names that are `alwaysLoad`, or already
	 * natively `deferLoading` (and not part of this override), are ignored — those
	 * are never forced. Dropping a name from the set restores its original
	 * `deferLoading` on the next rebuild (the registry is reconstructed from the
	 * base/extension definitions, so the original value returns automatically).
	 */
	setDeferredToolOverrides(names: string[]): void {
		const desired = new Set<string>();
		for (const name of names) {
			const entry = this._toolDefinitions.get(name);
			if (!entry) continue;
			const definition = entry.definition;
			// Never override alwaysLoad tools.
			if (definition.alwaysLoad === true) continue;
			// Skip tools that are natively deferLoading on their own (not via this
			// override) — there is nothing to force. Tools already in the override set
			// report deferLoading:true because WE set it, so keep them to stay idempotent.
			if (definition.deferLoading === true && !this._deferredOverrides.has(name)) continue;
			desired.add(name);
		}

		// CACHE CRITICAL: an unchanged set must not trigger a refresh — an
		// unconditional rebuild bursts the within-session tools[] cache.
		if (sameStringSet(this._deferredOverrides, desired)) return;

		this._deferredOverrides = desired;
		// Rebuild via the same path registration uses; _applyDeferredOverrides()
		// re-applies the override onto the freshly rebuilt registry/definitions.
		this._refreshToolRegistry();
	}

	/**
	 * Post-registration namespace seam (cache-critical).
	 *
	 * Annotates already-registered tools with a `namespace` label so provider
	 * serializers can group related tools into a provider-native namespace. This is
	 * pure serialization metadata — it does NOT change deferral, activation, or any
	 * tool behavior. The policy owner (tool-search) computes name->namespace and
	 * calls this once before the first request.
	 *
	 * Generic and idempotent. An unchanged map is a no-op so the within-session
	 * `tools[]` cache prefix is not burst by a needless refresh. Passing an empty
	 * map clears all namespaces on the next rebuild (the registry is reconstructed
	 * from base/extension definitions, so the original undefined returns).
	 */
	setToolNamespaces(map: Record<string, string>): void {
		const desired = new Map<string, string>();
		for (const [name, namespace] of Object.entries(map)) {
			if (!namespace) continue;
			if (!this._toolDefinitions.has(name)) continue;
			desired.set(name, namespace);
		}

		// CACHE CRITICAL: an unchanged map must not trigger a refresh — an
		// unconditional rebuild bursts the within-session tools[] cache.
		if (sameStringMap(this._toolNamespaces, desired)) return;

		this._toolNamespaces = desired;
		// Rebuild via the same path registration uses; _applyToolNamespaces()
		// re-stamps the namespace onto the freshly rebuilt registry/definitions.
		this._refreshToolRegistry();
	}

	/**
	 * Stamp the `namespace` label from `_toolNamespaces` onto the freshly rebuilt
	 * `_toolDefinitions` (shallow-copied so the shared base definition is untouched)
	 * and `_toolRegistry` entries. Called from _refreshToolRegistry() so the
	 * annotation survives every registry rebuild. No-op when the map is empty.
	 */
	private _applyToolNamespaces(): void {
		if (this._toolNamespaces.size === 0) return;
		for (const [name, namespace] of this._toolNamespaces) {
			const entry = this._toolDefinitions.get(name);
			if (entry && entry.definition.namespace !== namespace) {
				entry.definition = { ...entry.definition, namespace };
			}
			const tool = this._toolRegistry.get(name);
			if (tool && tool.namespace !== namespace) {
				tool.namespace = namespace;
			}
		}
	}

	/**
	 * Force `deferLoading:true` on every name in `_deferredOverrides`, mutating the
	 * freshly rebuilt `_toolDefinitions` (shallow-copied so the shared base
	 * definition is untouched) and `_toolRegistry` entries. Called from
	 * _refreshToolRegistry() so the override survives every registry rebuild.
	 */
	private _applyDeferredOverrides(): void {
		if (this._deferredOverrides.size === 0) return;
		for (const name of this._deferredOverrides) {
			const entry = this._toolDefinitions.get(name);
			if (entry && entry.definition.alwaysLoad !== true && entry.definition.deferLoading !== true) {
				entry.definition = { ...entry.definition, deferLoading: true };
			}
			const tool = this._toolRegistry.get(name);
			if (tool && tool.alwaysLoad !== true && tool.deferLoading !== true) {
				tool.deferLoading = true;
			}
		}
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			// CACHE CRITICAL: deferred tools keep schemas out of the prefix via
			// defer_loading; their prompt prose must follow. Guidelines/snippets for
			// deferred tools are delivered in the tool_search result (transcript
			// suffix) on discovery — never written into the cached system prompt.
			const definition = this._toolDefinitions.get(name)?.definition;
			if (definition && isDeferredTool(definition)) {
				continue;
			}
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	/**
	 * Re-apply the `systemPrompt:build` filters to the base prompt when a
	 * mid-turn tool/skill change rebuilt it unfiltered.
	 *
	 * CACHE CRITICAL: `_rebuildSystemPrompt` returns a raw `buildSystemPrompt`
	 * output that skips the filter chain (filters only run in
	 * `_runBeforeAgentStart`). Sending that raw prompt drops cache-stabilising
	 * transforms (time-context date strip, cache-base-prompt boundary
	 * relocation), mutating the cached prefix and bursting the prompt cache on
	 * every tool change. Re-apply the filters to the CURRENT base prompt — the
	 * same input `_runBeforeAgentStart` filters each turn, minus the handler
	 * pass. Filters are idempotent (no-op when already applied), so a clobbered
	 * unfiltered prompt is healed while handler-appended content and the current
	 * tool snippets baked into `_baseSystemPrompt` are preserved. Runs at the
	 * single send chokepoint (`_runAgentPrompt`); no-op unless a rebuild occurred.
	 */
	private async _refilterSystemPromptIfNeeded(): Promise<void> {
		if (!this._systemPromptNeedsRefilter) return;
		this._systemPromptNeedsRefilter = false;
		if (this._systemPromptFrozen || !this._baseSystemPromptOptions) return;
		const filtered = await this._extensionRunner.applySystemPromptBuildFilters(
			this._baseSystemPrompt,
			this._baseSystemPromptOptions,
		);
		if (filtered === this._baseSystemPrompt) return;
		this._baseSystemPrompt = filtered;
		this.agent.state.systemPrompt = filtered;
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _withActiveTurnCall<T>(operation: () => Promise<T>): Promise<T> {
		this._activeTurnCalls++;
		try {
			return await this._turnCallScope.run((this._turnCallScope.getStore() ?? 0) + 1, operation);
		} finally {
			this._activeTurnCalls--;
			// Turn-call exit can complete an idle window that the settle emit saw as
			// busy (the settling prompt's own call was still unwinding); wake waiters
			// so they re-check isIdle in their own context.
			this._resolveIdleWaitIfIdle();
		}
	}

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		try {
			// A turn is starting — cancel any pending idle wake. The notification
			// that scheduled it is already in messages[], so this turn reads it;
			// firing the wake afterwards would add a spurious extra turn (even if
			// this turn finishes before the debounce window elapses).
			this._cancelIdleWake();
			await this._refilterSystemPromptIfNeeded();
			this._cacheHeartbeat.setSessionTarget(this._findLastAssistantMessage()?.timestamp);
			this._cacheHeartbeat.noteActivity();
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			await this._emitAgentSettled();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (msg.stopReason === "aborted") {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		this._cacheHeartbeat.setSessionTarget(msg.timestamp);
		this._cacheHeartbeat.noteActivity();
		if (this._midRunCompactionStop) {
			// The loop was stopped at a turn boundary by the mid-run cap. Compact
			// now ("run", not "defer") and always resume — the interrupted run
			// still has tool results or queued messages waiting for the model.
			// If compaction can't run (prep failed, aborted), resuming uncompacted
			// is still correct; the overflow path remains the backstop.
			this._midRunCompactionStop = false;
			await this._checkCompaction(msg, true, "run");
			return true;
		}
		if (await this._checkCompaction(msg, true, "defer")) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Deliver messages queued while manual compaction held the busy gate.
	 * compact() aborts any active run first, so no run is in flight to drain
	 * the queue and nothing else kicks one off — without this, a message
	 * steered during /compact would sit undelivered until the next prompt
	 * (or be lost on process exit). Fire-and-forget: failures leave the
	 * message queued (pre-drain status quo) rather than crashing the caller.
	 */
	private _drainQueuedMessagesPostCompaction(): void {
		if (this._disposed || !this.agent.hasQueuedMessages()) return;
		if (this.isStreaming || this.isCompacting || this.agent.isProcessing) return;
		void (async () => {
			try {
				await this.agent.continue();
				while (await this._handlePostAgentRun()) {
					await this.agent.continue();
				}
			} catch {
				// Racing run started or continue() rejected the trailing message
				// shape: an active run drains the queue itself; otherwise the
				// message stays visibly queued for the next turn.
			}
		})();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		await this._withActiveTurnCall(() => this._prompt(text, options));
	}

	private async _prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			if (this._compactionAbortController !== undefined) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If a run is in flight, queue via steer() or followUp() based on option.
			// isStreaming alone is NOT a complete busy signal: compaction runs its
			// LLM calls outside agent.runWithLifecycle() (isStreaming stays false),
			// and agent.isProcessing covers the setup window inside prompt() and
			// the agent_end listener phase. Prompts sent in those windows used to
			// fall through and race agent.prompt(), rejecting with "Agent is
			// already processing a prompt" — fatal for un-awaited callers
			// (extension sendUserMessage). Same gate as sendCustomMessage.
			if (this.isStreaming || this.isCompacting || this.agent.isProcessing) {
				// Preserve the strict contract while visibly streaming; in the
				// compaction/setup windows default to steer so the message is
				// queued and delivered instead of racing or being dropped.
				// Strict contract only while the LLM is visibly streaming (raw agent
				// flag) — session.isStreaming now tracks the whole run
				// (_isAgentRunActive), which includes the compaction/agent_end windows
				// where the fork must default to steer instead of throwing.
				const behavior = options?.streamingBehavior ?? (this.agent.state.isStreaming ? undefined : "steer");
				if (!behavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (behavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			await this._resolvePendingAutoModelForPrompt(expandedText);

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we should warn or compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				this._emitIdleCacheHintIfNeeded(lastAssistant);
				await this._checkCompaction(lastAssistant, false);
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event. Forward the prompt's source
			// (defaulting to "interactive") so hooks can discriminate user-driven
			// turns from machine-driven ones (child-agent runs, extension steers).
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
				options?.source ?? "interactive",
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base.
			// Skip when the prompt is frozen (fork child inheriting parent's bytes) —
			// extensions would double-inject goal/recall context that is already
			// present in the parent's prompt, producing different bytes every turn.
			if (!this._systemPromptFrozen) {
				if (result?.systemPrompt !== undefined) {
					// Promote to _baseSystemPrompt so subsequent turns that return no
					// systemPrompt reset to this extended prompt, not the pre-injection
					// base. Preserve it as an override during tool refresh as well.
					this._baseSystemPrompt = result.systemPrompt;
					this._systemPromptOverride = result.systemPrompt;
					this.agent.state.systemPrompt = result.systemPrompt;
				} else {
					// Reset to stable base (covers pre-modification turns and all
					// turns after a one-shot extension injection has promoted the base).
					this._systemPromptOverride = undefined;
					this.agent.state.systemPrompt = this._baseSystemPrompt;
				}
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		try {
			await this._runAgentPrompt(messages);
		} catch (err) {
			// TOCTOU: a run can start between the busy gate above and
			// agent.prompt() (post-compaction resume, extension-triggered turn).
			// Route the built messages into the delivery queue instead of
			// rejecting — the active run drains the queue, so the prompt is
			// delivered instead of crashing the caller (an un-awaited
			// session.prompt() rejection killed the process). Mirrors
			// sendCustomMessage's fallback. Match ONLY agent.prompt()'s
			// pre-delivery error — the post-run continue() throws a similar
			// "already processing" error, but by then the messages were already
			// delivered and re-queueing them would duplicate the prompt.
			if (!(err instanceof Error) || !err.message.includes("already processing a prompt")) {
				throw err;
			}
			const behavior = options?.streamingBehavior ?? "steer";
			const mirror = behavior === "followUp" ? this._followUpMessages : this._steeringMessages;
			for (const message of messages) {
				if (message.role === "user" && Array.isArray(message.content)) {
					// join("") matches _getUserMessageText so the queue-display
					// mirror entry is removed when the message is delivered.
					const text = message.content
						.filter((part): part is TextContent => part.type === "text")
						.map((part) => part.text)
						.join("");
					if (text) mirror.push(text);
				}
				if (behavior === "followUp") {
					this.agent.followUp(message);
				} else {
					this.agent.steer(message);
				}
			}
			this._emitQueueUpdate();
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 * @param options.wakeOnIdle If true and the message lands via the idle branch
	 *   (not streaming, no triggerTurn), schedule one debounced continuation turn so
	 *   the model reads the notification autonomously. Busy delivery is unaffected —
	 *   the queue already drains into the active run. No-op when triggerTurn is set.
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; wakeOnIdle?: boolean },
	): Promise<void> {
		let landedAtIdle = false;
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		const emitCustomMessage = () =>
			this._extensionRunner.emit({ type: "custom_message" as const, message: appMessage });
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
			await emitCustomMessage();
		} else if (this.isStreaming || this.isCompacting || this.agent.isProcessing) {
			// Treat compaction and any in-flight run as streaming-equivalent for delivery
			// routing. Compaction runs its own LLM calls outside agent.runWithLifecycle(),
			// so state.isStreaming is false even though the agent is busy and a regular
			// turn cannot be started. agent.isProcessing also covers the brief setup
			// window inside prompt() and the agent_end listener phase — windows where
			// isStreaming may be false but a fresh prompt() would still throw
			// "Agent is already processing a prompt". Without this, custom messages
			// arriving during those windows (e.g. monitor exit notifications fired with
			// triggerTurn:true) either crash the runtime with that throw, or fall into
			// the bottom 'else' branch and get pushed raw onto messages[]. They never
			// enter the steering/follow-up queues, so the post-compaction recovery in
			// _runAutoCompaction (which only resumes on hasQueuedMessages()) never
			// kicks the loop, and the message rots in the transcript until the next
			// user prompt. Routing through the queues lets the existing
			// post-compaction continue() drain them.
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
			await emitCustomMessage();
		} else if (options?.triggerTurn) {
			await this._withActiveTurnCall(async () => {
				// Mirror prompt()'s pre-turn compaction check. Without it, harness-driven
				// turns (e.g. pi-goal continuations via sendCustomMessage({triggerTurn}))
				// never hit threshold compaction — context grows unbounded across goal
				// iterations until hard overflow. Compaction runs first; the custom
				// message then starts its turn against the compacted context.
				const lastAssistant = this._findLastAssistantMessage();
				if (lastAssistant) {
					if (await this._checkCompaction(lastAssistant, false)) {
						try {
							await this.agent.continue();
							while (await this._handlePostAgentRun()) {
								await this.agent.continue();
							}
						} finally {
							this._flushPendingBashMessages();
						}
					}
				}
				// Fire before_agent_start so extensions can modify the system prompt for
				// turns triggered by custom messages — same path as session.prompt()-driven
				// turns. Without this, e.g. pi-goal's `pendingControlPrompt` (set right
				// before triggerTurn:true) is never consumed and the model is invoked with
				// the base system prompt + an opaque custom message it can't see, so it
				// has no way to know what the goal/objective is.
				// triggerTurn fires for custom-message-driven turns. These are never
				// direct user input — the caller is an extension hook (e.g. pi-goal's
				// pendingControlPrompt). Tag as "extension" so memory hooks skip recall
				// and persistent-memory inject for these synthetic turns.
				const beforeStart = this._baseSystemPromptOptions
					? await this._extensionRunner.emitBeforeAgentStart(
							"",
							undefined,
							this._baseSystemPrompt,
							this._baseSystemPromptOptions,
							"extension",
						)
					: undefined;
				const extraMessages: AgentMessage[] = [];
				if (beforeStart?.messages) {
					for (const msg of beforeStart.messages) {
						extraMessages.push({
							role: "custom",
							customType: msg.customType,
							content: msg.content,
							display: msg.display,
							details: msg.details,
							timestamp: Date.now(),
						});
					}
				}
				if (!this._systemPromptFrozen) {
					if (beforeStart?.systemPrompt) {
						// Promote to _baseSystemPrompt for the same reason as in prompt():
						// one-shot extension injections must persist as the stable prefix.
						this._baseSystemPrompt = beforeStart.systemPrompt;
						// CACHE CRITICAL: preserve as an override during mid-turn tool
						// refresh, mirroring prompt(). Without it, a mid-turn
						// setActiveTools (deferred-tool activation) swaps the raw
						// rebuilt prompt onto the wire — dropping handler-returned
						// content and mutating the stable system block, which busts the
						// prompt cache on machine-driven turns (monitor wakes, goal
						// continuations via sendCustomMessage({triggerTurn:true})).
						this._systemPromptOverride = beforeStart.systemPrompt;
						this.agent.state.systemPrompt = beforeStart.systemPrompt;
					} else if (this._baseSystemPrompt) {
						this._systemPromptOverride = undefined;
						this.agent.state.systemPrompt = this._baseSystemPrompt;
					}
				}
				const runOutcomePromise = this._runAgentPrompt(
					extraMessages.length > 0 ? [...extraMessages, appMessage] : appMessage,
				).then(
					() => ({ ok: true as const }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				await emitCustomMessage();
				const runOutcome = await runOutcomePromise;
				if (!runOutcome.ok) {
					// Defense-in-depth for a TOCTOU race: two extension callers can both
					// pass the streaming/compacting/isProcessing gate above, then race on
					// agent.prompt() — the first wins, the second throws "already
					// processing". Falling back to steer keeps the message in the active
					// run instead of dropping it (or surfacing a confusing
					// "Extension <runtime> error" to the user).
					if (
						runOutcome.error instanceof Error &&
						/already processing( a prompt)?/.test(runOutcome.error.message)
					) {
						this.agent.steer(appMessage);
					} else {
						throw runOutcome.error;
					}
				}
			});
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
			landedAtIdle = true;
			await emitCustomMessage();
		}
		if (landedAtIdle && options?.wakeOnIdle) this._scheduleIdleWake();
	}

	/**
	 * Schedule one debounced continuation turn after a wakeOnIdle message landed
	 * at idle. N notifications arriving in the same window collapse into a single
	 * wake. The busy re-check at fire time guards the race called out above
	 * `_emitAgentCompletion`: a user prompt (or another wake) starting a turn
	 * inside the window already has the notification in context — waking then
	 * would add a spurious extra turn. Even a racing wake is safe: the busy
	 * branch ordering in sendCustomMessage degrades triggerTurn to a queued
	 * followUp, never a double run.
	 */
	private _cancelIdleWake(): void {
		if (this._idleWakeTimer !== undefined) {
			clearTimeout(this._idleWakeTimer);
			this._idleWakeTimer = undefined;
		}
	}

	private _scheduleIdleWake(): void {
		if (this._disposed || this._idleWakeTimer !== undefined) return;
		this._idleWakeTimer = setTimeout(() => {
			this._idleWakeTimer = undefined;
			if (this._disposed) return;
			// Transient-busy at fire time (turn-starting call, compaction, or agent
			// run) must NOT drop the wake: the completion notification is already
			// in history, but the turn-trigger would be lost forever. A turn already
			// in progress has the notification in context and is self-healing, yet a
			// threshold/overflow compaction overlapping this window rewrites history
			// and leaves the session idle with an unhandled notification. Re-arm one
			// debounce window later so the wake survives until genuinely idle.
			if (!this.isIdle) {
				this._scheduleIdleWake();
				return;
			}
			void this.sendCustomMessage(
				{
					customType: "idle-wake",
					content:
						"Background work finished while you were idle (see the completion notification above). Handle it now: read the result, continue the task it unblocks, or report the outcome. Do not wait for further user input if the next step is clear.",
					display: false,
					details: undefined,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			).catch(() => {
				/* sendCustomMessage logs its own runtime errors; never crash the timer. */
			});
		}, AgentSession.IDLE_WAKE_DEBOUNCE_MS);
		this._idleWakeTimer.unref?.();
	}

	private static readonly IDLE_WAKE_DEBOUNCE_MS = 300;

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * While streaming, deliverAs is required; other busy windows default to "steer".
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode while busy: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/**
	 * Remove the most recently queued message and return it for editing.
	 * Prefers follow-up messages over steering, since follow-ups are the
	 * messages a user typically queues last. Removes the entry from both the
	 * display mirror and the underlying agent delivery queue so the recalled
	 * message is not also sent to the model. Returns null when nothing is
	 * queued.
	 */
	popLastQueuedMessage(): { text: string; mode: "steer" | "followUp" } | null {
		if (this._followUpMessages.length > 0) {
			const text = this._followUpMessages.pop() as string;
			this.agent.removeLastFollowUpMessage();
			this._emitQueueUpdate();
			return { text, mode: "followUp" };
		}
		if (this._steeringMessages.length > 0) {
			const text = this._steeringMessages.pop() as string;
			this.agent.removeLastSteeringMessage();
			this._emitQueueUpdate();
			return { text, mode: "steer" };
		}
		return null;
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	/** Abort the active turn, then deliver any queued messages using the configured queue modes. */
	abortAndResumeQueuedMessages(): Promise<void> {
		if (this._abortAndResumeQueuedPromise) return this._abortAndResumeQueuedPromise;
		const operation = this._abortAndResumeQueuedMessages();
		this._abortAndResumeQueuedPromise = operation;
		const clearOperation = () => {
			if (this._abortAndResumeQueuedPromise === operation) {
				this._abortAndResumeQueuedPromise = undefined;
			}
		};
		void operation.then(clearOperation, clearOperation);
		return operation;
	}

	private async _abortAndResumeQueuedMessages(): Promise<void> {
		this.abortRetry();
		if (!this._isAgentRunActive) return;

		this.agent.abort();
		await this.waitForIdle();
		if (!this.agent.hasQueuedMessages()) return;

		await this._withActiveTurnCall(async () => {
			this._isAgentRunActive = true;
			try {
				while (this.agent.hasQueuedMessages()) {
					await this._refilterSystemPromptIfNeeded();
					this._cacheHeartbeat.setSessionTarget(this._findLastAssistantMessage()?.timestamp);
					this._cacheHeartbeat.noteActivity();
					await this.agent.continueQueuedMessage();
					while (await this._handlePostAgentRun()) {
						await this.agent.continue();
					}
				}
			} finally {
				this._systemPromptOverride = undefined;
				this._flushPendingBashMessages();
				await this._emitAgentSettled();
			}
		});
	}

	async waitForIdle(): Promise<void> {
		// Waiters re-check the full idle predicate in their own async context each
		// wake: the resolver only signals "no agent run active", which is weaker
		// than isIdle (foreign turn calls may still be unwinding).
		while (!this.isIdle) {
			await this._getIdleWaitPromise();
		}
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
		options?: { force?: boolean },
	): Promise<void> {
		const modelChanged = !modelsAreEqual(previousModel, nextModel);
		if (!modelChanged && !options?.force) return;
		this._emit({ type: "model_changed", model: nextModel, previousModel, source });
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
		if (!modelChanged) return;
		this._refreshToolRegistry({
			activeToolNames: syncClaudeBridgeNativeTools(this.getActiveToolNames(), nextModel),
			activateNewTools: false,
		});
		await this.extendResourcesFromExtensions("reload");
	}

	/**
	 * Select an auto-model alias that should resolve at the next prompt boundary.
	 */
	setPendingAutoModelAlias(requestedModel: string, routingMetadata?: Record<string, unknown>): void {
		const trimmed = requestedModel.trim();
		if (!trimmed) return;
		this._pendingAutoModelRequest = { requestedModel: trimmed, routingMetadata };
	}

	private async _resolvePendingAutoModelForPrompt(promptText: string): Promise<void> {
		const pending = this._pendingAutoModelRequest;
		if (!pending) return;

		const currentModel = this.model;
		if (!currentModel) {
			throw new Error(formatNoModelSelectedMessage());
		}

		const routing = {
			...(pending.routingMetadata ?? {}),
			promptPreview: promptText.slice(0, 6000),
			promptLength: promptText.length,
		};
		const resolved = await applyFilters(
			extensionHookNames.modelResolve,
			{
				requestedModel: pending.requestedModel,
				model: currentModel,
				thinkingLevel: this.thinkingLevel,
				metadata: { routing } as Record<string, unknown>,
			},
			{
				cwd: this._cwd,
				source: this._source,
				sessionId: this.sessionManager.getSessionId(),
				// A pending alias is resolved only at an explicit prompt/cache-domain boundary;
				// do not let startup's existing-session guard suppress this deliberate route.
				hasExistingSession: false,
				modelRegistry: this._modelRegistry,
				settingsManager: this.settingsManager,
				sessionManager: this.sessionManager,
			},
		);

		const nextModel = resolved.model ?? currentModel;
		const resolvedMetadata = resolved.metadata as Record<string, unknown> | undefined;
		const hasRoutingDecision =
			resolvedMetadata?.llmRouterDecision !== undefined ||
			resolvedMetadata?.llmRouterUnavailable !== undefined ||
			typeof resolvedMetadata?.tier === "string" ||
			!modelsAreEqual(currentModel, nextModel) ||
			(resolved.thinkingLevel !== undefined && resolved.thinkingLevel !== this.thinkingLevel);
		// Router explicitly unavailable OR no routing decision at all: the session
		// continues on the concrete fallback model, but say so as a custom message —
		// for child agents the executor lifts this into the parent-facing run
		// warnings so the caller can cancel and re-dispatch with an explicit model.
		const routerUnavailable = resolvedMetadata?.llmRouterUnavailable !== undefined;
		if (!hasRoutingDecision || routerUnavailable) {
			const message = routerUnavailable
				? `Auto model ${pending.requestedModel} could not be routed (semantic router unavailable); continuing with ${currentModel.provider}/${currentModel.id}.`
				: `Auto model ${pending.requestedModel} could not be routed (no routing decision); continuing with ${currentModel.provider}/${currentModel.id}.`;
			await this.sendCustomMessage(
				{
					customType: "model-routing-warning",
					content: message,
					display: true,
					details: {
						requestedModel: pending.requestedModel,
						provider: currentModel.provider,
						modelId: currentModel.id,
						reason: routerUnavailable ? "router_unavailable" : "no_routing_decision",
					},
				},
				{ triggerTurn: false },
			);
			// Router-unavailable still resolved to a concrete decision (keep current
			// model): fall through so the session records the model like any other
			// resolution. Only a true no-decision aborts here.
			if (!hasRoutingDecision) {
				this._pendingAutoModelRequest = undefined;
				return;
			}
		}
		if (!this._modelRegistry.hasConfiguredAuth(nextModel)) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		const previousModel = this.model;
		this.agent.state.model = nextModel;
		this.agent.cacheAffinityKey = createPromptCacheAffinityKey(nextModel, this.agent.state);
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.setThinkingLevel((resolved.thinkingLevel ?? this.thinkingLevel) as ThinkingLevel);
		this._pendingAutoModelRequest = undefined;

		await this._emitModelSelect(nextModel, previousModel, "set", { force: true });
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		this._pendingAutoModelRequest = undefined;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.agent.cacheAffinityKey = createPromptCacheAffinityKey(model, this.agent.state);
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this._pendingAutoModelRequest = undefined;
		this.agent.state.model = next.model;
		this.agent.cacheAffinityKey = createPromptCacheAffinityKey(next.model, this.agent.state);
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this._pendingAutoModelRequest = undefined;
		this.agent.state.model = nextModel;
		this.agent.cacheAffinityKey = createPromptCacheAffinityKey(nextModel, this.agent.state);
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	private _pruneResidentHistoryAfterCompaction(
		reason: "manual" | "threshold" | "overflow",
		compactionEntryId: string,
	): void {
		const settings = this.settingsManager.getCompactionSettings(this.model?.contextWindow);
		if (!settings.residentPrune) return;
		const result = this.sessionManager.pruneResidentHistoryAfterCompaction(compactionEntryId);
		this._emit({ type: "resident_prune", reason, result });
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings(this.model?.contextWindow);

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					requestModel,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason: "manual" }),
					{
						systemPrompt: this.systemPrompt,
						messages: stripModelFacingContextImages(await convertToLlm(this.agent.state.messages)),
						tools: this.agent.state.tools,
					},
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			const compactionEntryId = this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
			);
			this._pruneResidentHistoryAfterCompaction("manual", compactionEntryId);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			// Manual compaction is user-invoked, so nothing encloses it that would
			// flush later — unlike auto-compaction, which runs inside _runAgentPrompt.
			// A bash execution recorded during the summarization is deferred, and
			// without this it stays unpersisted until some future prompt.
			this._flushPendingBashMessages();
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
			this._drainQueuedMessagesPostCompaction();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Recoverable failure: LLM returned context overflow or stopped below its desired output limit;
	 *    remove the assistant message, compact, and auto-retry once
	 * 2. Threshold: Context over threshold, compact before the next user prompt. After agent_end, only mark it pending.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @param thresholdMode Whether threshold compaction should run now or wait for the next prompt
	 */
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		thresholdMode: "run" | "defer" = "run",
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings(this.model?.contextWindow);
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Recoverable failure. Explicit/silent context overflow still uses context metadata.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		// A successful response over the configured window should compact but must not retry: the
		// assistant answer already completed and agent.continue() cannot continue from an assistant.
		const recoverableLength = sameModel && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);
		if (sameModel && (isContextOverflow(assistantMessage, contextWindow) || recoverableLength)) {
			const willRetry = assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the failed or truncated message from agent state. It remains in session history,
			// but must not be included in the compact-and-retry context.
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			if (thresholdMode === "defer") return false;
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		// Failure circuit breaker: checked before anything else, including the rapid-refill
		// check below (CC 2.1.201 parity). Once tripped, auto-compaction is disabled for
		// the rest of the session and this short-circuit must not emit repeatedly.
		if (this._autoCompactDisabledThisSession) {
			return false;
		}

		const settings = this.settingsManager.getCompactionSettings(this.model?.contextWindow);
		let started = false;

		try {
			if (!this.model) {
				return false;
			}

			// Fixed-prefix-overflow guard: if the immovable prefix (system prompt + tools,
			// which compaction cannot remove) alone exceeds the compaction threshold,
			// compaction is a structural no-op - skip instead of attempting-then-looping.
			const compactionThreshold = this.model.contextWindow - settings.reserveTokens;
			const fixedPrefixTokens = this._estimateFixedPrefixTokens();
			// Scoped to the periodic "threshold" trigger only: an "overflow" recovery is a
			// one-off reactive attempt (the provider already hard-stopped) and still deserves
			// a real compaction attempt rather than a structural-no-op short-circuit.
			if (reason === "threshold" && fixedPrefixTokens > compactionThreshold) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Auto-compaction cannot help: the fixed prefix (system prompt + tools) alone exceeds the compaction threshold. Reduce pinned context or switch to a larger-context model.",
				});
				return false;
			}

			// Rapid-refill (thrashing) breaker: trips when context keeps refilling to the
			// limit within RAPID_REFILL_WINDOW turns of the previous compaction, repeatedly.
			const branchForRapidRefill = this.sessionManager.getBranch();
			const hadPriorCompaction = getLatestCompactionEntry(branchForRapidRefill) !== null;
			const turnsSinceCompaction = this._assistantTurnsAfterCompaction(branchForRapidRefill);
			const rapidRefill = evaluateRapidRefill({
				hadPriorCompaction,
				turnsSinceCompaction,
				consecutiveRapidRefills: this._consecutiveRapidRefills,
			});
			this._consecutiveRapidRefills = rapidRefill.consecutiveRapidRefills;
			if (rapidRefill.action === "trip") {
				// Reset so this does not re-emit on every subsequent compaction attempt.
				this._consecutiveRapidRefills = 0;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Auto-compaction is thrashing: context refilled to the limit within 3 turns of the previous compaction, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /new to start fresh.",
				});
				return false;
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			this._emit({ type: "compaction_start", reason });
			this._autoCompactionAbortController = new AbortController();
			started = true;

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const compactResult = await compact(
					preparation,
					requestModel,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason }),
					{
						systemPrompt: this.systemPrompt,
						messages: stripModelFacingContextImages(await convertToLlm(this.agent.state.messages)),
						tools: this.agent.state.tools,
					},
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			const compactionEntryId = this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
			);
			this._pruneResidentHistoryAfterCompaction(reason, compactionEntryId);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._consecutiveCompactionFailures = 0;
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				// The overflow response was persisted on message_end before _checkCompaction() removed it
				// from agent state. Rebuilding state from the new compaction can restore that kept entry,
				// leaving an assistant as the final message. agent.continue() rejects that state, so remove
				// the retriable error or truncated-length response again before continuing the interrupted turn.
				if (lastMsg?.role === "assistant" && (lastMsg.stopReason === "error" || lastMsg.stopReason === "length")) {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			// Transient provider-availability failures (rate limits / usage-limit
			// windows, overload shedding) do not count toward the failure circuit
			// breaker and do not reset an existing streak: they self-resolve (OpenAI
			// usage-limit 429s carry an explicit reset time) while the breaker
			// permanently disables auto-compaction — exactly wrong for a session
			// that resumes working once the limit resets and then dies at the
			// context-window limit with compaction disabled. The threshold check
			// simply retries compaction on a later turn.
			if (isTransientCompactionError(errorMessage)) {
				if (started) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: false,
						willRetry: false,
						errorMessage: `${
							reason === "overflow" ? "Context overflow recovery" : "Auto-compaction"
						} hit a transient provider error; it will be retried and does not count toward the circuit breaker: ${errorMessage}`,
					});
				}
				return false;
			}
			this._consecutiveCompactionFailures++;
			if (this._consecutiveCompactionFailures >= COMPACTION_FAILURE_TRIP_COUNT) {
				this._autoCompactDisabledThisSession = true;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Auto-compaction circuit breaker tripped after 3 consecutive failures — auto-compaction is disabled for the rest of this session. Try /new to start fresh or switch to a larger-context model.",
				});
			} else if (started) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}
		if (bindings.slotUIActions !== undefined) {
			this._extensionSlotUIActions = bindings.slotUIActions;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
		this._scheduleDeferredExtensionLoading();
	}

	/** Load deferred extensions now when a child must activate a parent-visible tool. */
	async loadDeferredExtensions(): Promise<void> {
		await this._extensionRunner.loadDeferredExtensions();
	}

	private _scheduleDeferredExtensionLoading(): void {
		const runner = this._extensionRunner;
		if (runner.getDeferredExtensionPaths().length === 0) return;
		setTimeout(() => {
			if (this._extensionRunner !== runner) return;
			void runner.loadDeferredExtensions();
		}, 250);
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
		this._systemPromptNeedsRefilter = true;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);
		if (this._extensionSlotUIActions) {
			runner.bindSlotUI(this._extensionSlotUIActions);
		}

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
		this.agent.cacheAffinityKey = createPromptCacheAffinityKey(refreshedModel, this.agent.state);
	}

	private _getAgentParentSnapshot(): AgentParentSnapshot {
		return {
			activeTools: this.getActiveToolNames(),
			executableTools: this.getActiveExecutableTools(),
			providerTools: this.getActiveToolProviderSchemas(),
			cacheAffinityKey: this.getPromptCacheAffinityKey(),
			sessionManager: this.sessionManager,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			// Capture the parent's frozen turn-start system prompt so fork children
			// inherit byte-identical system + tools bytes and hit the parent's cached
			// prefix.
			systemPrompt: this.agent.state.systemPrompt,
			signal: this.agent.signal,
		};
	}

	private _createAgentEngine(): AgentEngine {
		if (!this._agentToolServices) {
			throw new Error("forkAgent is not available: agent tool services are not bound to this session");
		}
		return createAgentEngine({
			parentServices: this._agentToolServices,
			getParentSnapshot: () => this._getAgentParentSnapshot(),
			onBackgroundTerminal: (notification) => this._emitAgentCompletion(notification),
			onBackgroundTerminalListener: (unsubscribe) => {
				if (this._disposed) unsubscribe();
				else this._backgroundAgentTerminalUnsubscribers.add(unsubscribe);
			},
		});
	}

	private _getAgentEngine(): AgentEngine {
		// Profile/depth denial must fail closed before extension-provided engines are
		// considered. Keeping the schema visible for fork cache identity does not
		// grant execution capability.
		if (!this._agentToolServices) {
			throw new Error("Agent is not available: agent tool services are not bound to this session");
		}
		const processEngine = getExtensionProcessService<AgentEngine>(AGENTS_ENGINE_SERVICE_ID);
		if (processEngine) return processEngine;
		const engine = this._extensionRunner.getService<AgentEngine>(AGENTS_ENGINE_SERVICE_ID);
		if (engine) return engine;
		return this._createAgentEngine();
	}

	private async _forkAgentFromExtension(opts: ForkAgentOptions): Promise<ForkAgentResult> {
		return this._getAgentEngine().fork(opts);
	}

	/**
	 * Push a structured agent_completion message when a background agent
	 * reaches a terminal status or intentionally parks between turns. Mirrors Claude Code's
	 * <task_notification> shape: runId, status, summary, result preview,
	 * outputPaths, sessionPaths, usage.
	 *
	 * Delivery strategy (intentionally no triggerTurn:true here):
	 *   - When the parent is streaming/compacting/processing, sendCustomMessage
	 *     routes to the followUp queue — the message lands in the next drain,
	 *     emits message_start when the loop picks it up, and pi-goal's wake
	 *     hook fires from there.
	 *   - When the parent is idle, sendCustomMessage takes the "push to
	 *     messages + emit message_start synchronously" branch, then wakeOnIdle
	 *     schedules one debounced continuation turn so the model reads the
	 *     notification autonomously (the race with a user prompt arriving in
	 *     the same tick is handled by the busy re-check in _scheduleIdleWake).
	 *     Matches Claude Code's task-notification queue semantics.
	 */
	private _emitAgentCompletion(notification: AgentBackgroundCompletion): void {
		const lines: string[] = [
			`<agent_completion>`,
			`<run_id>${notification.runId}</run_id>`,
			`<status>${notification.status}</status>`,
			`<mode>${notification.mode}</mode>`,
			`<agents>${notification.agents.join(", ")}</agents>`,
			`<summary>${notification.summary}</summary>`,
		];
		if (notification.parked) lines.push(`<parked>true</parked>`);
		if (typeof notification.durationMs === "number") {
			lines.push(`<duration_ms>${notification.durationMs}</duration_ms>`);
		}
		if (typeof notification.totalTokens === "number") {
			lines.push(`<total_tokens>${notification.totalTokens}</total_tokens>`);
		}
		if (typeof notification.toolCallCount === "number") {
			lines.push(`<tool_calls>${notification.toolCallCount}</tool_calls>`);
		}
		for (const path of notification.outputPaths) lines.push(`<output_path>${path}</output_path>`);
		for (const path of notification.sessionPaths) lines.push(`<session_path>${path}</session_path>`);
		if (notification.error) lines.push(`<error>${notification.error}</error>`);
		if (notification.result) {
			lines.push(`<result_preview>`);
			lines.push(notification.result);
			lines.push(`</result_preview>`);
		}
		lines.push(`</agent_completion>`);
		lines.push(
			notification.parked
				? `\nThe persistent background agent is idle between turns, not interrupted or terminal. Do NOT call \`agent\` action=status/detail to verify. Use \`agent\` action=inject when it should process another turn; read output_path or session_path for the transcript.`
				: `\nThe background agent has finished. Do NOT call \`agent\` action=status/detail to verify — the run is terminal. Read output_path or session_path if you need the full transcript.`,
		);
		void this.sendCustomMessage(
			{
				customType: "agent_completion",
				content: lines.join("\n"),
				display: false,
				details: notification,
			},
			{ deliverAs: "followUp", wakeOnIdle: true },
		).catch(() => {
			/* sendCustomMessage logs its own runtime errors; don't crash the lifecycle listener. */
		});
	}

	/**
	 * Push a task_notification message when a background bash job reaches a
	 * terminal lifecycle event. The registry constructs the complete payload
	 * before delivery, so output-limit stops retain their distinct notification
	 * type instead of being flattened into ordinary completion.
	 *
	 * Delivery uses the same `deliverAs: "followUp", wakeOnIdle: true` strategy
	 * as agent completions: queued when the loop is busy, picked up on the next
	 * drain; at idle, message_start fires synchronously and wakeOnIdle drives
	 * one debounced continuation turn.
	 */
	public emitBashCompletion(notification: BackgroundShellNotification): void {
		this._emitBashNotification(notification);
	}

	/** Deliver the same structured payload for an actionable prompt stall. */
	public emitBashStall(notification: BackgroundShellNotification): void {
		this._emitBashNotification(notification);
	}

	private _emitBashNotification(notification: BackgroundShellNotification): void {
		const lines: string[] = [
			`<task_notification>`,
			`<task_id>${notification.taskId}</task_id>`,
			`<task_type>background_bash</task_type>`,
			`<type>${notification.type}</type>`,
			`<status>${notification.status}</status>`,
			`<summary>${notification.summary}</summary>`,
			`<output_path>${notification.outputPath}</output_path>`,
		];
		lines.push(`</task_notification>`);
		lines.push(`\n${notification.summary} Its output can be inspected at output_path.`);
		void this.sendCustomMessage(
			{
				customType: notification.type,
				content: lines.join("\n"),
				display: false,
				details: notification,
			},
			{ deliverAs: "followUp", wakeOnIdle: true },
		).catch(() => {
			/* sendCustomMessage logs its own errors; never crash the bg lifecycle listener. */
		});
	}

	private _transcriptAppendFromExtension(entry: TranscriptEntry): void {
		if (!entry || typeof entry !== "object") {
			throw new Error("transcript.append requires a TranscriptEntry object");
		}
		if (entry.kind === "memory_saved") {
			const verb: "Saved" | "Improved" = entry.verb === "Improved" ? "Improved" : "Saved";
			const paths = Array.isArray(entry.paths) ? entry.paths.filter((p): p is string => typeof p === "string") : [];
			const summary = `${verb} ${paths.length} ${paths.length === 1 ? "memory" : "memories"}`;
			void this.sendCustomMessage(
				{
					customType: "memory_saved",
					content: paths.length > 0 ? `${summary}\n${paths.join("\n")}` : summary,
					display: true,
					details: { verb, paths },
				},
				{ triggerTurn: false },
			).catch(() => {
				/* sendCustomMessage logs runtime errors via emitError; do not crash the extension hook. */
			});
			return;
		}
		// Unknown kinds: ignore rather than crash; future kinds will be added as the union grows.
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					// DIAG: capture caller stack at the synchronous call site so we can
					// attribute async runtime errors to the originating extension.
					const callerStack = new Error("sendMessage callsite").stack;
					this.sendCustomMessage(message, options).catch((err) => {
						try {
							const diagPath = `${process.env.HOME}/.pi/agent/logs/runtime-errors.log`;
							mkdirSync(dirname(diagPath), { recursive: true });
							appendFileSync(
								diagPath,
								`\n[${new Date().toISOString()}] send_message error: ${err instanceof Error ? err.message : String(err)}\n` +
									`customType=${(message as { customType?: string })?.customType ?? "?"} triggerTurn=${(options as { triggerTurn?: boolean })?.triggerTurn ?? false} deliverAs=${(options as { deliverAs?: string })?.deliverAs ?? "-"}\n` +
									`err.stack:\n${err instanceof Error ? err.stack : "(no stack)"}\n` +
									`caller.stack:\n${callerStack}\n`,
							);
						} catch {
							/* swallow logging errors */
						}
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					const callerStack = new Error("sendUserMessage callsite").stack;
					this.sendUserMessage(content, options).catch((err) => {
						try {
							const diagPath = `${process.env.HOME}/.pi/agent/logs/runtime-errors.log`;
							mkdirSync(dirname(diagPath), { recursive: true });
							appendFileSync(
								diagPath,
								`\n[${new Date().toISOString()}] send_user_message error: ${err instanceof Error ? err.message : String(err)}\n` +
									`err.stack:\n${err instanceof Error ? err.stack : "(no stack)"}\n` +
									`caller.stack:\n${callerStack}\n`,
							);
						} catch {
							/* swallow logging errors */
						}
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				getToolDefinitions: () => this.getToolDefinitions(),
				getCustomEntries: (customType) =>
					this.sessionManager
						.getBranch()
						.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === customType),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				setDeferredOverrides: (names) => this.setDeferredToolOverrides(names),
				setToolNamespaces: (map) => this.setToolNamespaces(map),
				refreshTools: (options) => this._refreshToolRegistry(options),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: (reason?: unknown) => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler(reason);
						return;
					}
					this.agent.abort(reason);
				},
				requestStopAfterTurn: (reason) => {
					// Latch unconditionally: a tool's execute() can call this mid-turn before
					// this.isStreaming reflects the in-flight state (see goal-wait-failures
					// catalog, 2026-07-09), and _extensionStopAfterTurnReason is already reset
					// on every agent_start/agent_end, so latching outside a run is harmless.
					this._extensionStopAfterTurnReason = reason?.trim() || "extension requested stop after turn";
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				reload: async () => {
					await this.reload();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getEffectiveSystemPrompt: () => this.getEffectiveSystemPrompt(),
				forkAgent: (opts) => this._forkAgentFromExtension(opts),
				transcriptAppend: (entry) => this._transcriptAppendFromExtension(entry),
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: {
		activeToolNames?: string[];
		includeAllExtensionTools?: boolean;
		activateNewTools?: boolean;
	}): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter(
			(tool) =>
				isAllowedTool(tool.definition.name) &&
				isToolAvailableForModel(tool.definition, this.model) &&
				!(tool.definition.name === "agent" && this._baseToolDefinitions.has("agent")),
		);
		// Extensions can fully supersede a core base builtin (e.g. native-tool-overrides
		// provides capitalized Read/Edit/... and TaskStop, replacing core's
		// lowercase read/edit/... and bash_output/bash_kill). Collect the declared
		// replacements so the superseded builtins drop out of the registry — the
		// override becomes the single tool per capability. No declaration ⇒ base tools
		// stay, so upstream/vanilla sessions are unaffected. Deterministic per build
		// (no per-turn state), so the tools[] prefix stays cache-stable.
		const replacedBuiltinNames = new Set<string>();
		for (const tool of allCustomTools) {
			for (const builtinName of tool.definition.replacesBuiltins ?? []) {
				replacedBuiltinNames.add(builtinName);
			}
		}
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(
					([name, definition]) =>
						isAllowedTool(name) &&
						!replacedBuiltinNames.has(name) &&
						isToolAvailableForModel(definition, this.model),
				)
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name) && !replacedBuiltinNames.has(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		// Keep Agent/Task schemas byte-identical in denied fork sessions, but guard
		// execution in this session's registry before any runtime/process engine can
		// be resolved. The closure is live for SDK/test consumers that bind services
		// after construction and isolated when sessions share a ResourceLoader.
		for (const name of ["agent", "Agent", "Task"]) {
			const tool = toolRegistry.get(name);
			if (!tool) continue;
			const execute = tool.execute;
			toolRegistry.set(name, {
				...tool,
				execute: async (toolCallId, params, signal, onUpdate) => {
					if (!this._agentToolServices) {
						throw new Error("Agent is not available: agent tool services are not bound to this session");
					}
					return runWithAgentEngineResolver(
						() => this._getAgentEngine(),
						() => execute(toolCallId, params, signal, onUpdate),
					);
				},
			});
		}
		this._toolRegistry = toolRegistry;
		// Re-apply post-registration deferral overrides onto the freshly rebuilt
		// registry + definitions so deferLoading stays forced across every rebuild
		// (setDeferredToolOverrides seam). No-op when the override set is empty.
		this._applyDeferredOverrides();
		// Re-stamp post-registration namespace annotations (setToolNamespaces seam).
		// No-op when the map is empty. Pure serialization metadata; order vs
		// deferral overrides is irrelevant (disjoint fields).
		this._applyToolNamespaces();

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				const sourceInfo = definitionRegistry.get(tool.name)?.sourceInfo;
				if (sourceInfo?.source === "builtin") continue;
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames && options?.activateNewTools !== false) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		if (this._toolRegistry.has("tool_search")) {
			nextActiveToolNames.push("tool_search");
		}

		// Fix #3 (cache-break-investigation-2026-05-16.md): preserve builtin
		// and alwaysLoad-tagged tools that were active before this refresh.
		// Bridge cache-break log shows Bash/Edit/Write/Grep/Read each removed
		// ~2,560× per 18d — that churn invalidates the tools-slot cache prefix.
		// Trigger: when a caller passes `options.activeToolNames` with a narrow
		// list, the carry-over from previousActiveToolNames is bypassed and
		// protected tools silently drop out. Restore them here.
		//
		// Constraint: only restore tools that WERE previously active. Sessions
		// created with `noTools: "builtin"` start with builtins registered but
		// inactive — we must not force them in. Scoped to the refresh path so
		// direct setActiveToolsByName callers keep replacement semantics.
		for (const name of previousActiveToolNames) {
			if (!isAllowedTool(name)) continue;
			const tool = this._toolRegistry.get(name);
			if (!tool) continue;
			if (allToolNames.has(name as ToolName) || tool.alwaysLoad === true) {
				nextActiveToolNames.push(name);
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
		void this._extensionRunner.emit({ type: "tools_changed" });
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		// Trigger logger (Fix #3 in cache-break-investigation-2026-05-16.md).
		// Gate on PI_LOG_BUILD_RUNTIME=1. Bucket the captured stacks to find the
		// top 3 callers of mid-session rebuilds (extension hot-reload?
		// sub-agent return? settings-watch?). Stderr only — no behavior change.
		if (process.env.PI_LOG_BUILD_RUNTIME === "1") {
			const trace = new Error("BUILD-RUNTIME").stack ?? "";
			const caller = trace.split("\n").slice(2, 7).join(" | ");
			process.stderr.write(
				`[BUILD-RUNTIME] activeTools=${options.activeToolNames?.length ?? "-"} ` +
					`includeAll=${options.includeAllExtensionTools ?? false} caller=${caller}\n`,
			);
		}
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions: Record<string, ToolDefinition> = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		if (!this._baseToolsOverride) {
			delete baseToolDefinitions.BashOutput;
			delete baseToolDefinitions.KillShell;
			delete baseToolDefinitions.agent;
			delete baseToolDefinitions.Agent;
			delete baseToolDefinitions.Task;
		}

		this._baseToolDefinitions = new Map(Object.entries(baseToolDefinitions));

		// Use the runner accessor so built-in hook actions (agents, bashBgJobs,
		// deferredTools) are dispatched alongside user extensions.
		const extensionsResult = this._resourceLoader.getExtensionsForRunner();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.deferredExtensions,
			extensionsResult.runtime,
			extensionsResult.eventBus,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
			this._source,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		// Keep extension-owned `BashOutput`/`KillShell` active by default so sessions
		// without pi-tool-search still get the full bash job-control trio. Without
		// them, run_in_background:true returns a bgId the model can never read or stop.
		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["Read", "Bash", "BashOutput", "KillShell", "Edit", "Write", "Agent", "Task", "Grep", "Glob"];
		const baseActiveToolNames = syncClaudeBridgeNativeTools(
			options.activeToolNames ?? defaultActiveToolNames,
			this.model,
		);
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
			this._scheduleDeferredExtensionLoading();
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// Defer while the agent is busy, to avoid breaking tool_use/tool_result ordering.
		// isStreaming alone is too narrow: compaction runs its own LLM calls outside
		// agent.runWithLifecycle(), and agent.isProcessing also covers the prompt() setup
		// window and the agent_end listener phase. A bash execution landing in one of those
		// windows pushes a visible user message between an assistant tool_use and its
		// tool_results, which the provider rejects for the rest of the session. Deferred
		// messages are flushed by the enclosing run's finally block or before the next prompt.
		if (this.isStreaming || this.isCompacting || this.agent.isProcessing) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Branch summarization sets _branchSummaryAbortController, so isCompacting
			// defers any bash executed while it runs. Persist those against the leaf
			// they were run on — after the switch below they would land on the branch
			// being navigated to, in front of unrelated model context.
			this._flushPendingBashMessages();

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const contextUsageService =
			this._extensionRunner?.getService<ContextUsageSnapshotService>(CONTEXT_USAGE_SERVICE_ID);
		const serviceUsage = contextUsageService?.get();
		const matchingServiceUsage = serviceUsage?.contextWindow === contextWindow ? serviceUsage : undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null, details: matchingServiceUsage?.details };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		if (estimate.lastUsageIndex !== null) {
			const tokens = estimate.tokens;
			return {
				tokens,
				contextWindow,
				percent: (tokens / contextWindow) * 100,
				details: {
					...matchingServiceUsage?.details,
					source: "provider_usage",
					providerUsageTokens: estimate.usageTokens,
				},
			};
		}

		if (matchingServiceUsage) return matchingServiceUsage;

		const systemPromptTokens = estimateSystemPromptTokens(this.systemPrompt);
		const tokens = estimate.tokens + systemPromptTokens;
		const percent = (tokens / contextWindow) * 100;

		return {
			tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
