import {
	CONTEXT_USAGE_SERVICE_ID,
	type ContextUsageSnapshotService,
	estimateContextUsageSnapshot,
} from "../context-usage.ts";
import { getDeferredToolCapabilities } from "../deferred-tool-capabilities.ts";
import { scanDiscoveredDeferredToolNames } from "../deferred-tools.ts";
import { addAction, load } from "./extension-hooks.ts";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "./types.ts";

function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("extension ctx is stale");
}

async function getEffectiveSystemPrompt(ctx: ExtensionContext): Promise<string> {
	try {
		return await ctx.getEffectiveSystemPrompt();
	} catch (error) {
		if (isStaleContextError(error)) throw error;
		return ctx.getSystemPrompt();
	}
}

export function hookContextUsage(pi: ExtensionAPI): void {
	let snapshot: ContextUsage | undefined;
	let refreshQueued = false;
	let latestContext: ExtensionContext | undefined;

	const service: ContextUsageSnapshotService = {
		get: () => snapshot,
	};

	pi.harness.provide<ContextUsageSnapshotService>(CONTEXT_USAGE_SERVICE_ID, service);

	const updateSnapshot = (ctx: ExtensionContext, systemPrompt: string): void => {
		const contextWindow = ctx.model?.contextWindow ?? 0;
		if (contextWindow <= 0) {
			snapshot = undefined;
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		const discoveryScanInputs: unknown[] = [];
		for (const entry of branch) {
			discoveryScanInputs.push(entry);
			if (entry.type === "message") discoveryScanInputs.push(entry.message);
		}
		snapshot = estimateContextUsageSnapshot({
			branch,
			systemPrompt,
			toolDefinitions: pi.tools.definitions(),
			activeToolNames: pi.tools.active(),
			contextWindow,
			nativeDeferredTools: getDeferredToolCapabilities(ctx.model).nativeDeferredTools,
			loadedDeferredToolNames: scanDiscoveredDeferredToolNames(discoveryScanInputs),
		});
	};

	const refresh = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const systemPrompt = await getEffectiveSystemPrompt(ctx);
			updateSnapshot(ctx, systemPrompt);
		} catch (error) {
			if (isStaleContextError(error)) return;
			snapshot = undefined;
		}
	};

	const queueRefresh = (ctx: ExtensionContext): void => {
		latestContext = ctx;
		if (refreshQueued) return;

		refreshQueued = true;
		queueMicrotask(() => {
			refreshQueued = false;
			const ctx = latestContext;
			if (!ctx) return;
			void refresh(ctx).catch(() => {
				snapshot = undefined;
			});
		});
	};

	pi.on("session_start", (_event, ctx) => {
		queueRefresh(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		queueRefresh(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		queueRefresh(ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		try {
			updateSnapshot(ctx, event.systemPrompt);
		} catch (error) {
			if (isStaleContextError(error)) return;
			snapshot = undefined;
		}
	});
	pi.on("message_end", (_event, ctx) => {
		queueRefresh(ctx);
	});
	pi.on("turn_end", (_event, ctx) => {
		queueRefresh(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		queueRefresh(ctx);
	});
	pi.on("tools_changed", (_event, ctx) => {
		queueRefresh(ctx);
	});
}

addAction(load, "contextUsage", hookContextUsage);
