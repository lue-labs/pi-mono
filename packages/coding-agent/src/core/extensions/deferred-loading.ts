// Fork-owned module (fork-delta reforge): deferred-extension batch loading.
// Body moved verbatim from ExtensionRunner.loadDeferredExtensionsOnce so the
// inline fork delta in runner.ts stays small.

import type { EventBus } from "../event-bus.ts";
import { loadDeferredExtension } from "./loader.ts";
import type { DeferredExtension, Extension, ExtensionError, ExtensionRuntime } from "./types.ts";

/**
 * Drain `deferredExtensions` and load each entry into `extensions`. New tools
 * registered during the batch stay deactivated (`suppressNewToolActivation`)
 * and become available via one `refreshTools({ activateNewTools: false })` at
 * the end, keeping the active tool set — and therefore the cached `tools[]`
 * prefix — stable. Fires `listeners` once when at least one extension loaded.
 */
export async function loadDeferredExtensionsBatch(options: {
	deferredExtensions: DeferredExtension[];
	extensions: Extension[];
	runtime: ExtensionRuntime;
	eventBus: EventBus;
	cwd: string;
	emitError: (error: ExtensionError) => void;
	listeners: Iterable<() => void>;
}): Promise<void> {
	const { deferredExtensions, extensions, runtime, eventBus, cwd, emitError, listeners } = options;
	const pending = deferredExtensions.splice(0);
	const previousSuppressNewToolActivation = runtime.suppressNewToolActivation;
	runtime.suppressNewToolActivation = true;
	try {
		for (const deferred of pending) {
			const { extension, error } = await loadDeferredExtension(deferred, cwd, eventBus, runtime);
			if (error) {
				emitError({ extensionPath: deferred.path, event: "deferred_load", error });
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
			extensions.push(extension);
		}
	} finally {
		runtime.suppressNewToolActivation = previousSuppressNewToolActivation;
	}
	runtime.refreshTools({ activateNewTools: false });
	if (pending.length > 0) {
		for (const listener of listeners) {
			listener();
		}
	}
}
