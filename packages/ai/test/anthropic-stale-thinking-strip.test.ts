import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";
import {
	anthropicKeepsPriorTurnThinking,
	stripStaleThinkingFromMessageParams,
} from "../src/api/anthropic-thinking-recovery.ts";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

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

	it("keeps a completed tool call intact when its thinking goes stale", () => {
		// A stale assistant turn usually still carries the tool_use that its
		// tool_result answers. Dropping that block would orphan the result.
		const result = stripStaleThinkingFromMessageParams([
			user("first"),
			assistant([thinking("plan"), { type: "tool_use", id: "t1", name: "read", input: { path: "a" } }]),
			toolResult("t1"),
			assistant([{ type: "text", text: "a" }]),
			user("second"),
			assistant([thinking("current"), { type: "text", text: "b" }]),
		]);

		expect(result[1].content).toEqual([{ type: "tool_use", id: "t1", name: "read", input: { path: "a" } }]);
		expect(result[2]).toEqual(toolResult("t1"));
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

// Anthropic's thinking docs split models into "keep all prior turns" (Opus
// 4.5+, Sonnet 4.6+, Fable, Mythos) and "keep the last turn only" (earlier
// Opus/Sonnet, all Haiku through 4.5). The strip above is only correct for the
// latter: on a keep-all model prior thinking stays in Anthropic's cached
// context, so dropping it client-side rewrites the transcript at every real
// user turn.
describe("anthropicKeepsPriorTurnThinking", () => {
	it.each([
		"claude-fable-5-1",
		"claude-fable-5-1-200k",
		"claude-fable-5",
		"claude-mythos-5-1",
		"claude-mythos-preview",
		"claude-opus-4-5",
		"claude-opus-4-5-20251101",
		"claude-opus-4-7",
		"claude-opus-4-8",
		"claude-sonnet-4-6",
		"claude-sonnet-5",
		"claude-haiku-4-6",
		"anthropic.claude-opus-4-5-20251101-v1:0",
		"claude-opus-4-5@20251101",
		"mimo-v2.5-pro",
	])("keeps prior-turn thinking on %s", (id) => {
		expect(anthropicKeepsPriorTurnThinking(id)).toBe(true);
	});

	it.each([
		"claude-haiku-4-5",
		"claude-haiku-4-5-20251001",
		"claude-sonnet-4-5",
		"claude-sonnet-4-5-20250929",
		"claude-sonnet-4-20250514",
		"claude-opus-4-1",
		"claude-opus-4-20250514",
		"claude-3-7-sonnet-latest",
		"claude-3-5-haiku-20241022",
		"claude-3-opus-20240229",
		"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
	])("strips prior-turn thinking on %s", (id) => {
		expect(anthropicKeepsPriorTurnThinking(id)).toBe(false);
	});
});

describe("stale thinking strip is gated per model in the request payload", () => {
	interface AnthropicPayload {
		messages?: Array<{ role: string; content: Array<{ type: string; thinking?: string }> }>;
	}

	const makeModel = (id: string): Model<"anthropic-messages"> => ({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 1024,
	});

	const signedAssistant = (modelId: string, text: string): AssistantMessage => ({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: text, thinkingSignature: `sig-${text}` },
			{ type: "text", text: `said ${text}` },
		],
		provider: "anthropic",
		api: "anthropic-messages",
		model: modelId,
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	});

	// Two real user turns: the first assistant turn's thinking is older than the
	// last user boundary, which is exactly the block the strip targets.
	const makeContext = (modelId: string): Context => ({
		messages: [
			{ role: "user", content: "first", timestamp: 0 },
			signedAssistant(modelId, "old"),
			{ role: "user", content: "second", timestamp: 2 },
			signedAssistant(modelId, "current"),
		],
	});

	async function capturePayload(modelId: string): Promise<AnthropicPayload> {
		let captured: AnthropicPayload | undefined;
		const stream = streamSimple(makeModel(modelId), makeContext(modelId), {
			apiKey: "fake-key",
			onPayload: (payload) => {
				captured = payload as AnthropicPayload;
				throw new Error("payload captured");
			},
		});
		await stream.result();
		if (!captured) throw new Error("Expected payload capture before request");
		return captured;
	}

	const firstAssistantTypes = (payload: AnthropicPayload) =>
		payload.messages?.find((m) => m.role === "assistant")?.content.map((b) => b.type);

	it("replays prior-turn thinking on a keep-all model (claude-fable-5-1)", async () => {
		const payload = await capturePayload("claude-fable-5-1");
		expect(firstAssistantTypes(payload)).toEqual(["thinking", "text"]);
	});

	it("strips prior-turn thinking on a last-turn-only model (claude-haiku-4-5)", async () => {
		const payload = await capturePayload("claude-haiku-4-5");
		expect(firstAssistantTypes(payload)).toEqual(["text"]);
	});
});
