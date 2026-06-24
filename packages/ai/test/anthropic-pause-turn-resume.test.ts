import type Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, ThinkingContent } from "../src/types.ts";
import { pickModel } from "./helpers/models.ts";

/**
 * Verifies the `pause_turn` resume loop in `streamAnthropic`. The fix is
 * needed because Anthropic returns `stop_reason: "pause_turn"` mid-turn when a
 * long-running server-side tool (web_search / web_fetch / code_execution)
 * needs another turn to finish. The client MUST echo the partial assistant
 * message back unmodified to resume. Exposing pause_turn as a terminal stop
 * reason would let the agent loop persist the partial turn to the session
 * JSONL; any byte-level drift in a thinking signature on replay then triggers
 *   "messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
 *    latest assistant message cannot be modified"
 * and poisons every subsequent request, including compaction.
 * (#thinking-roundtrip)
 */

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const THINKING_SIGNATURE = "sig-from-anthropic-do-not-mutate";
const THINKING_TEXT = "Considering the web search results...";

function partialThinkingTurn(stopReason: "pause_turn" | "end_turn"): Array<{ event: string; data: string }> {
	return [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_pause_test",
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: THINKING_TEXT },
			}),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: THINKING_SIGNATURE },
			}),
		},
		{
			event: "content_block_stop",
			data: JSON.stringify({ type: "content_block_stop", index: 0 }),
		},
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: stopReason },
				usage: {
					input_tokens: 10,
					output_tokens: 8,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

function continuationTextTurn(text: string): Array<{ event: string; data: string }> {
	return [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_continuation",
					usage: {
						input_tokens: 20,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			}),
		},
		{
			event: "content_block_stop",
			data: JSON.stringify({ type: "content_block_stop", index: 0 }),
		},
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 20,
					output_tokens: 4,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

interface ScriptedCall {
	response: Response;
	params: MessageCreateParamsStreaming;
}

function createScriptedAnthropicClient(responses: Response[]): { client: Anthropic; calls: ScriptedCall[] } {
	const remaining = [...responses];
	const calls: ScriptedCall[] = [];
	const client = {
		messages: {
			create: (params: MessageCreateParamsStreaming) => {
				const response = remaining.shift();
				if (!response) {
					throw new Error(`scripted client exhausted; got ${calls.length + 1} requests`);
				}
				calls.push({ response, params });
				return {
					asResponse: async () => response,
				};
			},
		},
	} as unknown as Anthropic;
	return { client, calls };
}

describe("Anthropic pause_turn resume", () => {
	const model = pickModel("anthropic");
	const baseContext: Context = {
		messages: [
			{
				role: "user",
				content: "Search the web for X and answer.",
				timestamp: Date.now(),
			},
		],
	};

	it("resumes the assistant turn in-stream on pause_turn and exposes a single completed turn", async () => {
		const { client, calls } = createScriptedAnthropicClient([
			createSseResponse(partialThinkingTurn("pause_turn")),
			createSseResponse(continuationTextTurn("Answer: 42.")),
		]);

		const stream = streamAnthropic(model, baseContext, { client });
		const result = await stream.result();

		expect(result.errorMessage).toBeUndefined();
		// pause_turn must NOT leak to the caller; the loop resolves to the
		// continuation's terminal reason.
		expect(result.stopReason).toBe("stop");

		// Both calls happened: initial + one resume.
		expect(calls).toHaveLength(2);

		// The continuation request must echo the partial assistant turn as the
		// latest message, with the signed thinking block preserved.
		const continuationParams = calls[1]!.params;
		const messages = continuationParams.messages;
		expect(messages).toHaveLength(2);
		const lastMessage = messages[1]!;
		expect(lastMessage.role).toBe("assistant");
		const content = lastMessage.content;
		expect(Array.isArray(content)).toBe(true);
		const blocks = content as Array<{ type: string; thinking?: string; signature?: string }>;
		const thinkingBlock = blocks.find((b) => b.type === "thinking");
		expect(thinkingBlock).toBeDefined();
		// Byte-for-byte preservation is the whole point of the fix.
		expect(thinkingBlock!.thinking).toBe(THINKING_TEXT);
		expect(thinkingBlock!.signature).toBe(THINKING_SIGNATURE);

		// Final assistant message contains both the thinking from turn 1 and the
		// text from the continuation.
		const finalThinking = result.content.find((b): b is ThinkingContent => b.type === "thinking");
		expect(finalThinking?.thinking).toBe(THINKING_TEXT);
		expect(finalThinking?.thinkingSignature).toBe(THINKING_SIGNATURE);
		const finalText = result.content.find((b) => b.type === "text");
		expect(finalText && "text" in finalText ? finalText.text : undefined).toBe("Answer: 42.");

		// Cost accounting: each Anthropic API call reports usage for that call
		// only. The resume loop must accumulate, not overwrite, or pause_turn
		// turns silently undercount tokens. Call 1: input=10, output=8.
		// Continuation: input=20, output=4. Cumulative = 30/12.
		expect(result.usage.input).toBe(30);
		expect(result.usage.output).toBe(12);
		expect(result.usage.cacheRead).toBe(0);
		expect(result.usage.cacheWrite).toBe(0);
		expect(result.usage.totalTokens).toBe(42);
	});

	it("accumulates usage across multiple pause_turn resumes", async () => {
		// 3 partial turns + 1 final continuation.
		// Each partial turn reports input=10, output=8 (from partialThinkingTurn).
		// Continuation reports input=20, output=4 (from continuationTextTurn).
		// Cumulative: input = 10+10+10+20 = 50, output = 8+8+8+4 = 28.
		const { client } = createScriptedAnthropicClient([
			createSseResponse(partialThinkingTurn("pause_turn")),
			createSseResponse(partialThinkingTurn("pause_turn")),
			createSseResponse(partialThinkingTurn("pause_turn")),
			createSseResponse(continuationTextTurn("Done.")),
		]);

		const stream = streamAnthropic(model, baseContext, { client });
		const result = await stream.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(50);
		expect(result.usage.output).toBe(28);
		expect(result.usage.totalTokens).toBe(78);
	});

	it("loops through multiple pause_turn responses before terminating", async () => {
		const { client, calls } = createScriptedAnthropicClient([
			createSseResponse(partialThinkingTurn("pause_turn")),
			createSseResponse(partialThinkingTurn("pause_turn")),
			createSseResponse(partialThinkingTurn("pause_turn")),
			createSseResponse(continuationTextTurn("Done.")),
		]);

		const stream = streamAnthropic(model, baseContext, { client });
		const result = await stream.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(calls).toHaveLength(4);

		// Each resume request must include the growing partial assistant turn as
		// the trailing message — never strip it, never reshape it.
		for (let i = 1; i < calls.length; i++) {
			const msgs = calls[i]!.params.messages;
			expect(msgs.length).toBeGreaterThanOrEqual(2);
			expect(msgs[msgs.length - 1]!.role).toBe("assistant");
		}
	});

	it("aborts with a clear error when the pause_turn resume limit is exceeded", async () => {
		// Provide 32 pause_turn responses (well past the limit of 16) so the
		// loop trips the cap.
		const responses: Response[] = [];
		for (let i = 0; i < 32; i++) {
			responses.push(createSseResponse(partialThinkingTurn("pause_turn")));
		}
		const { client } = createScriptedAnthropicClient(responses);

		const stream = streamAnthropic(model, baseContext, { client });
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/pause_turn resume limit/);
	});
});
