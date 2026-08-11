import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";
import { stripStaleThinkingFromMessageParams } from "../src/api/anthropic-thinking-recovery.ts";

// Anthropic discards thinking blocks from assistant turns older than the last
// real user turn. Replaying them makes our bytes diverge from the history it
// keeps, so every user turn rewrites the whole transcript after the
// tools+system anchor. These tests pin the strip that keeps the prefix stable.

const thinking = (text: string): ContentBlockParam =>
	({ type: "thinking", thinking: text, signature: `sig-${text}` }) as ContentBlockParam;

const assistant = (blocks: ContentBlockParam[]): MessageParam => ({ role: "assistant", content: blocks });
const user = (text: string): MessageParam => ({ role: "user", content: [{ type: "text", text }] });
const toolResult = (id: string): MessageParam => ({
	role: "user",
	content: [{ type: "tool_result", tool_use_id: id, content: "done" }],
});

describe("stripStaleThinkingFromMessageParams", () => {
	it("drops thinking blocks before the last real user turn and keeps the rest", () => {
		const result = stripStaleThinkingFromMessageParams([
			user("first"),
			assistant([thinking("old"), { type: "text", text: "a" }]),
			user("second"),
			assistant([thinking("current"), { type: "text", text: "b" }]),
		]);

		expect(result[1].content).toEqual([{ type: "text", text: "a" }]);
		expect(result[3].content).toEqual([thinking("current"), { type: "text", text: "b" }]);
	});

	it("treats tool results as part of the loop, not as a boundary", () => {
		const messages = [
			user("go"),
			assistant([thinking("plan"), { type: "tool_use", id: "t1", name: "read", input: {} }]),
			toolResult("t1"),
			assistant([thinking("more"), { type: "text", text: "done" }]),
		] as MessageParam[];

		// Everything follows the single real user turn, so nothing is stripped.
		expect(stripStaleThinkingFromMessageParams(messages)).toEqual(messages);
	});

	it("keeps redacted thinking under the same rule", () => {
		const redacted = { type: "redacted_thinking", data: "opaque" } as ContentBlockParam;
		const result = stripStaleThinkingFromMessageParams([
			user("first"),
			assistant([redacted, { type: "text", text: "a" }]),
			user("second"),
			assistant([redacted]),
		]);

		expect(result[1].content).toEqual([{ type: "text", text: "a" }]);
		expect(result[3].content).toEqual([redacted]);
	});

	it("leaves empty-signature thinking alone for compat providers", () => {
		const unsigned = { type: "thinking", thinking: "trace", signature: "" } as ContentBlockParam;
		const messages = [user("first"), assistant([unsigned]), user("second")] as MessageParam[];

		// These providers never signed the block and never discard history, so
		// replaying it costs nothing and dropping it would lose their reasoning.
		expect(stripStaleThinkingFromMessageParams(messages)).toEqual(messages);
	});

	it("drops an assistant message left with no content", () => {
		const result = stripStaleThinkingFromMessageParams([
			user("first"),
			assistant([thinking("only")]),
			user("second"),
		]);

		expect(result).toEqual([user("first"), user("second")]);
	});

	it("leaves a history with no real user boundary untouched", () => {
		const messages = [assistant([thinking("a"), { type: "text", text: "x" }])] as MessageParam[];
		expect(stripStaleThinkingFromMessageParams(messages)).toEqual(messages);
	});

	it("keeps the prefix byte-stable as the conversation grows", () => {
		const turnOne: MessageParam[] = [
			user("first"),
			assistant([thinking("old"), { type: "text", text: "a" }]),
			user("second"),
			assistant([thinking("current"), { type: "text", text: "b" }]),
		];
		const turnTwo: MessageParam[] = [...turnOne, user("third"), assistant([thinking("newest")])];

		const prefixOne = JSON.stringify(stripStaleThinkingFromMessageParams(turnOne).slice(0, 3));
		const prefixTwo = JSON.stringify(stripStaleThinkingFromMessageParams(turnTwo).slice(0, 3));

		// The bytes before the previous boundary must not move when a new turn
		// arrives; only the most recent loop may be rewritten.
		expect(prefixTwo).toBe(prefixOne);
	});
});
