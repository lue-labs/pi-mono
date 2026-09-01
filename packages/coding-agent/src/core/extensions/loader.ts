/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as _bundledPiAgentCore from "@lue-labs/pi-agent-core";
import type { Provider } from "@lue-labs/pi-ai";
import * as _bundledPiAi from "@lue-labs/pi-ai";
import * as _bundledPiAiCompat from "@lue-labs/pi-ai/compat";
import * as _bundledPiAiOauth from "@lue-labs/pi-ai/oauth";
import * as _bundledPiAiProviders from "@lue-labs/pi-ai/providers/all";
import type { KeyId } from "@lue-labs/pi-tui";
import * as _bundledPiTui from "@lue-labs/pi-tui";
import { createJiti } from "jiti/static";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary } from "../../config.ts";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @lue-labs/pi-coding-agent.
import * as _bundledPiCodingAgent from "../../index.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { manifestEntryPath, readPiManifest } from "../pi-manifest.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { recordTiming, time, timingsEnabled } from "../timings.ts";
import { createForkExtensionAPI } from "./extension-api-fork.ts";
import type {
	AgentTelemetry,
	DeferredExtension,
	EntryRenderer,
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionLoadError,
	ExtensionLoadRequest,
	ExtensionRuntime,
	ExtensionSetting,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	RunRegistry,
	ToolDefinition,
} from "./types.ts";

export { deleteExtensionProcessServiceForTests, getExtensionProcessService } from "./extension-api-fork.ts";

/** Modules available to extensions via virtualModules (for compiled binaries) */
const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@lue-labs/pi-agent-core": _bundledPiAgentCore,
	"@lue-labs/pi-tui": _bundledPiTui,
	"@lue-labs/pi-ai": _bundledPiAi,
	// Fork-scope extensions opt into the legacy global dispatch API by importing
	// the explicit /compat subpath; register it so the resolve succeeds in the
	// compiled binary (the bare @lue-labs/pi-ai root stays the strict core).
	"@lue-labs/pi-ai/compat": _bundledPiAiCompat,
	"@lue-labs/pi-ai/oauth": _bundledPiAiOauth,
	"@lue-labs/pi-ai/providers/all": _bundledPiAiProviders,
	"@lue-labs/pi-coding-agent": _bundledPiCodingAgent,
	// Legacy fork-scope compatibility keeps already-published @valkyriweb
	// extensions working while consumers migrate to the organization scope.
	"@valkyriweb/pi-agent-core": _bundledPiAgentCore,
	"@valkyriweb/pi-tui": _bundledPiTui,
	"@valkyriweb/pi-ai": _bundledPiAiCompat,
	"@valkyriweb/pi-ai/compat": _bundledPiAiCompat,
	"@valkyriweb/pi-ai/oauth": _bundledPiAiOauth,
	"@valkyriweb/pi-ai/providers/all": _bundledPiAiProviders,
	"@valkyriweb/pi-coding-agent": _bundledPiCodingAgent,
	// Upstream package-name compatibility for third-party extensions that import
	// the upstream scopes (@earendil-works/* current, @mariozechner/* legacy).
	// Maps onto the same bundled fork modules so value imports resolve in the
	// compiled binary (type-only imports already erase at runtime).
	"@earendil-works/pi-agent-core": _bundledPiAgentCore,
	"@earendil-works/pi-tui": _bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@earendil-works/pi-ai": _bundledPiAiCompat,
	"@earendil-works/pi-ai/compat": _bundledPiAiCompat,
	"@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
	"@earendil-works/pi-ai/providers/all": _bundledPiAiProviders,
	"@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": _bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": _bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};

const require = createRequire(import.meta.url);

const isNodeSeaBinary =
	("sea" in process.features && process.features.sea === true) ||
	process.getBuiltinModule("node:sea")?.isSea() === true;
declare const PI_BUNDLED_NODE: boolean;
const isBundledNode = typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE;
const isTypeScriptSourceRuntime = !isBunBinary && path.extname(fileURLToPath(import.meta.url)) === ".ts";

/**
 * Get aliases for jiti (used in built Node.js mode).
 * In compiled binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@lue-labs/pi-agent-core");
	const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@lue-labs/pi-tui");
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	const piAiCompatEntry = resolveWorkspaceOrImport("ai/dist/compat.js", "@lue-labs/pi-ai/compat");
	const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@lue-labs/pi-ai/oauth");
	const piAiProvidersEntry = resolveWorkspaceOrImport("ai/dist/providers/all.js", "@lue-labs/pi-ai/providers/all");

	_aliases = {
		"@lue-labs/pi-coding-agent": piCodingAgentEntry,
		"@lue-labs/pi-agent-core": piAgentCoreEntry,
		"@lue-labs/pi-tui": piTuiEntry,
		"@lue-labs/pi-ai/providers/all": piAiProvidersEntry,
		"@lue-labs/pi-ai/compat": piAiCompatEntry,
		"@lue-labs/pi-ai/oauth": piAiOauthEntry,
		"@lue-labs/pi-ai": piAiCompatEntry,
		// Preserve runtime compatibility for extension packages published before
		// the fork moved from the user scope to the organization scope.
		"@valkyriweb/pi-coding-agent": piCodingAgentEntry,
		"@valkyriweb/pi-agent-core": piAgentCoreEntry,
		"@valkyriweb/pi-tui": piTuiEntry,
		"@valkyriweb/pi-ai/providers/all": piAiProvidersEntry,
		"@valkyriweb/pi-ai/compat": piAiCompatEntry,
		"@valkyriweb/pi-ai/oauth": piAiOauthEntry,
		"@valkyriweb/pi-ai": piAiCompatEntry,
		// Upstream package-name compatibility: third-party extensions import the
		// upstream scopes (@earendil-works/* current, @mariozechner/* legacy).
		// Map them onto the fork's @lue-labs/* entries so value imports resolve
		// in the bundled binary (type-only imports already erase at runtime).
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@earendil-works/pi-agent-core": piAgentCoreEntry,
		"@earendil-works/pi-tui": piTuiEntry,
		"@earendil-works/pi-ai/providers/all": piAiProvidersEntry,
		"@earendil-works/pi-ai/compat": piAiCompatEntry,
		"@earendil-works/pi-ai/oauth": piAiOauthEntry,
		"@earendil-works/pi-ai": piAiCompatEntry,
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		"@mariozechner/pi-agent-core": piAgentCoreEntry,
		"@mariozechner/pi-tui": piTuiEntry,
		"@mariozechner/pi-ai/providers/all": piAiProvidersEntry,
		"@mariozechner/pi-ai/compat": piAiCompatEntry,
		"@mariozechner/pi-ai/oauth": piAiOauthEntry,
		"@mariozechner/pi-ai": piAiCompatEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

/**
 * Test-only: the exact module specifiers extensions can resolve, for BOTH
 * resolution paths — the compiled Bun binary (`VIRTUAL_MODULES`) and Node/dev
 * (jiti `getAliases()`). The two MUST stay in lockstep; a drift between them is
 * what dropped `@lue-labs/pi-ai/compat` from the binary map and broke fork
 * extension loading in the 0.80.x daily driver. Guarded by
 * loader-module-alias-symmetry.test.ts.
 */
export function getExtensionModuleSpecifiersForTests(): {
	virtualModules: string[];
	aliases: string[];
} {
	return {
		virtualModules: Object.keys(VIRTUAL_MODULES),
		aliases: Object.keys(getAliases()),
	};
}

/**
 * The jiti resolution options (`virtualModules`/`alias`) that make
 * `@lue-labs/pi-coding-agent`, `@lue-labs/pi-tui`, etc. resolve to the
 * running binary's own bundled modules instead of falling through to plain
 * Node `node_modules` resolution — which frequently doesn't have those
 * exact package names on disk (npm peer-conflict dedup renames, workspace
 * layouts, etc.). Any OTHER jiti-based loader for extension-shaped code
 * (e.g. `cli/agent-view-command.ts`'s standalone dashboard-package import,
 * which used to build its own bare `createJiti()` with no alias/virtualModule
 * config at all and could resolve the entrypoint file but not that file's
 * own `@lue-labs/*` imports) MUST reuse this, not reimplement it — a second
 * copy is exactly the kind of drift `loader-module-alias-symmetry.test.ts`
 * exists to catch for the two branches already in this module.
 */
export function getExtensionJitiResolutionOptions():
	| { virtualModules: Record<string, unknown>; tryNative: false }
	| { virtualModules: Record<string, unknown>; tsconfigPaths: true }
	| { alias: Record<string, string> } {
	// Compiled binaries and the bundled Node distribution use embedded modules.
	if (isBunBinary || isNodeSeaBinary || isBundledNode) return { virtualModules: VIRTUAL_MODULES, tryNative: false };
	// Source TypeScript reuses the host-resolved modules and root tsconfig paths.
	if (isTypeScriptSourceRuntime) return { virtualModules: VIRTUAL_MODULES, tsconfigPaths: true };
	// Unbundled Node builds use dist aliases.
	return { alias: getAliases() };
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

let extensionCacheCwd: string | undefined;
let extensionCacheGeneration = 0;
const extensionCache = new Map<string, ExtensionFactory>();

interface ExtensionCacheToken {
	cwd: string;
	generation: number;
}

export function clearExtensionCache(): void {
	extensionCache.clear();
	extensionCacheCwd = undefined;
	extensionCacheGeneration++;
}

function useExtensionCacheCwd(cwd: string): ExtensionCacheToken {
	const resolvedCwd = resolvePath(cwd);
	if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
		clearExtensionCache();
	}
	extensionCacheCwd = resolvedCwd;
	return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string; runRegistry?: RunRegistry; telemetry?: AgentTelemetry } = {};
	const eventBusUnsubscribers = new Set<() => void>();
	// Default no-op stubs for B5 show/hide handlers. interactive-mode replaces
	// these via `ExtensionRunner.bindSlotUI()`; non-UI modes silently swallow
	// show/hide requests.
	const slotNoOp: (..._args: unknown[]) => void = () => {};
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		getToolDefinitions: notInitialized,
		getCustomEntries: notInitialized,
		setActiveTools: notInitialized,
		setDeferredOverrides: notInitialized,
		setToolNamespaces: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		setExtensionConfigValue: notInitialized,
		flagValues: new Map(),
		extensionConfig: {},
		pendingProviderRegistrations: [],
		suppressNewToolActivation: false,
		pendingNativeProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			if (state.staleMessage) return;
			state.staleMessage =
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
			for (const unsubscribe of eventBusUnsubscribers) unsubscribe();
			eventBusUnsubscribers.clear();
		},
		trackEventBusSubscription: (unsubscribe) => {
			let active = true;
			const trackedUnsubscribe = () => {
				if (!active) return;
				active = false;
				eventBusUnsubscribers.delete(trackedUnsubscribe);
				unsubscribe();
			};
			eventBusUnsubscribers.add(trackedUnsubscribe);
			return trackedUnsubscribe;
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		registerNativeProvider: (provider, extensionPath = "<unknown>") => {
			runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
			runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter(
				(r) => r.provider.id !== name,
			);
		},
		setRunRegistry: (registry) => {
			if (!state.runRegistry) state.runRegistry = registry;
		},
		getRunRegistry: () => state.runRegistry,
		setTelemetry: (telemetry) => {
			if (!state.telemetry) state.telemetry = telemetry;
		},
		getTelemetry: () => state.telemetry,
		showMainPaneFn: slotNoOp,
		hideMainPaneFn: slotNoOp,
		showOverlayFn: slotNoOp,
		hideOverlayFn: slotNoOp,
		hasMainPaneFn: () => false,
		services: new Map(),
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): { api: ExtensionAPI; commit: () => void; discard: () => void } {
	const pendingFlagValues = new Map<string, boolean | string>();
	const pendingRuntimeChanges: Array<() => void> = [];
	const loadingUnsubscribers: Array<() => void> = [];
	let state: "loading" | "active" | "failed" = "loading";
	const assertActive = () => {
		if (state === "failed") {
			throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
		}
		runtime.assertActive();
	};
	const applyRuntimeChange = (change: () => void) => {
		if (state === "loading") pendingRuntimeChanges.push(change);
		else change();
	};
	const clearPending = () => {
		pendingFlagValues.clear();
		pendingRuntimeChanges.length = 0;
		loadingUnsubscribers.length = 0;
	};

	const api = {
		cwd,
		...createForkExtensionAPI(extension, runtime),

		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			assertActive();
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools({ activateNewTools: !runtime.suppressNewToolActivation });
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			assertActive();
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.ts").ExtensionContext) => Promise<void> | void;
			},
		): void {
			assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			assertActive();
			if (options.default !== undefined && typeof options.default !== options.type) {
				throw new Error(
					`Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`,
				);
			}
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				if (state === "loading") {
					if (!pendingFlagValues.has(name)) pendingFlagValues.set(name, options.default);
				} else {
					runtime.flagValues.set(name, options.default);
				}
			}
		},

		registerSetting(options: Omit<ExtensionSetting, "extensionPath">): void {
			assertActive();
			if (options.values.length === 0) {
				throw new Error(`Extension setting must define at least one value: ${options.id}`);
			}
			if (!options.values.includes(options.currentValue)) {
				throw new Error(`Extension setting currentValue must be one of values: ${options.id}`);
			}
			if (new Set(options.values).size !== options.values.length) {
				throw new Error(`Extension setting values must be unique: ${options.id}`);
			}
			if (extension.registeredSettings.has(options.id)) {
				throw new Error(`Extension setting already registered: ${options.id}`);
			}
			extension.registeredSettings.set(options.id, {
				...options,
				extensionPath: extension.path,
			});
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		registerMarkdownTransformer(transformer: MarkdownTransformer): void {
			assertActive();
			extension.markdownTransformer = transformer;
		},

		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			assertActive();
			extension.entryRenderers ??= new Map();
			extension.entryRenderers.set(customType, renderer as EntryRenderer);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.has(name) ? runtime.flagValues.get(name) : pendingFlagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			assertActive();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			assertActive();
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
			assertActive();
			if (typeof providerOrName === "string") {
				if (!config) throw new Error("Provider config is required when registering by name");
				applyRuntimeChange(() => runtime.registerProvider(providerOrName, config, extension.path));
				return;
			}
			applyRuntimeChange(() => runtime.registerNativeProvider(providerOrName, extension.path));
		},

		unregisterProvider(name: string) {
			assertActive();
			applyRuntimeChange(() => runtime.unregisterProvider(name, extension.path));
		},

		events: {
			emit(channel, data) {
				assertActive();
				eventBus.emit(channel, data);
			},
			on(channel, handler) {
				assertActive();
				const unsubscribe = runtime.trackEventBusSubscription(eventBus.on(channel, handler));
				if (state === "loading") loadingUnsubscribers.push(unsubscribe);
				return unsubscribe;
			},
		},
	} as ExtensionAPI;

	return {
		api,
		commit: () => {
			if (state !== "loading") return;
			runtime.assertActive();
			for (const [name, value] of pendingFlagValues) {
				if (!runtime.flagValues.has(name)) runtime.flagValues.set(name, value);
			}
			for (const apply of pendingRuntimeChanges) apply();
			state = "active";
			clearPending();
		},
		discard: () => {
			if (state !== "loading") return;
			state = "failed";
			for (const unsubscribe of loadingUnsubscribers) unsubscribe();
			clearPending();
		},
	};
}

function isCurrentCacheToken(cacheToken: ExtensionCacheToken | undefined): cacheToken is ExtensionCacheToken {
	return (
		cacheToken !== undefined &&
		extensionCacheCwd === cacheToken.cwd &&
		extensionCacheGeneration === cacheToken.generation
	);
}

async function loadExtensionModule(extensionPath: string, cacheToken?: ExtensionCacheToken) {
	if (isCurrentCacheToken(cacheToken)) {
		const cachedFactory = extensionCache.get(extensionPath);
		if (cachedFactory) {
			return cachedFactory;
		}
	}

	// Pre-compiled .js/.mjs extensions can be loaded with native import() —
	// no jiti/babel overhead. Only use jiti for .ts files.
	if (/\.[mc]?js$/.test(extensionPath)) {
		try {
			const url = pathToFileURL(extensionPath).href;
			const module = await import(url);
			const factory = (module.default ?? module) as ExtensionFactory;
			if (typeof factory === "function" && isCurrentCacheToken(cacheToken)) {
				extensionCache.set(extensionPath, factory);
			}
			return typeof factory === "function" ? factory : undefined;
		} catch {
			// Fall through to jiti (handles CommonJS / alias needs)
		}
	}

	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		// Cache transpiled .ts extension source to disk so jiti/babel doesn't
		// re-parse on every boot. Explicit path so it survives reboots
		// (fsCache:true falls back to tmpdir which is wiped on reboot).
		fsCache: path.join(getAgentDir(), ".jiti-cache"),
		// In Bun binary/SEA/bundled Node: use virtualModules for bundled packages
		// (no filesystem resolution). Also disable tryNative so jiti handles ALL
		// imports (not just the entry point). In Node.js/dev: use aliases to
		// resolve to node_modules paths.
		...getExtensionJitiResolutionOptions(),
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	if (typeof factory !== "function") {
		return undefined;
	}
	if (isCurrentCacheToken(cacheToken)) {
		extensionCache.set(extensionPath, factory);
	}
	return factory;
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		defaultMessageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		registeredSettings: new Map(),
		forkSystemPromptTransforms: [],
		shortcuts: new Map(),
		disposeHandlers: [],
		registeredAgentDefinitions: [],
		registeredAgentChains: [],
		registeredContextModes: new Map(),
		registeredMainPanes: new Map(),
		registeredOverlays: new Map(),
		registeredFooters: new Map(),
	};
}

async function initializeExtension(
	factory: ExtensionFactory,
	extensionPath: string,
	resolvedPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<Extension> {
	const extension = createExtension(extensionPath, resolvedPath);
	const load = createExtensionAPI(extension, runtime, cwd, eventBus);
	try {
		await factory(load.api);
		load.commit();
	} catch (error) {
		load.discard();
		throw error;
	}
	time(`${extensionPath} factory`, "extensions");
	return extension;
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const factory = await loadExtensionModule(resolvedPath, cacheToken);
		time(`${extensionPath} module import`, "extensions");
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = await initializeExtension(factory, extensionPath, resolvedPath, cwd, eventBus, runtime);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const resolvedCwd = resolvePath(cwd);
	return initializeExtension(factory, extensionPath, extensionPath, resolvedCwd, eventBus, runtime);
}

function normalizeLoadRequest(input: string | ExtensionLoadRequest): ExtensionLoadRequest {
	return typeof input === "string" ? { path: input, load: "eager" } : { load: "eager", ...input };
}

export async function loadDeferredExtension(
	deferred: DeferredExtension,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	return loadExtension(deferred.path, cwd, eventBus, runtime);
}

/**
 * Load eager extensions now and keep deferred entries as metadata-only stubs.
 */
async function loadExtensionsInternal(
	inputs: Array<string | ExtensionLoadRequest>,
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
	useCache = false,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const deferredExtensions: DeferredExtension[] = [];
	const errors: ExtensionLoadError[] = [];
	const cacheToken = useCache ? useExtensionCacheCwd(cwd) : undefined;
	const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const resolvedRuntime = runtime ?? createExtensionRuntime();

	const timing = timingsEnabled();
	for (const input of inputs) {
		const { path: extPath, load, discovered } = normalizeLoadRequest(input);
		if (load === "deferred") {
			deferredExtensions.push({ path: extPath });
			continue;
		}

		const startedAt = timing ? performance.now() : 0;
		const { extension, error } = await loadExtension(
			extPath,
			resolvedCwd,
			resolvedEventBus,
			resolvedRuntime,
			cacheToken,
		);
		if (timing) {
			recordTiming(`import ${extPath}`, performance.now() - startedAt, "extensions");
		}

		if (error) {
			// Carry the discovered flag onto the error so callers can decide whether
			// this failure is fatal (explicitly requested) or a skip (auto-discovered).
			errors.push(discovered ? { path: extPath, error, discovered: true } : { path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		deferredExtensions,
		errors,
		eventBus: resolvedEventBus,
		runtime: resolvedRuntime,
	};
}

export async function loadExtensions(
	inputs: Array<string | ExtensionLoadRequest>,
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(inputs, cwd, eventBus, runtime);
}

export async function loadExtensionsCached(
	inputs: Array<string | ExtensionLoadRequest>,
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(inputs, cwd, eventBus, runtime, true);
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs");
}

function isDisabledExtensionEntry(name: string): boolean {
	return name.endsWith(".disabled") || name.includes(".disabled.");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with "pi" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extEntry of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, manifestEntryPath(extEntry));
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		// Collect file entries first so we can prefer .js over .ts when both exist.
		const fileNames = new Set(entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name));

		for (const entry of entries) {
			if (isDisabledExtensionEntry(entry.name)) continue;

			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			// Prefer pre-compiled .js over .ts when both exist (avoids jiti transpile).
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				if (
					entry.name.endsWith(".ts") &&
					(fileNames.has(entry.name.replace(/\.ts$/, ".js")) || fileNames.has(entry.name.replace(/\.ts$/, ".mjs")))
				) {
					continue; // .js/.mjs sibling exists — skip the .ts
				}
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const allPaths: ExtensionLoadRequest[] = [];
	const seen = new Set<string>();

	// `discovered` marks extensions found by scanning a directory. Their load
	// failures are non-fatal; explicitly named ones stay fatal.
	const addPaths = (paths: string[], discovered: boolean) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(discovered ? { path: p, load: "eager", discovered: true } : { path: p, load: "eager" });
			}
		}
	};

	// 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
	const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir), true);

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir), true);

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with pi manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				// A directory named explicitly, but its individual entry points were
				// still found by scanning, so treat them as discovered.
				addPaths(entries, true);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved), true);
			continue;
		}

		// A file named explicitly by the caller: failing to load it stays fatal.
		addPaths([resolved], false);
	}

	return loadExtensions(allPaths, resolvedCwd, eventBus);
}
