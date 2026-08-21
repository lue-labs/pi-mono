import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
/**
 * Regression test: handler-extended system prompt must survive a mid-turn
 * setActiveTools on machine-driven (sendCustomMessage triggerTurn) turns.
 *
 * Bug: the triggerTurn path promoted a before_agent_start handler's
 * systemPrompt to _baseSystemPrompt but never set _systemPromptOverride
 * (unlike prompt()). A mid-turn deferred-tool activation then rebuilt the
 * prompt raw and shipped it on the continuation request — dropping the
 * handler content, mutating the stable system block bytes, and busting the
 * prompt cache down to the tools[] breakpoint on monitor-wake/goal turns
 * (valkyriweb/my-pi#1280 residual).
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@valkyriweb/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@valkyriweb/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { pickModel } from "./helpers/models.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const MARKER = "\n\nHANDLER-MARKER-BYTES";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("AgentSession triggerTurn system prompt stability", () => {
	let tempDir: string;
	let session: AgentSession;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-trigger-turn-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps handler-returned system prompt bytes across a mid-turn setActiveTools", async () => {
		const model = pickModel("anthropic");
		const systemPromptsSeen: string[] = [];
		let llmCall = 0;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, context) => {
				systemPromptsSeen.push(context.systemPrompt ?? "");
				const call = ++llmCall;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (call === 1) {
						const message = assistantMessage(
							[{ type: "toolCall", id: "toolu_1", name: "prompt_refresher", arguments: {} }],
							"toolUse",
						);
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "toolUse", message });
					} else {
						const message = assistantMessage([{ type: "text", text: "done" }], "stop");
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				// Decoy tool exists only so the refresher can shrink the active set,
				// forcing the mid-turn _rebuildSystemPrompt path.
				pi.registerTool({
					name: "decoy",
					label: "Decoy",
					description: "Unused decoy tool",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "noop" }], details: {} }),
				});
				pi.registerTool({
					name: "prompt_refresher",
					label: "Prompt Refresher",
					description: "Changes the active tool set mid-turn (tool_search stand-in)",
					parameters: Type.Object({}),
					execute: async () => {
						session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "decoy"));
						return { content: [{ type: "text", text: "refreshed" }], details: {} };
					},
				});
				// Stand-in for one-shot/per-turn extension system-prompt injections
				// (dream-memory profile, tool-search deferred index).
				pi.on("before_agent_start", (event) => {
					if (event.systemPrompt.includes(MARKER)) return undefined;
					return { systemPrompt: event.systemPrompt + MARKER };
				});
			},
		]);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		await session.bindExtensions({});

		// Machine-driven turn: monitor wakes / goal continuations use exactly this
		// delivery (sendCustomMessage with triggerTurn), not session.prompt().
		await session.sendCustomMessage(
			{ customType: "monitor-wake", content: [{ type: "text", text: "monitor fired" }], display: false },
			{ triggerTurn: true },
		);

		expect(llmCall).toBe(2);
		expect(systemPromptsSeen[0]).toContain(MARKER);
		// The continuation request after the mid-turn tool-set change must ship
		// byte-identical system prompt — losing the handler marker here is the
		// stable-block cache bust.
		expect(systemPromptsSeen[1]).toContain(MARKER);
		expect(systemPromptsSeen[1]).toBe(systemPromptsSeen[0]);
	});
});
