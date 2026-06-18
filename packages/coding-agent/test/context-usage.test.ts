import type { AgentMessage } from "@valkyriweb/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import {
	CONTEXT_USAGE_SERVICE_ID,
	type ContextUsageSnapshotService,
	estimateContextUsageSnapshot,
	estimateToolSchemaTokens,
} from "../src/core/context-usage.ts";
import { hookContextUsage } from "../src/core/extensions/context-usage.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

function messageEntry(message: AgentMessage, id = "entry"): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-05-28T00:00:00.000Z",
		message,
	};
}

function userMessage(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function assistantMessage(totalTokens: number): AgentMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function toolDefinition(name: string, description: string): ToolDefinition {
	return {
		name,
		label: name,
		description,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [] }),
	};
}

function toolDefinitionWithSchemaTokens(name: string, tokens: number): ToolDefinition {
	for (let descriptionLength = 0; descriptionLength < 1000; descriptionLength += 1) {
		const candidate = toolDefinition(name, "a".repeat(descriptionLength));
		if (estimateToolSchemaTokens([candidate]) === tokens) return candidate;
	}
	throw new Error(`Could not create ${tokens}-token tool schema fixture`);
}

function getContextUsageFor(options: {
	systemPrompt: string;
	branch?: SessionEntry[];
	toolDefinitions?: ToolDefinition[];
	activeToolNames?: string[];
	contextWindow?: number;
	nativeDeferredTools?: boolean;
	loadedDeferredToolNames?: string[];
	useProviderUsage?: boolean;
}) {
	const contextWindow = options.contextWindow ?? 1000;
	const branch = options.branch ?? [];
	const snapshot = estimateContextUsageSnapshot({
		branch,
		systemPrompt: options.systemPrompt,
		toolDefinitions: options.toolDefinitions ?? [],
		activeToolNames: options.activeToolNames ?? [],
		contextWindow,
		nativeDeferredTools: options.nativeDeferredTools,
		loadedDeferredToolNames: options.loadedDeferredToolNames,
		useProviderUsage: options.useProviderUsage,
	});
	const service: ContextUsageSnapshotService = {
		get: () => snapshot,
	};

	return AgentSession.prototype.getContextUsage.call({
		model: { contextWindow },
		systemPrompt: options.systemPrompt,
		messages: [],
		sessionManager: {
			getBranch: () => branch,
		},
		_extensionRunner: {
			getService: (id: string) => (id === CONTEXT_USAGE_SERVICE_ID ? service : undefined),
		},
	});
}

describe("AgentSession context usage", () => {
	it("includes the startup system prompt, active tool schemas, and transcript before provider usage exists", () => {
		const activeTool = toolDefinitionWithSchemaTokens("active_tool", 40);
		const usage = getContextUsageFor({
			systemPrompt: "x".repeat(400),
			branch: [messageEntry(userMessage("u".repeat(40)))],
			toolDefinitions: [activeTool],
			activeToolNames: [activeTool.name],
			contextWindow: 1000,
		});

		expect(usage).toMatchObject({
			tokens: 150,
			contextWindow: 1000,
			percent: 15,
		});
		expect(usage?.details).toMatchObject({
			source: "loaded_estimate",
			loadedToolSchemaTokens: 40,
		});
	});

	it("does not count deferred tool schemas until they are active", () => {
		const activeTool = toolDefinition("active_tool", "a".repeat(16));
		const inactiveDeferredTool = {
			...toolDefinition("inactive_deferred_tool", "d".repeat(400)),
			deferLoading: true,
		};
		const expectedTokens = 50 + estimateToolSchemaTokens([activeTool]);
		const usage = getContextUsageFor({
			systemPrompt: "x".repeat(200),
			toolDefinitions: [activeTool, inactiveDeferredTool],
			activeToolNames: [activeTool.name],
			contextWindow: 1000,
		});

		expect(usage).toMatchObject({
			tokens: expectedTokens,
			contextWindow: 1000,
			percent: (expectedTokens / 1000) * 100,
		});
	});

	it("counts deferred tool schemas after they become active on fallback providers", () => {
		const deferredTool = {
			...toolDefinition("deferred_tool", "d".repeat(400)),
			deferLoading: true,
		};
		const expectedTokens = 50 + estimateToolSchemaTokens([deferredTool]);
		const usage = getContextUsageFor({
			systemPrompt: "x".repeat(200),
			toolDefinitions: [deferredTool],
			activeToolNames: [deferredTool.name],
			contextWindow: 1000,
		});

		expect(usage).toMatchObject({
			tokens: expectedTokens,
			contextWindow: 1000,
			percent: (expectedTokens / 1000) * 100,
		});
	});

	it("does not count active native-deferred schemas as loaded context before discovery", () => {
		const deferredTool = {
			...toolDefinition("Find", "d".repeat(400)),
			deferLoading: true,
		};
		const deferredTokens = estimateToolSchemaTokens([deferredTool]);
		const usage = getContextUsageFor({
			systemPrompt: "x".repeat(200),
			toolDefinitions: [deferredTool],
			activeToolNames: [deferredTool.name],
			contextWindow: 1000,
			nativeDeferredTools: true,
		});

		expect(usage).toMatchObject({
			tokens: 50,
			contextWindow: 1000,
			percent: 5,
		});
		expect(usage?.details).toMatchObject({
			loadedToolSchemaTokens: 0,
			deferredToolSchemaTokens: deferredTokens,
			deferredToolCount: 1,
		});
	});

	it("counts discovered native-deferred schemas as loaded context", () => {
		const deferredTool = {
			...toolDefinition("Find", "d".repeat(400)),
			deferLoading: true,
		};
		const loadedToolTokens = estimateToolSchemaTokens([deferredTool]);
		const expectedTokens = 50 + loadedToolTokens;
		const usage = getContextUsageFor({
			systemPrompt: "x".repeat(200),
			toolDefinitions: [deferredTool],
			activeToolNames: [deferredTool.name],
			contextWindow: 1000,
			nativeDeferredTools: true,
			loadedDeferredToolNames: [deferredTool.name],
		});

		expect(usage).toMatchObject({
			tokens: expectedTokens,
			contextWindow: 1000,
			percent: (expectedTokens / 1000) * 100,
		});
		expect(usage?.details).toMatchObject({
			loadedToolSchemaTokens: loadedToolTokens,
			deferredToolSchemaTokens: 0,
			loadedDeferredToolCount: 1,
		});
	});

	it("does not double-count the system prompt or tool schemas after provider usage exists", () => {
		const usage = getContextUsageFor({
			systemPrompt: "x".repeat(200),
			branch: [
				messageEntry(assistantMessage(110), "assistant"),
				messageEntry(userMessage("u".repeat(40)), "trailing-user"),
			],
			toolDefinitions: [toolDefinition("active_tool", "a".repeat(400))],
			activeToolNames: ["active_tool"],
			contextWindow: 1000,
		});

		expect(usage).toMatchObject({
			tokens: 120,
			contextWindow: 1000,
			percent: 12,
		});
		expect(usage?.details?.source).toBe("provider_usage");
	});

	it("keeps provider usage as the public token count while merging snapshot details", () => {
		const branch = [
			messageEntry(assistantMessage(110), "assistant"),
			messageEntry(userMessage("u".repeat(40)), "trailing-user"),
		];
		const service: ContextUsageSnapshotService = {
			get: () => ({
				tokens: 500,
				contextWindow: 1000,
				percent: 50,
				details: { source: "loaded_estimate", loadedContextTokens: 140, deferredToolSchemaTokens: 30 },
			}),
		};

		const usage = AgentSession.prototype.getContextUsage.call({
			model: { contextWindow: 1000 },
			systemPrompt: "x".repeat(200),
			messages: branch.filter((entry) => entry.type === "message").map((entry) => entry.message),
			sessionManager: {
				getBranch: () => branch,
			},
			_extensionRunner: {
				getService: (id: string) => (id === CONTEXT_USAGE_SERVICE_ID ? service : undefined),
			},
		});

		expect(usage).toMatchObject({
			tokens: 120,
			contextWindow: 1000,
			percent: 12,
			details: {
				source: "provider_usage",
				providerUsageTokens: 120,
				loadedContextTokens: 140,
				deferredToolSchemaTokens: 30,
			},
		});
	});

	it("ignores queued refreshes from stale extension contexts", async () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
		const pi = {
			harness: { provide: () => {} },
			tools: {
				definitions: () => [],
				active: () => [],
			},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;
		hookContextUsage(pi);

		const staleError = new Error(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().",
		);
		const ctx = {
			model: { contextWindow: 1000 },
			getEffectiveSystemPrompt: async () => "system",
			getSystemPrompt: () => "system",
			get sessionManager(): never {
				throw staleError;
			},
		} as unknown as ExtensionContext;

		handlers.get("session_start")?.[0]?.({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("updates the cached snapshot from the prepared prompt before agent start", () => {
		let service: ContextUsageSnapshotService | undefined;
		const activeTool = toolDefinition("active_tool", "a".repeat(64));
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
		const pi = {
			harness: {
				provide: (_id: string, providedService: ContextUsageSnapshotService) => {
					service = providedService;
				},
			},
			tools: {
				definitions: () => [activeTool],
				active: () => [activeTool.name],
			},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;
		hookContextUsage(pi);

		const ctx = {
			model: { contextWindow: 1000 },
			sessionManager: {
				getBranch: () => [messageEntry(userMessage("u".repeat(40)))],
			},
		} as unknown as ExtensionContext;
		const preparedPrompt = "x".repeat(400);
		const expectedTokens = 100 + estimateToolSchemaTokens([activeTool]) + 10;

		handlers.get("before_agent_start")?.[0]?.({ systemPrompt: preparedPrompt }, ctx);

		expect(service?.get()).toMatchObject({
			tokens: expectedTokens,
			contextWindow: 1000,
			percent: (expectedTokens / 1000) * 100,
		});
	});
});
