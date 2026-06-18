import {
	CONTEXT_USAGE_SERVICE_ID,
	type ContextUsageSnapshotService,
	estimateContextUsageSnapshot,
} from "../context-usage.ts";
import { getDeferredToolCapabilities } from "../deferred-tool-capabilities.ts";
import { scanPromptVisibleDeferredToolNames } from "../deferred-tools.ts";
import { buildSessionContext, type SessionEntry } from "../session-manager.ts";
import { addAction, load } from "./extension-hooks.ts";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "./types.ts";

function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("extension ctx is stale");
}

function serializesToolReferenceBlocks(model: ExtensionContext["model"]): boolean {
	return model?.api === "anthropic-messages";
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

		const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		const contextEntries = sessionContext.messages.map((message, index): SessionEntry => {
			const timestamp =
				typeof message.timestamp === "number"
					? new Date(message.timestamp).toISOString()
					: new Date().toISOString();
			return {
				type: "message",
				id: `context-${index}`,
				parentId: index === 0 ? null : `context-${index - 1}`,
				timestamp,
				message,
			};
		});
		const capabilities = getDeferredToolCapabilities(ctx.model);
		snapshot = estimateContextUsageSnapshot({
			branch: contextEntries,
			systemPrompt,
			toolDefinitions: pi.tools.definitions(),
			activeToolNames: pi.tools.active(),
			contextWindow,
			nativeDeferredTools: capabilities.nativeDeferredTools,
			loadedDeferredToolNames: serializesToolReferenceBlocks(ctx.model)
				? scanPromptVisibleDeferredToolNames(sessionContext.messages)
				: [],
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
