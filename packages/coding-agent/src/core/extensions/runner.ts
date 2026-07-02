/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import type { AgentMessage } from "@valkyriweb/pi-agent-core";
import type { ImageContent, Model } from "@valkyriweb/pi-ai";
import type { KeyId } from "@valkyriweb/pi-tui";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import type { AgentChainDefinition } from "../agents/chains.ts";
import { setAgentExtensionDefinitionsProvider } from "../agents/extension-source.ts";
import type { AgentDefinition } from "../agents/types.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { EventBus } from "../event-bus.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import { applyFilters } from "./extension-hooks.ts";
import { getExtensionProcessService, loadDeferredExtension } from "./loader.ts";
import type {
	AgentTelemetry,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	DeferredExtension,
	EntryRenderer,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionContextModePolicy,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionFooterSpec,
	ExtensionMainPaneFactory,
	ExtensionMode,
	ExtensionOverlayFactory,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ForkAgentOptions,
	ForkAgentResult,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadExtensionsResult,
	MessageEndEvent,
	MessageEndEventResult,
	MessageRenderer,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ProviderConfig,
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	RunRegistry,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	TranscriptApi,
	TranscriptEntry,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";

/**
 * Actions wired into the extension runner by a UI-capable mode (today only
 * interactive-mode) to back the B5 imperative show/hide API. Non-UI modes
 * skip the bind call so the default no-op stubs stay in place and the API
 * silently swallows the requests.
 */
export interface ExtensionSlotUIActions {
	showMainPane: (id: string, payload: unknown) => void;
	hideMainPane: (id: string) => void;
	showOverlay: (id: string, payload: unknown) => void;
	hideOverlay: (id: string) => void;
}

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = {
				keybinding,
				restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
}

async function callContextHandlerAbortable<T>(fn: () => Promise<T> | T, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		throw new Error("Agent run aborted");
	}

	let cleanup = () => {};
	const abortPromise = new Promise<never>((_resolve, reject) => {
		const onAbort = () => reject(new Error("Agent run aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		cleanup = () => signal.removeEventListener("abort", onAbort);
	});

	try {
		return await Promise.race([Promise.resolve().then(fn), abortPromise]);
	} finally {
		cleanup();
	}
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (
	sessionPath: string,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: SessionShutdownEvent,
): Promise<boolean> {
	if (extensionRunner.hasHandlers("session_shutdown")) {
		await extensionRunner.emit(event);
		return true;
	}
	return false;
}

export async function emitProjectTrustEvent(
	extensionsResult: LoadExtensionsResult,
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	const errors: ExtensionError[] = [];
	for (const ext of extensionsResult.extensions) {
		// A single extension may register multiple handlers for the same event.
		// The first project_trust handler that returns yes/no wins; undecided falls through.
		const handlers = ext.handlers.get("project_trust");
		if (!handlers || handlers.length === 0) continue;

		for (const handler of handlers) {
			try {
				const handlerResult = (await handler(event, ctx)) as ProjectTrustEventResult;
				if (handlerResult.trusted === "undecided") {
					continue;
				}
				return { result: handlerResult, errors };
			} catch (error) {
				errors.push({
					extensionPath: ext.path,
					event: event.type,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { errors };
}

const noOpUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export class ExtensionRunner {
	private extensions: Extension[];
	private deferredExtensions: DeferredExtension[];
	private deferredLoadPromise: Promise<void> | undefined;
	private runtime: ExtensionRuntime;
	private eventBus: EventBus;
	private uiContext: ExtensionUIContext;
	private mode: ExtensionMode = "print";
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private source: InputSource;
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private getModel: () => Model<any> | undefined = () => undefined;
	private isIdleFn: () => boolean = () => true;
	private isProjectTrustedFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private requestStopAfterTurnFn: (reason?: string) => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getEffectiveSystemPromptFn: () => Promise<string> = async () => this.getSystemPromptFn();
	private forkAgentFn: (opts: ForkAgentOptions) => Promise<ForkAgentResult> = async () => {
		throw new Error("forkAgent is not available in this runtime");
	};
	private transcriptAppendFn: (entry: TranscriptEntry) => void = () => {};
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () => ({ cwd: this.cwd });
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private reloadHandler: ReloadHandler = async () => {};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;
	private deferredLoadedListeners: Set<() => void> = new Set();

	constructor(
		extensions: Extension[],
		deferredExtensions: DeferredExtension[],
		runtime: ExtensionRuntime,
		eventBus: EventBus,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
		source: InputSource = "interactive",
	) {
		this.extensions = extensions;
		this.deferredExtensions = deferredExtensions;
		this.runtime = runtime;
		this.eventBus = eventBus;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		this.source = source;
	}

	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		providerActions?: {
			registerProvider?: (name: string, config: ProviderConfig) => void;
			unregisterProvider?: (name: string) => void;
		},
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.getToolDefinitions = actions.getToolDefinitions;
		this.runtime.getCustomEntries = actions.getCustomEntries;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.setDeferredOverrides = actions.setDeferredOverrides;
		this.runtime.setToolNamespaces = actions.setToolNamespaces;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;

		// Publish extension-registered agent definitions through the module-level
		// bridge so `loadAgentRegistry` can merge them in without an import edge
		// from core to the package that owns the agents (e.g. `pi-agents`).
		setAgentExtensionDefinitionsProvider(() => this.getRegisteredAgentDefinitions());

		// Context actions (required)
		this.getModel = contextActions.getModel;
		this.isIdleFn = contextActions.isIdle;
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.requestStopAfterTurnFn = contextActions.requestStopAfterTurn;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.reloadHandler = contextActions.reload;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getEffectiveSystemPromptFn = contextActions.getEffectiveSystemPrompt;
		this.forkAgentFn = contextActions.forkAgent;
		this.transcriptAppendFn = contextActions.transcriptAppend;
		this.getSystemPromptOptionsFn = contextActions.getSystemPromptOptions ?? (() => ({ cwd: this.cwd }));

		// Flush provider registrations queued during extension loading
		for (const { name, config, extensionPath } of this.runtime.pendingProviderRegistrations) {
			try {
				if (providerActions?.registerProvider) {
					providerActions.registerProvider(name, config);
				} else {
					this.modelRegistry.registerProvider(name, config);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingProviderRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		this.runtime.registerProvider = (name, config) => {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config);
				return;
			}
			this.modelRegistry.registerProvider(name, config);
		};
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
		this.reloadHandler = async () => {};
	}

	setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
		this.uiContext = uiContext ?? noOpUIContext;
		this.mode = mode;
	}

	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map((e) => e.path);
	}

	getDeferredExtensionPaths(): string[] {
		return this.deferredExtensions.map((e) => e.path);
	}

	getService<T>(id: string): T | undefined {
		return this.runtime.services.has(id) ? (this.runtime.services.get(id) as T) : getExtensionProcessService<T>(id);
	}

	setService<T>(id: string, service: T): void {
		this.runtime.services.set(id, service);
	}

	loadDeferredExtensions(): Promise<void> {
		this.deferredLoadPromise ??= this.loadDeferredExtensionsOnce();
		return this.deferredLoadPromise;
	}

	/**
	 * Register a callback fired after deferred extensions finish loading, so UI
	 * surfaces built from startup snapshots (e.g. the slash-command autocomplete
	 * list) can rebuild with the newly registered commands.
	 */
	onDeferredExtensionsLoaded(listener: () => void): void {
		this.deferredLoadedListeners.add(listener);
	}

	private async loadDeferredExtensionsOnce(): Promise<void> {
		const pending = this.deferredExtensions.splice(0);
		const previousSuppressNewToolActivation = this.runtime.suppressNewToolActivation;
		this.runtime.suppressNewToolActivation = true;
		try {
			for (const deferred of pending) {
				const { extension, error } = await loadDeferredExtension(deferred, this.cwd, this.eventBus, this.runtime);
				if (error) {
					this.emitError({ extensionPath: deferred.path, event: "deferred_load", error });
					continue;
				}
				if (!extension) continue;

				if (deferred.sourceInfo) {
					extension.sourceInfo = deferred.sourceInfo;
					for (const command of extension.commands.values()) {
						command.sourceInfo = extension.sourceInfo;
					}
					for (const tool of extension.tools.values()) {
						tool.sourceInfo = extension.sourceInfo;
					}
				}
				this.extensions.push(extension);
			}
		} finally {
			this.runtime.suppressNewToolActivation = previousSuppressNewToolActivation;
		}
		this.runtime.refreshTools({ activateNewTools: false });
		if (pending.length > 0) {
			for (const listener of this.deferredLoadedListeners) {
				listener();
			}
		}
	}

	/** Get all registered tools from all extensions (first registration per name wins). */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				if (!toolsByName.has(tool.definition.name)) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		const addDiagnostic = (message: string, extensionPath: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
						shortcut.extensionPath,
					);
					continue;
				}

				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}

				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	private assertActive(): void {
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	/**
	 * Return the first default renderer registered for `customType` via
	 * `ctx.setDefaultMessageRenderer`, or undefined if none. Intended as a
	 * fallback consulted after `getMessageRenderer`.
	 */
	getDefaultMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.defaultMessageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.entryRenderers?.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	/**
	 * Fire all handlers registered via `ctx.onSessionDispose`. Called
	 * synchronously from `AgentSession.dispose()` before the runner is
	 * invalidated. Per-handler errors are surfaced through the runner's error
	 * stream and do not skip remaining handlers.
	 */
	fireSessionDispose(): void {
		for (const ext of this.extensions) {
			for (const handler of ext.disposeHandlers) {
				try {
					handler();
				} catch (err) {
					this.emitError({
						extensionPath: ext.path,
						event: "session_dispose",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
	}

	/**
	 * Snapshot of every agent definition registered through
	 * `ctx.registerAgentDefinitions`. Iteration order matches extension load
	 * order. Consumers (e.g. the future `pi-agents` loader) merge this with
	 * the built-in / user / project sources.
	 */
	getRegisteredAgentDefinitions(): AgentDefinition[] {
		const defs: AgentDefinition[] = [];
		for (const ext of this.extensions) {
			defs.push(...ext.registeredAgentDefinitions);
		}
		return defs;
	}

	/**
	 * Snapshot of every agent chain registered through
	 * `ctx.registerAgentChains`.
	 */
	getRegisteredAgentChains(): AgentChainDefinition[] {
		const chains: AgentChainDefinition[] = [];
		for (const ext of this.extensions) {
			chains.push(...ext.registeredAgentChains);
		}
		return chains;
	}

	/**
	 * Resolved policy for a context mode registered through
	 * `ctx.registerContextMode`. Returns undefined when the name is unknown.
	 * Built-in modes (`default`/`fork`/`slim`/`none`) are NOT included here;
	 * core resolves those directly.
	 */
	getRegisteredContextMode(name: string): ExtensionContextModePolicy | undefined {
		for (const ext of this.extensions) {
			const policy = ext.registeredContextModes.get(name);
			if (policy) return policy;
		}
		return undefined;
	}

	/**
	 * The currently registered agent run registry, or undefined if no
	 * extension has published one.
	 */
	getRunRegistry(): RunRegistry | undefined {
		return this.runtime.getRunRegistry();
	}

	/**
	 * The currently registered telemetry sink, or undefined if no extension
	 * has published one. Intended for memory / goal / audit / eval extensions
	 * that fan their events into the same observability impl without an
	 * import edge on the producer package.
	 */
	getTelemetry(): AgentTelemetry | undefined {
		return this.runtime.getTelemetry();
	}

	/**
	 * Wire show/hide handlers from the UI-capable mode (interactive-mode). The
	 * runner forwards `pi.showMainPane` / `pi.hideMainPane` / `pi.showOverlay`
	 * / `pi.hideOverlay` calls through these handlers. Non-UI modes skip this
	 * bind so the default no-ops apply.
	 */
	bindSlotUI(actions: ExtensionSlotUIActions): void {
		this.runtime.showMainPaneFn = actions.showMainPane;
		this.runtime.hideMainPaneFn = actions.hideMainPane;
		this.runtime.showOverlayFn = actions.showOverlay;
		this.runtime.hideOverlayFn = actions.hideOverlay;
	}

	/**
	 * Lookup a main pane factory registered through `pi.registerMainPane`.
	 * Walks all extensions in load order and returns the first match.
	 * Returns `undefined` if no extension has registered the given id.
	 */
	getRegisteredMainPane(id: string): ExtensionMainPaneFactory | undefined {
		for (const ext of this.extensions) {
			const factory = ext.registeredMainPanes.get(id);
			if (factory) return factory;
		}
		return undefined;
	}

	/**
	 * Lookup an overlay factory registered through `pi.registerOverlay`.
	 * Walks all extensions in load order and returns the first match.
	 */
	getRegisteredOverlay(id: string): ExtensionOverlayFactory | undefined {
		for (const ext of this.extensions) {
			const factory = ext.registeredOverlays.get(id);
			if (factory) return factory;
		}
		return undefined;
	}

	/**
	 * Snapshot of every footer pill registered through `pi.registerFooter`,
	 * keyed by id. Iteration order matches extension load order; ties broken
	 * by registration order within an extension. Interactive-mode reads this
	 * on every footer invalidate to assemble the focus chain.
	 */
	getRegisteredFooters(): Array<{ id: string; spec: ExtensionFooterSpec; extensionPath: string }> {
		const result: Array<{ id: string; spec: ExtensionFooterSpec; extensionPath: string }> = [];
		for (const ext of this.extensions) {
			for (const [id, spec] of ext.registeredFooters) {
				result.push({ id, spec, extensionPath: ext.path });
			}
		}
		return result;
	}

	private resolveRegisteredCommands(): ResolvedCommand[] {
		const commands: RegisteredCommand[] = [];
		const counts = new Map<string, number>();

		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				commands.push(command);
				counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
			}
		}

		const seen = new Map<string, number>();
		const takenInvocationNames = new Set<string>();

		return commands.map((command) => {
			const occurrence = (seen.get(command.name) ?? 0) + 1;
			seen.set(command.name, occurrence);

			let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

			if (takenInvocationNames.has(invocationName)) {
				let suffix = occurrence;
				do {
					suffix++;
					invocationName = `${command.name}:${suffix}`;
				} while (takenInvocationNames.has(invocationName));
			}

			takenInvocationNames.add(invocationName);
			return {
				...command,
				invocationName,
			};
		});
	}

	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return this.resolveRegisteredCommands();
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	/**
	 * Create an ExtensionContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	createContext(): ExtensionContext {
		const runner = this;
		const getModel = this.getModel;
		return {
			get ui() {
				runner.assertActive();
				return runner.uiContext;
			},
			get mode() {
				runner.assertActive();
				return runner.mode;
			},
			get hasUI() {
				runner.assertActive();
				return runner.hasUI();
			},
			get cwd() {
				runner.assertActive();
				return runner.cwd;
			},
			get source() {
				runner.assertActive();
				return runner.source;
			},
			get sessionManager() {
				runner.assertActive();
				return runner.sessionManager;
			},
			get modelRegistry() {
				runner.assertActive();
				return runner.modelRegistry;
			},
			get model() {
				runner.assertActive();
				return getModel();
			},
			isIdle: () => {
				runner.assertActive();
				return runner.isIdleFn();
			},
			isProjectTrusted: () => {
				runner.assertActive();
				return runner.isProjectTrustedFn();
			},
			get signal() {
				runner.assertActive();
				return runner.getSignalFn();
			},
			abort: () => {
				runner.assertActive();
				runner.abortFn();
			},
			requestStopAfterTurn: (reason) => {
				runner.assertActive();
				runner.requestStopAfterTurnFn(reason);
			},
			hasPendingMessages: () => {
				runner.assertActive();
				return runner.hasPendingMessagesFn();
			},
			shutdown: () => {
				runner.assertActive();
				runner.shutdownHandler();
			},
			reload: () => {
				runner.assertActive();
				return runner.reloadHandler();
			},
			getContextUsage: () => {
				runner.assertActive();
				return runner.getContextUsageFn();
			},
			compact: (options) => {
				runner.assertActive();
				runner.compactFn(options);
			},
			getSystemPrompt: () => {
				runner.assertActive();
				return runner.getSystemPromptFn();
			},
			getEffectiveSystemPrompt: async () => {
				runner.assertActive();
				return runner.getEffectiveSystemPromptFn();
			},
			forkAgent: (opts) => {
				runner.assertActive();
				return runner.forkAgentFn(opts);
			},
			get transcript(): TranscriptApi {
				runner.assertActive();
				return {
					append(entry) {
						runner.assertActive();
						runner.transcriptAppendFn(entry);
					},
				};
			},
		};
	}

	createCommandContext(): ExtensionCommandContext {
		// Use property descriptors instead of object spread so the guarded getters from
		// createContext() stay lazy. A spread would eagerly read them once and freeze the
		// old values into the returned object, bypassing stale-instance checks.
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionCommandContext;
		context.getSystemPromptOptions = () => {
			this.assertActive();
			return this.getSystemPromptOptionsFn();
		};
		context.waitForIdle = () => {
			this.assertActive();
			return this.waitForIdleFn();
		};
		context.newSession = (options) => {
			this.assertActive();
			return this.newSessionHandler(options);
		};
		context.fork = (entryId, options) => {
			this.assertActive();
			return this.forkHandler(entryId, options);
		};
		context.navigateTree = (targetId, options) => {
			this.assertActive();
			return this.navigateTreeHandler(targetId, options);
		};
		context.switchSession = (sessionPath, options) => {
			this.assertActive();
			return this.switchSessionHandler(sessionPath, options);
		};
		context.reload = () => {
			this.assertActive();
			return this.reloadHandler();
		};
		return context;
	}

	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_fork" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		// Stale runners belong to disposed sessions. In-flight async work from the previous
		// agent loop (pending tool results, provider requests) can race past dispose() and
		// land here. Short-circuit instead of letting every handler throw and emit noisy
		// extension errors.
		if (this.staleMessage) return undefined as RunnerEmitResult<TEvent>;
		const ctx = this.createContext();
		let result: SessionBeforeEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);

					if (this.isSessionBeforeEvent(event) && handlerResult) {
						result = handlerResult as SessionBeforeEventResult;
						if (result.cancel) {
							return result as RunnerEmitResult<TEvent>;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: message,
						stack,
					});
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		if (this.staleMessage) return undefined;
		const ctx = this.createContext();
		let currentMessage = event.message;
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("message_end");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
					const handlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
					if (!handlerResult?.message) continue;

					if (handlerResult.message.role !== currentMessage.role) {
						this.emitError({
							extensionPath: ext.path,
							event: "message_end",
							error: "message_end handlers must return a message with the same role",
						});
						continue;
					}

					currentMessage = handlerResult.message;
					modified = true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "message_end",
						error: message,
						stack,
					});
				}
			}
		}

		try {
			// CACHE CRITICAL: message:end filters rewrite finalized transcript
			// messages. Non-deterministic rewrites of prior turns change the next
			// cached message prefix, so filters must be stable for the same input.
			const filteredMessage = await applyFilters("message:end", currentMessage, event);
			if (filteredMessage !== currentMessage) {
				if (filteredMessage.role !== currentMessage.role) {
					this.emitError({
						extensionPath: "<hook-filter:message:end>",
						event: "message:end",
						error: "message:end filters must return a message with the same role",
					});
				} else {
					currentMessage = filteredMessage;
					modified = true;
				}
			}
		} catch (err) {
			this.emitError({
				extensionPath: "<hook-filter:message:end>",
				event: "message:end",
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
		}

		return modified ? currentMessage : undefined;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		if (this.staleMessage) return undefined;
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_result");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = (await handler(currentEvent, ctx)) as ToolResultEventResult | undefined;
					if (!handlerResult) continue;

					if (handlerResult.content !== undefined) {
						currentEvent.content = handlerResult.content;
						modified = true;
					}
					if (handlerResult.details !== undefined) {
						currentEvent.details = handlerResult.details;
						modified = true;
					}
					if (handlerResult.isError !== undefined) {
						currentEvent.isError = handlerResult.isError;
						modified = true;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "tool_result",
						error: message,
						stack,
					});
				}
			}
		}

		if (!modified) {
			return undefined;
		}

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
		};
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		if (this.staleMessage) return undefined;
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				let handlerResult: ToolCallEventResult | undefined;
				try {
					handlerResult = (await handler(event, ctx)) as ToolCallEventResult | undefined;
				} catch (err) {
					// A session replacement (compaction/dispose) can set staleMessage
					// AFTER the guard at the top of this method and invalidate ctx while a
					// tool_call handler is running. The handler's guarded ctx getter then
					// throws assertActive. The old session is gone, so the tool result is
					// moot — short-circuit like emit() rather than letting the stale-ctx
					// guard propagate up through beforeToolCall and surface as the tool's
					// isError result (which blocks the call and confuses the model).
					// Genuine (non-stale) extension errors still propagate, preserving the
					// fail-safe "tool_call hook failure blocks execution" contract.
					if (this.staleMessage) return result;
					throw err;
				}

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		if (this.staleMessage) return undefined;
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("user_bash");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);
					if (handlerResult) {
						return handlerResult as UserBashEventResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "user_bash",
						error: message,
						stack,
					});
				}
			}
		}

		return undefined;
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		// CACHE CRITICAL: context handlers replace the model-facing message list
		// before provider conversion on every LLM call. Keep prior history stable;
		// use this seam to filter stale dynamic artifacts or append one-call tail
		// context without mutating the durable transcript.
		if (this.staleMessage) return messages;
		const ctx = this.createContext();
		const signal = ctx.signal;
		let currentMessages = structuredClone(messages);

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ContextEvent = { type: "context", messages: currentMessages };
					const handlerResult = signal
						? await callContextHandlerAbortable(() => handler(event, ctx), signal)
						: await handler(event, ctx);

					if (handlerResult && (handlerResult as ContextEventResult).messages) {
						currentMessages = (handlerResult as ContextEventResult).messages!;
					}
				} catch (err) {
					if (signal?.aborted) {
						throw err;
					}
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "context",
						error: message,
						stack,
					});
				}
			}
		}

		return currentMessages;
	}

	async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		// CACHE CRITICAL: before_provider_request and provider:beforeRequest see
		// the serialized provider payload. Reordering system/tools/messages or
		// adding dynamic values before cache breakpoints invalidates prompt cache.
		if (this.staleMessage) return payload;
		const ctx = this.createContext();
		let currentPayload = payload;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_request");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeProviderRequestEvent = {
						type: "before_provider_request",
						payload: currentPayload,
					};
					const handlerResult = await handler(event, ctx);
					if (handlerResult !== undefined) {
						currentPayload = handlerResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_request",
						error: message,
						stack,
					});
				}
			}
		}

		try {
			currentPayload = await applyFilters("provider:beforeRequest", currentPayload);
		} catch (err) {
			this.emitError({
				extensionPath: "<hook-filter:provider:beforeRequest>",
				event: "provider:beforeRequest",
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
		}

		return currentPayload;
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
		source: InputSource = "interactive",
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		return this._runBeforeAgentStart(prompt, images, systemPrompt, systemPromptOptions, false, source);
	}

	/**
	 * Dry-run preview: returns the system prompt after all `before_agent_start`
	 * handlers have applied their rewrites, with `event.preview = true` so
	 * handlers can skip side effects. Messages/other results are discarded.
	 */
	async previewSystemPromptRewrites(
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<string> {
		const result = await this._runBeforeAgentStart(
			"",
			undefined,
			systemPrompt,
			systemPromptOptions,
			true,
			"interactive",
		);
		return result?.systemPrompt ?? systemPrompt;
	}

	/**
	 * Apply only the `systemPrompt:build` filters (no before_agent_start
	 * handlers) to a freshly rebuilt prompt.
	 *
	 * CACHE CRITICAL: the session rebuilds its base system prompt synchronously
	 * when the active tool/skill set changes (`_rebuildSystemPrompt`), and that
	 * raw build skips the filter chain. Without re-running these filters before
	 * the next request, cache-stabilising transforms (time-context's `Current
	 * date:` strip, cache-base-prompt's dynamic-boundary relocation) are lost on
	 * every tool change, mutating the cached prefix and bursting the prompt
	 * cache. This is the filter-only counterpart to `_runBeforeAgentStart` and
	 * deliberately does NOT run handlers (no `setActiveTools` re-entrancy).
	 */
	async applySystemPromptBuildFilters(
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<string> {
		if (this.staleMessage) return systemPrompt;
		try {
			return await applyFilters("systemPrompt:build", systemPrompt, systemPromptOptions, {
				prompt: "",
				images: undefined,
				preview: true,
			});
		} catch (err) {
			this.emitError({
				extensionPath: "<hook-filter:systemPrompt:build>",
				event: "systemPrompt:build",
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
			return systemPrompt;
		}
	}

	private async _runBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
		preview: boolean,
		source: InputSource,
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		if (this.staleMessage) return undefined;
		let currentSystemPrompt = systemPrompt;
		try {
			// CACHE CRITICAL: systemPrompt:build feeds the cached system prefix.
			// Keep output byte-stable across turns; put cwd/session/timestamp/file
			// data in messages or after the cacheable prefix instead.
			currentSystemPrompt = await applyFilters("systemPrompt:build", currentSystemPrompt, systemPromptOptions, {
				prompt,
				images,
				preview,
			});
		} catch (err) {
			this.emitError({
				extensionPath: "<hook-filter:systemPrompt:build>",
				event: "systemPrompt:build",
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
		}
		const ctx = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionContext;
		ctx.getSystemPrompt = () => {
			this.assertActive();
			return currentSystemPrompt;
		};
		ctx.forkAgent = (opts) => {
			this.assertActive();
			const context = opts.context ?? "fork";
			const shouldPreserveForkPrompt = context === "fork" && opts.systemPrompt === undefined;
			return this.forkAgentFn(shouldPreserveForkPrompt ? { ...opts, systemPrompt: currentSystemPrompt } : opts);
		};
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let systemPromptModified = currentSystemPrompt !== systemPrompt;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = {
						type: "before_agent_start",
						prompt,
						images,
						systemPrompt: currentSystemPrompt,
						systemPromptOptions,
						source,
						...(preview ? { preview: true } : {}),
					};
					const handlerResult = await handler(event, ctx);

					if (handlerResult) {
						const result = handlerResult as BeforeAgentStartEventResult;
						if (result.message && !preview) {
							messages.push(result.message);
						}
						if (result.systemPrompt !== undefined) {
							currentSystemPrompt = result.systemPrompt;
							systemPromptModified = true;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_agent_start",
						error: message,
						stack,
					});
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		if (this.staleMessage) return { skillPaths: [], promptPaths: [], themePaths: [] };
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("resources_discover");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
					const handlerResult = await handler(event, ctx);
					const result = handlerResult as ResourcesDiscoverResult | undefined;

					if (result?.skillPaths?.length) {
						skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.promptPaths?.length) {
						promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.themePaths?.length) {
						themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "resources_discover",
						error: message,
						stack,
					});
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<InputEventResult> {
		if (this.staleMessage) return { action: "continue" };
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const ext of this.extensions) {
			for (const handler of ext.handlers.get("input") ?? []) {
				try {
					const event: InputEvent = {
						type: "input",
						text: currentText,
						images: currentImages,
						source,
						streamingBehavior,
					};
					const result = (await handler(event, ctx)) as InputEventResult | undefined;
					if (result?.action === "handled") return result;
					if (result?.action === "transform") {
						currentText = result.text;
						currentImages = result.images ?? currentImages;
					}
				} catch (err) {
					this.emitError({
						extensionPath: ext.path,
						event: "input",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}
}
