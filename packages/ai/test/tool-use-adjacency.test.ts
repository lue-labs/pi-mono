import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";
import { findToolUseAdjacencyViolations } from "../src/api/tool-use-adjacency.ts";

function assistantWithToolUse(...ids: string[]): MessageParam {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "tool_use" as const, id, name: "read", input: {} })),
	};
}

function toolResults(...ids: string[]): MessageParam {
	return {
		role: "user",
		content: ids.map((id) => ({ type: "tool_result" as const, tool_use_id: id, content: "contents" })),
	};
}

const userTurn: MessageParam = { role: "user", content: "go" };

describe("findToolUseAdjacencyViolations", () => {
	it("reports nothing when every tool_use is settled by the next message", () => {
		expect(findToolUseAdjacencyViolations([userTurn, assistantWithToolUse("a", "b"), toolResults("a", "b")])).toEqual(
			[],
		);
	});

	it("reports a tool_use the transcript never settles", () => {
		const messages = [userTurn, assistantWithToolUse("a"), userTurn];

		expect(findToolUseAdjacencyViolations(messages)).toEqual([
			{
				messageIndex: 1,
				toolUseId: "a",
				toolName: "read",
				followedBy: "user",
				followedByBlocks: ["text"],
				resultAtIndex: undefined,
				totalMessages: 3,
			},
		]);
	});

	it("reports where a displaced result landed", () => {
		// The result exists but not adjacent — the case the provider's error text
		// cannot be told apart from an outright missing result.
		const messages = [userTurn, assistantWithToolUse("a"), userTurn, toolResults("a")];

		expect(findToolUseAdjacencyViolations(messages)).toMatchObject([{ toolUseId: "a", resultAtIndex: 3 }]);
	});

	it("reports only the unsettled member of a partially settled batch", () => {
		const messages = [userTurn, assistantWithToolUse("a", "b"), toolResults("a")];

		expect(findToolUseAdjacencyViolations(messages)).toMatchObject([
			{ toolUseId: "b", followedBy: "user", followedByBlocks: ["tool_result"], resultAtIndex: undefined },
		]);
	});

	it("reports a tool_use left at the end of the transcript", () => {
		expect(findToolUseAdjacencyViolations([userTurn, assistantWithToolUse("a")])).toMatchObject([
			{ toolUseId: "a", followedBy: "(end of transcript)", followedByBlocks: [] },
		]);
	});
});
