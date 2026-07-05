/**
 * Regression coverage for the AskUserQuestion resumability seam (agents-mission-control
 * parity-round2, design section B).
 *
 * Before this change, a session killed while a UI-only tool (e.g. AskUserQuestion) was
 * awaiting an answer would, on `pi --resume`, silently drop the pending question: the
 * generic orphaned-tool-call fallback (packages/ai/src/api/transform-messages.ts) fills an
 * unresolved tool_use with a synthetic "No result provided" error the next time a message
 * interrupts the transcript, and the model would proceed as if the user had answered nothing
 * (verified live: a fresh AskUserQuestion session killed mid-dialog and resumed responded
 * "No color selected. What would you like me to do?" instead of re-showing the dialog).
 *
 * `ToolDefinition.resumePendingCall` lets a tool opt in to being re-executed the moment a
 * session is loaded/resumed and its transcript ends on exactly one unresolved call for that
 * tool. All pending state lives in the persisted tool call itself (arguments), never in
 * extension-local memory or the cached system prefix.
 */
import type { AssistantMessage } from "@valkyriweb/pi-ai";
import { fauxAssistantMessage } from "@valkyriweb/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts } from "../harness.ts";

function pendingAssistantToolCall(
	model: { provider: string; id: string },
	toolName: string,
	toolCallId: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("resumability: pending interactive tool call re-presents on resume", () => {
	it("re-executes and continues when the tool opts in via resumePendingCall", async () => {
		let executeCalls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "TestAskUser",
						label: "Ask",
						description: "test ask-user tool",
						parameters: Type.Object({}),
						resumePendingCall: true,
						execute: async () => {
							executeCalls += 1;
							return { content: [{ type: "text", text: "Blue" }] };
						},
					});
				},
			],
			initialActiveToolNames: ["TestAskUser"],
		});
		try {
			await harness.session.bindExtensions({});
			harness.setResponses([fauxAssistantMessage("Got it: Blue")]);

			// Simulate a session killed mid-dialog: the transcript's last message is
			// an assistant turn with an unresolved TestAskUser call, and execute() has
			// never run (no tool_result exists for it yet) - exactly the shape a
			// resumed `pi --resume` session loads from disk.
			harness.session.agent.state.messages = [pendingAssistantToolCall(harness.getModel(), "TestAskUser", "call_1")];

			const resumed = await harness.session.resumePendingInteractiveToolCall();
			expect(resumed).toBe(true);
			expect(executeCalls).toBe(1);

			await harness.session.agent.waitForIdle();

			expect(harness.session.messages.map((message) => message.role)).toEqual([
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(getAssistantTexts(harness)).toContain("Got it: Blue");
		} finally {
			harness.cleanup();
		}
	});

	it("leaves non-opted-in tools alone (default behavior is unchanged)", async () => {
		let executeCalls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "bash-like",
						label: "Bash-like",
						description: "a stand-in for a side-effecting tool that must never auto-replay",
						parameters: Type.Object({}),
						execute: async () => {
							executeCalls += 1;
							return { content: [{ type: "text", text: "ran" }] };
						},
					});
				},
			],
			initialActiveToolNames: ["bash-like"],
		});
		try {
			await harness.session.bindExtensions({});
			harness.session.agent.state.messages = [pendingAssistantToolCall(harness.getModel(), "bash-like", "call_1")];

			const resumed = await harness.session.resumePendingInteractiveToolCall();
			expect(resumed).toBe(false);
			expect(executeCalls).toBe(0);
			// Message stays exactly as loaded - nothing was appended or executed.
			expect(harness.session.messages).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("no-ops when the transcript does not end on a lone pending tool call", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "TestAskUser",
						label: "Ask",
						description: "test ask-user tool",
						parameters: Type.Object({}),
						resumePendingCall: true,
						execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
					});
				},
			],
			initialActiveToolNames: ["TestAskUser"],
		});
		try {
			await harness.session.bindExtensions({});

			// A normal (non-crashed) transcript ending on a user message.
			harness.session.agent.state.messages = [{ role: "user", content: "hello", timestamp: Date.now() }];
			await expect(harness.session.resumePendingInteractiveToolCall()).resolves.toBe(false);

			// Two pending tool calls in the same assistant turn: ambiguous, so leave
			// it to the existing fallback rather than guessing an execution order.
			const twoCalls = pendingAssistantToolCall(harness.getModel(), "TestAskUser", "call_1");
			twoCalls.content.push({ type: "toolCall", id: "call_2", name: "TestAskUser", arguments: {} });
			harness.session.agent.state.messages = [twoCalls];
			await expect(harness.session.resumePendingInteractiveToolCall()).resolves.toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
