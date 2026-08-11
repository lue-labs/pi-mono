import type { AgentMessage } from "@valkyriweb/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@valkyriweb/pi-ai";
import { describe, expect, it } from "vitest";
import { reconcileUnsettledToolCalls, UNSETTLED_TOOL_CALL_TEXT } from "../src/core/messages.ts";

function assistantWithToolCalls(...ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.md` } })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 7,
	};
}

function toolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "contents" }],
		isError: false,
		timestamp: 8,
	};
}

const userMessage: AgentMessage = { role: "user", content: "go", timestamp: 0 };

describe("reconcileUnsettledToolCalls", () => {
	it("settles a tool call the history left without an outcome", () => {
		const messages: AgentMessage[] = [userMessage, assistantWithToolCalls("a")];

		const reconciled = reconcileUnsettledToolCalls(messages);

		expect(reconciled).toHaveLength(3);
		expect(reconciled[2]).toEqual({
			role: "toolResult",
			toolCallId: "a",
			toolName: "read",
			content: [{ type: "text", text: UNSETTLED_TOOL_CALL_TEXT }],
			isError: true,
			timestamp: 7,
		});
	});

	it("returns the same array when every tool call is already settled", () => {
		const messages: AgentMessage[] = [userMessage, assistantWithToolCalls("a"), toolResult("a")];

		expect(reconcileUnsettledToolCalls(messages)).toBe(messages);
	});

	it("settles only the open call of a partially recorded batch", () => {
		const messages: AgentMessage[] = [userMessage, assistantWithToolCalls("a", "b"), toolResult("a")];

		const reconciled = reconcileUnsettledToolCalls(messages);

		expect(reconciled).toHaveLength(4);
		expect(reconciled[2]).toBe(messages[2]);
		expect(reconciled[3]).toMatchObject({ toolCallId: "b", isError: true });
	});

	it("settles a call the next turn started without", () => {
		const messages: AgentMessage[] = [userMessage, assistantWithToolCalls("a"), userMessage];

		const reconciled = reconcileUnsettledToolCalls(messages);

		expect(reconciled.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(reconciled[2]).toMatchObject({ toolCallId: "a", isError: true });
	});

	it("leaves a history without tool calls untouched", () => {
		const messages: AgentMessage[] = [userMessage];

		expect(reconcileUnsettledToolCalls(messages)).toBe(messages);
	});
});
