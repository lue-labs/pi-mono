// Fork-owned module (fork-delta reforge): the fork-added slice of the
// ExtensionAPI surface, plus the process-scoped service registry backing
// `pi.service(..., { scope: "process" })`. Bodies moved verbatim from
// loader.ts so the inline fork delta there stays small; `createExtensionAPI`
// spreads `createForkExtensionAPI(...)` into the API literal.

import type { AgentSession } from "../agent-session.ts";
import {
	getLiveSession as getLiveSessionFromRegistry,
	registerLiveSession as registerLiveSessionInRegistry,
	unregisterLiveSession as unregisterLiveSessionInRegistry,
} from "../agents/live-sessions.ts";
import {
	addAction,
	addFilter,
	applyFilters,
	registerHook,
	removeAction,
	removeFilter,
	removeHook,
} from "./extension-hooks.ts";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionHookHandle,
	ExtensionRuntime,
	MessageRenderer,
	SessionState,
	SessionStateOptions,
} from "./types.ts";

const processServices = new Map<string, unknown>();

export function getExtensionProcessService<T>(id: string): T | undefined {
	return processServices.get(id) as T | undefined;
}

export function deleteExtensionProcessServiceForTests(id: string): void {
	processServices.delete(id);
}

function createHookHandle<Name extends string>(name: Name, assertActive: () => void): ExtensionHookHandle<Name> {
	return {
		name,
		action(id: string, action: ExtensionFactory, options?: { priority?: number }) {
			assertActive();
			return addAction(name, id, action, options);
		},
		filter<T = unknown>(
			id: string,
			filter: (value: T, ...args: unknown[]) => T | Promise<T>,
			options?: { priority?: number },
		) {
			assertActive();
			return addFilter(name, id, filter, options);
		},
		removeAction(id: string) {
			assertActive();
			removeAction(name, id);
		},
		removeFilter(id: string) {
			assertActive();
			removeFilter(name, id);
		},
		unregister() {
			assertActive();
			removeHook(name);
		},
	};
}

/** The ExtensionAPI members owned by the fork (absent upstream). */
type ForkExtensionAPI = Pick<
	ExtensionAPI,
	| "setDefaultMessageRenderer"
	| "onSessionDispose"
	| "registerLiveSession"
	| "unregisterLiveSession"
	| "getLiveSession"
	| "registerAgentDefinitions"
	| "registerAgentChains"
	| "registerContextMode"
	| "registerRunRegistry"
	| "getRunRegistry"
	| "registerTelemetry"
	| "getTelemetry"
	| "registerMainPane"
	| "showMainPane"
	| "hasMainPane"
	| "hideMainPane"
	| "registerOverlay"
	| "showOverlay"
	| "hideOverlay"
	| "registerFooter"
	| "getExtensionConfig"
	| "tools"
	| "hooks"
	| "harness"
	| "state"
	| "service"
	| "getService"
>;

/**
 * Build the fork-added ExtensionAPI members for one extension. Registration
 * methods write to `extension`; action methods delegate to the shared
 * `runtime` — identical contract to the upstream members in
 * `createExtensionAPI`.
 */
export function createForkExtensionAPI(extension: Extension, runtime: ExtensionRuntime): ForkExtensionAPI {
	const readService = <T>(id: string): T | undefined => {
		return runtime.services.has(id) ? (runtime.services.get(id) as T) : getExtensionProcessService<T>(id);
	};
	const provideService = <T>(
		id: string,
		service: T,
		options?: { scope?: "runtime" | "process"; replace?: boolean },
	) => {
		const services = options?.scope === "process" ? processServices : runtime.services;
		if (!services.has(id) || options?.replace) {
			services.set(id, service);
		}
		return {
			id,
			current() {
				runtime.assertActive();
				return services.get(id) as T;
			},
			replace(next: T) {
				runtime.assertActive();
				services.set(id, next);
			},
			dispose() {
				services.delete(id);
			},
		};
	};

	return {
		setDefaultMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			runtime.assertActive();
			extension.defaultMessageRenderers.set(customType, renderer as MessageRenderer);
		},

		onSessionDispose(handler) {
			runtime.assertActive();
			extension.disposeHandlers.push(handler);
		},

		registerLiveSession(taskId: string, session: AgentSession): void {
			runtime.assertActive();
			registerLiveSessionInRegistry(taskId, session);
		},

		unregisterLiveSession(taskId: string): void {
			runtime.assertActive();
			unregisterLiveSessionInRegistry(taskId);
		},

		getLiveSession(taskId: string): AgentSession | undefined {
			runtime.assertActive();
			return getLiveSessionFromRegistry(taskId);
		},

		registerAgentDefinitions(definitions) {
			runtime.assertActive();
			extension.registeredAgentDefinitions.push(...definitions);
		},

		registerAgentChains(chains) {
			runtime.assertActive();
			extension.registeredAgentChains.push(...chains);
		},

		registerContextMode(name, policy) {
			runtime.assertActive();
			extension.registeredContextModes.set(name, policy);
		},

		registerRunRegistry(registry) {
			runtime.assertActive();
			runtime.setRunRegistry(registry);
		},

		getRunRegistry() {
			runtime.assertActive();
			return runtime.getRunRegistry();
		},

		registerTelemetry(telemetry) {
			runtime.assertActive();
			runtime.setTelemetry(telemetry);
		},

		getTelemetry() {
			runtime.assertActive();
			return runtime.getTelemetry();
		},

		registerMainPane(id, factory) {
			runtime.assertActive();
			extension.registeredMainPanes.set(id, factory);
		},

		showMainPane(id: string, payload?: unknown): void {
			runtime.assertActive();
			runtime.showMainPaneFn(id, payload);
		},

		hasMainPane(id: string): boolean {
			runtime.assertActive();
			return runtime.hasMainPaneFn(id);
		},

		hideMainPane(id: string): void {
			runtime.assertActive();
			runtime.hideMainPaneFn(id);
		},

		registerOverlay(id, factory) {
			runtime.assertActive();
			extension.registeredOverlays.set(id, factory);
		},

		showOverlay(id: string, payload?: unknown): void {
			runtime.assertActive();
			runtime.showOverlayFn(id, payload);
		},

		hideOverlay(id: string): void {
			runtime.assertActive();
			runtime.hideOverlayFn(id);
		},

		registerFooter(id, spec) {
			runtime.assertActive();
			extension.registeredFooters.set(id, spec);
		},

		// Config access - reads the namespace slice from settings.json
		// extensionConfig{} carried on the runtime (L3 tuning layer).
		getExtensionConfig<T = Record<string, unknown>>(namespace: string): T | undefined {
			runtime.assertActive();
			return runtime.extensionConfig[namespace] as T | undefined;
		},

		tools: {
			info() {
				runtime.assertActive();
				return runtime.getAllTools();
			},
			definitions() {
				runtime.assertActive();
				return runtime.getToolDefinitions();
			},
			active() {
				runtime.assertActive();
				return runtime.getActiveTools();
			},
			setDeferredOverrides(names: string[]): void {
				runtime.assertActive();
				runtime.setDeferredOverrides(names);
			},
			setToolNamespaces(map: Record<string, string>): void {
				runtime.assertActive();
				runtime.setToolNamespaces(map);
			},
		},

		hooks: {
			register<Name extends string>(name: Name, options?: { description?: string }): ExtensionHookHandle<Name> {
				runtime.assertActive();
				registerHook(name, options);
				return createHookHandle(name, runtime.assertActive);
			},
			get<Name extends string>(name: Name): ExtensionHookHandle<Name> {
				runtime.assertActive();
				registerHook(name);
				return createHookHandle(name, runtime.assertActive);
			},
			unregister(name) {
				runtime.assertActive();
				removeHook(name);
			},
			addAction(name, id, action, options) {
				runtime.assertActive();
				return addAction(name, id, action, options);
			},
			removeAction(name, id) {
				runtime.assertActive();
				removeAction(name, id);
			},
			addFilter<T = unknown>(
				name: string,
				id: string,
				filter: (value: T, ...args: unknown[]) => T | Promise<T>,
				options?: { priority?: number },
			) {
				runtime.assertActive();
				return addFilter(name, id, filter, options);
			},
			removeFilter(name, id) {
				runtime.assertActive();
				removeFilter(name, id);
			},
			applyFilters<T = unknown>(name: string, value: T, ...args: unknown[]): Promise<T> {
				runtime.assertActive();
				return applyFilters(name, value, ...args);
			},
		},

		harness: {
			provide<T>(id: string, service: T, options?: { scope?: "runtime" | "process"; replace?: boolean }) {
				runtime.assertActive();
				return provideService(id, service, options);
			},
			use<T>(id: string): T | undefined {
				runtime.assertActive();
				return readService<T>(id);
			},
		},

		state<T>(name: string, options: SessionStateOptions<T>): SessionState<T> {
			runtime.assertActive();
			const customType = options.customType ?? name;
			const parse = (value: unknown): T | undefined => (options.parse ? options.parse(value) : (value as T));
			return {
				get() {
					runtime.assertActive();
					let current = options.defaultValue;
					for (const entry of runtime.getCustomEntries(customType)) {
						const next = parse(entry.data);
						if (next === undefined) continue;
						current = options.merge ? options.merge(current, next) : next;
					}
					return current;
				},
				set(next: T) {
					runtime.assertActive();
					runtime.appendEntry(customType, next);
				},
				update(update: (current: T) => T) {
					runtime.assertActive();
					const next = update(this.get());
					this.set(next);
					return next;
				},
			};
		},

		service<T>(id: string, service: T, options?: { scope?: "runtime" | "process"; replace?: boolean }) {
			runtime.assertActive();
			return provideService(id, service, options);
		},

		getService<T>(id: string): T | undefined {
			runtime.assertActive();
			return readService<T>(id);
		},
	};
}
