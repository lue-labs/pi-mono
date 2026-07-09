// Fork-owned module (fork-delta reforge): registry walkers backing the
// fork-added ExtensionRunner surface. Bodies moved verbatim from runner.ts so
// the inline fork delta there stays small; the runner methods delegate here.

import type { AgentChainDefinition } from "../agents/chains.ts";
import type { AgentDefinition } from "../agents/types.ts";
import type {
	Extension,
	ExtensionContextModePolicy,
	ExtensionError,
	ExtensionFooterSpec,
	ExtensionMainPaneFactory,
	ExtensionOverlayFactory,
	MessageRenderer,
} from "./types.ts";

/**
 * Fire all handlers registered via `ctx.onSessionDispose`. Called
 * synchronously from `AgentSession.dispose()` before the runner is
 * invalidated. Per-handler errors are surfaced through the runner's error
 * stream and do not skip remaining handlers.
 */
export function fireSessionDisposeHandlers(extensions: Extension[], emitError: (error: ExtensionError) => void): void {
	for (const ext of extensions) {
		for (const handler of ext.disposeHandlers) {
			try {
				handler();
			} catch (err) {
				emitError({
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
export function collectRegisteredAgentDefinitions(extensions: Extension[]): AgentDefinition[] {
	const defs: AgentDefinition[] = [];
	for (const ext of extensions) {
		defs.push(...ext.registeredAgentDefinitions);
	}
	return defs;
}

/**
 * Snapshot of every agent chain registered through
 * `ctx.registerAgentChains`.
 */
export function collectRegisteredAgentChains(extensions: Extension[]): AgentChainDefinition[] {
	const chains: AgentChainDefinition[] = [];
	for (const ext of extensions) {
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
export function findRegisteredContextMode(
	extensions: Extension[],
	name: string,
): ExtensionContextModePolicy | undefined {
	for (const ext of extensions) {
		const policy = ext.registeredContextModes.get(name);
		if (policy) return policy;
	}
	return undefined;
}

/**
 * Lookup a main pane factory registered through `pi.registerMainPane`.
 * Walks all extensions in load order and returns the first match.
 * Returns `undefined` if no extension has registered the given id.
 */
export function findRegisteredMainPane(extensions: Extension[], id: string): ExtensionMainPaneFactory | undefined {
	for (const ext of extensions) {
		const factory = ext.registeredMainPanes.get(id);
		if (factory) return factory;
	}
	return undefined;
}

/**
 * Lookup an overlay factory registered through `pi.registerOverlay`.
 * Walks all extensions in load order and returns the first match.
 */
export function findRegisteredOverlay(extensions: Extension[], id: string): ExtensionOverlayFactory | undefined {
	for (const ext of extensions) {
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
export function collectRegisteredFooters(
	extensions: Extension[],
): Array<{ id: string; spec: ExtensionFooterSpec; extensionPath: string }> {
	const result: Array<{ id: string; spec: ExtensionFooterSpec; extensionPath: string }> = [];
	for (const ext of extensions) {
		for (const [id, spec] of ext.registeredFooters) {
			result.push({ id, spec, extensionPath: ext.path });
		}
	}
	return result;
}

/**
 * Return the first default renderer registered for `customType` via
 * `ctx.setDefaultMessageRenderer`, or undefined if none. Intended as a
 * fallback consulted after `getMessageRenderer`.
 */
export function findDefaultMessageRenderer(extensions: Extension[], customType: string): MessageRenderer | undefined {
	for (const ext of extensions) {
		const renderer = ext.defaultMessageRenderers.get(customType);
		if (renderer) {
			return renderer;
		}
	}
	return undefined;
}
