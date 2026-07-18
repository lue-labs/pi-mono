import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@valkyriweb/pi-agent-core";
import { clampThinkingLevel, type Message, type Model, modelsAreEqual } from "@valkyriweb/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { type AgentRunIdentity, AgentSession } from "./agent-session.ts";
import type { AgentToolParentServices } from "./agents/executor.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { createPromptCacheAffinityKey } from "./cache-affinity.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { applyFilters } from "./extensions/extension-hooks.ts";
import type {
	ExtensionRunner,
	InputSource,
	LoadExtensionsResult,
	SessionStartEvent,
	ToolDefinition,
} from "./extensions/index.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel, normalizeAutoAliasString } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, type SessionContext, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import { boundModelFacingContextImages, retireOutOfBudgetContextImages } from "./tool-artifacts.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createTaskTool,
	createUppercaseAgentTool,
	createUppercaseBashTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Original requested model string, preserved for pre-session alias resolution such as `auto`/`provider/auto`. */
	requestedModel?: string;
	/** Prompt/session metadata available to pre-session model routing hooks. Must not include cached system/tools bytes. */
	routingMetadata?: Record<string, unknown>;
	/** Defer requested auto-alias resolution until the first prompt supplies semantic input. */
	deferRequestedModelResolution?: boolean;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (Read, Bash, Edit, Write, Agent, Task, Grep, Glob)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, pi enables the default built-in tools (Read, Bash, Edit, Write, Agent, Task, Grep, Glob)
	 * and leaves extension/custom tools enabled unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/**
	 * Origin of this session. Forwarded to `AgentSession` and exposed on
	 * `ExtensionContext.source`. CLI sets this from `--source`; the built-in
	 * `agent` tool sets `"child-agent"` for in-process delegated runs.
	 * Defaults to `"interactive"`. See `AgentSessionConfig.source`.
	 */
	source?: InputSource;
	/**
	 * Agent-tool services to bind to the session. Carries the delegation `depth`
	 * for nested Agent tasks. When omitted, top-level services (depth 0) are built.
	 */
	agentToolServices?: AgentToolParentServices;
	/**
	 * Leave the Agent execution engine unbound even when top-level services could
	 * be built. Used when a task keeps an inherited Agent schema for cache identity
	 * but its selected profile or depth denies execution.
	 */
	disableAgentToolServices?: boolean;
	/**
	 * Identity of the agent run this session represents, for observability
	 * correlation. Stamped onto emitted tool events as `agentId`/`parentAgentId`.
	 */
	agentRunIdentity?: AgentRunIdentity;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning or informational note if startup model selection changed/fell back */
	modelFallbackMessage?: string;
	/** True when an auto model alias could not be routed and a fallback model is in use */
	modelRoutingFailed?: boolean;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	createBashTool,
	// Tool factories (for custom cwd)
	createCodingTools,
	createEditTool,
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createTaskTool,
	createUppercaseAgentTool,
	createUppercaseBashTool,
	createWriteTool,
	withFileMutationQueue,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

function isClaudeBridgeModel(model: Model<any>): boolean {
	return (
		model.provider === "claude-bridge" ||
		model.baseUrl.includes("127.0.0.1:9100") ||
		model.baseUrl.includes("localhost:9100")
	);
}

function getClaudeBridgeHeaders(
	sessionManager: SessionManager,
	source: InputSource | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {
		"x-pi-session-id": sessionManager.getSessionId(),
		"x-pi-cwd": sessionManager.getCwd(),
		"x-pi-pid": String(process.pid),
		"x-pi-source": source ?? "interactive",
		"x-pi-child-agent": source === "child-agent" ? "true" : "false",
	};
	const title = sessionManager.getSessionName();
	if (title) headers["x-pi-session-title"] = title;
	const parentSession = sessionManager.getParentSession();
	if (parentSession) headers["x-pi-parent-session"] = parentSession;
	return headers;
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@valkyriweb/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));
	// Kept for AgentToolParentServices / child-agent tooling, which still consumes
	// AuthStorage + the ModelRegistry compat facade directly.
	const authStorage = AuthStorage.create(authPath);
	const modelRegistry = new ModelRegistry(modelRuntime);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;
	let modelRoutingFailed = false;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	const sessionSource = options.source ?? "interactive";
	// A settings-persisted auto default (defaultProvider + defaultModel "auto") has no registry
	// entry, so findInitialModel above landed on a concrete fallback model and discarded the auto
	// intent. Synthesize the same deferred pending-auto request `--model auto` uses so the
	// `model:resolve` filter routes it at the first prompt boundary instead.
	const settingsDefaultAutoAlias =
		!options.requestedModel && !options.model && !hasExistingSession && !options.scopedModels?.length
			? normalizeAutoAliasString(settingsManager.getDefaultProvider(), settingsManager.getDefaultModel())
			: undefined;
	const deferSettingsDefaultAuto = settingsDefaultAutoAlias !== undefined;
	const explicitRequestedModel = options.requestedModel?.trim();
	const requestedModel = explicitRequestedModel
		? (normalizeAutoAliasString("clawrouter", explicitRequestedModel) ?? explicitRequestedModel)
		: settingsDefaultAutoAlias;
	const pendingRequestedModel =
		requestedModel && (options.deferRequestedModelResolution || deferSettingsDefaultAuto) && !hasExistingSession
			? requestedModel
			: undefined;
	if (requestedModel && model && !hasExistingSession && !pendingRequestedModel) {
		const before = model;
		const resolved = await applyFilters(
			"model:resolve",
			{
				requestedModel,
				model,
				thinkingLevel,
				metadata: (options.routingMetadata ? { routing: options.routingMetadata } : undefined) as
					| Record<string, unknown>
					| undefined,
			},
			{
				cwd,
				source: sessionSource,
				sessionId: sessionManager.getSessionId(),
				hasExistingSession,
				modelRegistry,
				settingsManager,
				sessionManager,
			},
		);
		const nextModel = resolved.model ?? model;
		const nextThinkingLevel = resolved.thinkingLevel ?? thinkingLevel;
		const resolvedMetadata = resolved.metadata as Record<string, unknown> | undefined;
		const hasRoutingDecision =
			resolvedMetadata?.llmRouterDecision !== undefined ||
			resolvedMetadata?.llmRouterUnavailable !== undefined ||
			typeof resolvedMetadata?.tier === "string" ||
			!modelsAreEqual(before, nextModel) ||
			(resolved.thinkingLevel !== undefined && resolved.thinkingLevel !== thinkingLevel);
		if (!hasRoutingDecision) {
			modelRoutingFailed = true;
			modelFallbackMessage = `${modelFallbackMessage ? `${modelFallbackMessage}. ` : ""}Auto model ${requestedModel} could not be routed (no routing decision); continuing with ${before.provider}/${before.id}.`;
		} else {
			model = nextModel;
			thinkingLevel = nextThinkingLevel;
		}
		const reason = Array.isArray(resolved.metadata?.reason) ? resolved.metadata.reason.join(", ") : undefined;
		const route = typeof resolved.metadata?.route === "string" ? resolved.metadata.route : requestedModel;
		const unavailable = resolved.metadata?.llmRouterUnavailable as { message?: string } | undefined;
		if (unavailable?.message) {
			modelRoutingFailed = true;
			modelFallbackMessage = `${modelFallbackMessage ? `${modelFallbackMessage}. ` : ""}${unavailable.message}`;
		} else if (model && (before.provider !== model.provider || before.id !== model.id || resolved.thinkingLevel)) {
			const thinkingSuffix = resolved.thinkingLevel ? ` · thinking ${thinkingLevel}` : "";
			const reasonSuffix = reason ? ` · ${reason}` : "";
			modelFallbackMessage = `${modelFallbackMessage ? `${modelFallbackMessage}. ` : ""}Auto model ${route} selected ${model.provider}/${model.id}${thinkingSuffix}${reasonSuffix}`;
		}
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	// `BashOutput`/`KillShell` are the read/stop half of the bash job-control trio.
	// Sessions without pi-tool-search (which would re-add them via alwaysActive)
	// previously got `Bash` without them, making run_in_background:true unusable.
	//
	// `Read`/`Edit`/`Write`/`Grep`/`Glob` are now provided by the
	// my-pi/extensions/native-tool-overrides extension (not core), so they are
	// referenced as plain strings rather than ToolName values.
	const defaultActiveToolNames: string[] = [
		"Read",
		"Bash",
		"BashOutput",
		"KillShell",
		"Edit",
		"Write",
		"Agent",
		"Task",
		"Grep",
		"Glob",
	];
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames: string[] = (
		options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames
	).filter((name) => !excludedToolNameSet?.has(name));

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg): Message => {
			if (msg.role === "user") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			} else if (msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const safeContent = content;
					const hasImages = safeContent.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = safeContent
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const bridgeHeaders = isClaudeBridgeModel(model)
				? getClaudeBridgeHeaders(sessionManager, sessionSource)
				: undefined;
			const headerRunner = extensionRunnerRef.current;
			return modelRuntime.streamSimple(model, context, {
				...options,
				cacheAffinityKey: options?.cacheAffinityKey ?? createPromptCacheAffinityKey(model, context),
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				transformHeaders: async (requestHeaders) => {
					const headers = mergeProviderAttributionHeaders(
						model,
						settingsManager,
						options?.sessionId,
						bridgeHeaders,
						requestHeaders,
					);
					return headerRunner?.hasHandlers("before_provider_headers")
						? headerRunner.emitBeforeProviderHeaders(headers ?? {})
						: (headers ?? {});
				},
			});
		},
		onPayload: async (payload, _model) => {
			return extensionRunnerRef.current?.emitBeforeProviderRequest(payload) ?? payload;
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		cacheAffinityKey: undefined,
		transformContext: async (messages) => {
			// Bound images on the raw history BEFORE extension context transforms: this
			// is byte-for-byte the same walk retireOutOfBudgetContextImages() applies to
			// stored messages, so persistent retirement can never change provider bytes
			// even when an extension removes/reorders images (which would otherwise
			// shift the post-transform budget). The post-transform bound stays as a
			// backstop for images injected by context handlers.
			const bounded = boundModelFacingContextImages<AgentMessage>(messages);
			const runner = extensionRunnerRef.current;
			const extensionMessages = runner ? await runner.emitContext(bounded) : bounded;
			return boundModelFacingContextImages<AgentMessage>(extensionMessages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	const sessionModelMatches = (storedModel: SessionContext["model"], selectedModel: Model<any>): boolean =>
		storedModel?.provider === selectedModel.provider && storedModel.modelId === selectedModel.id;

	// Restore messages if session has existing data
	if (hasExistingSession) {
		// Retire base64 payloads of images beyond the model-facing budget before
		// they become resident: the provider view renders them as placeholders
		// anyway, and a resumed long session can otherwise rehydrate hundreds of
		// MB of unreachable-to-the-model image data (my-pi#1147).
		retireOutOfBudgetContextImages(existingSession.messages);
		agent.state.messages = existingSession.messages;
		if (model && !sessionModelMatches(existingSession.model, model)) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume.
		// Pending auto aliases intentionally do not persist the seed model as a concrete choice;
		// the first real prompt will resolve and persist the selected model at that cache boundary.
		if (model && !pendingRequestedModel) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		modelRuntime,
		// Honour an explicit disabled state before falling back to top-level services.
		agentToolServices: options.disableAgentToolServices
			? undefined
			: (options.agentToolServices ?? { cwd, agentDir, authStorage, settingsManager, modelRegistry, modelRuntime }),
		agentRunIdentity: options.agentRunIdentity,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		source: sessionSource,
		pendingAutoModelRequest: pendingRequestedModel
			? { requestedModel: pendingRequestedModel, routingMetadata: options.routingMetadata }
			: undefined,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
		modelRoutingFailed,
	};
}
