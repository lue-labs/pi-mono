import { createServer, type Server } from "node:http";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLatestThinkingModifiedError } from "../src/api/anthropic-thinking-recovery.ts";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Message, Model, Tool } from "../src/types.ts";

interface RequestBody {
	messages?: Array<{ role: string; content: unknown }>;
	system?: unknown;
	tools?: unknown;
}

let server: Server;
let port: number;
const requestBodies: RequestBody[] = [];
let failFirst = true;

const SSE_OK = [
	`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
	`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
	`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
	`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
	`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

beforeEach(async () => {
	requestBodies.length = 0;
	failFirst = true;
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			requestBodies.push(JSON.parse(raw || "{}"));
			if (failFirst) {
				failFirst = false;
				res.writeHead(400, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message:
								"messages.2.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
						},
					}),
				);
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(SSE_OK);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as { port: number }).port;
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Opus",
		api: "anthropic-messages",
		provider: "claude-bridge",
		baseUrl: `http://127.0.0.1:${port}`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 1024,
	};
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		provider: "claude-bridge",
		api: "anthropic-messages",
		model: "claude-opus-4-8",
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
	};
}

function poisonedContext(
	latestContent: AssistantMessage["content"] = [
		{ type: "thinking", thinking: "malformed latest reasoning", thinkingSignature: "stale-signature" },
		{
			type: "thinking",
			thinking: "[Reasoning redacted]",
			thinkingSignature: "stale-redacted-payload",
			redacted: true,
		},
		{ type: "text", text: "latest answer" },
	],
): Context {
	const tools: Tool[] = [
		{
			name: "lookup",
			description: "Look up a value",
			parameters: Type.Object({ value: Type.String() }),
		},
	];
	const messages: Message[] = [
		{ role: "user", content: "first", timestamp: 1 },
		assistantMessage([
			{ type: "thinking", thinking: "older signed reasoning", thinkingSignature: "older-signature" },
			{
				type: "thinking",
				thinking: "[Reasoning redacted]",
				thinkingSignature: "older-redacted-payload",
				redacted: true,
			},
			{ type: "text", text: "older answer" },
			{ type: "toolCall", id: "call_1", name: "lookup", arguments: { value: "x" } },
		]),
		// A tool result, not a user turn, separates the two assistant turns.
		// Thinking older than the last real user turn never reaches the API now,
		// so a plain user message here would strip the poisoned block before the
		// request and the 400 under test could not happen. Anthropic keeps
		// thinking across a tool result, so this shape still exercises recovery
		// preserving earlier signed reasoning.
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "lookup",
			content: [{ type: "text", text: "looked up" }],
			isError: false,
			timestamp: 2,
		},
		assistantMessage(latestContent),
	];
	return { systemPrompt: "Stable system prompt", messages, tools };
}

describe("Anthropic thinking-modified 400 recovery (#thinking-roundtrip)", () => {
	it("strips only the latest assistant thinking blocks and preserves the cached prefix", async () => {
		const stream = streamSimple(makeModel(), poisonedContext(), { apiKey: "k" });
		const message = await stream.result();

		expect(message.stopReason).toBe("stop");
		expect(requestBodies).toHaveLength(2);

		const originalAssistants = requestBodies[0].messages?.filter((entry) => entry.role === "assistant") ?? [];
		const retryAssistants = requestBodies[1].messages?.filter((entry) => entry.role === "assistant") ?? [];
		expect(retryAssistants).toHaveLength(2);
		expect(retryAssistants[0]).toEqual(originalAssistants[0]);
		expect(retryAssistants[1].content).toEqual([{ type: "text", text: "latest answer" }]);
		expect(JSON.stringify(requestBodies[1].system)).toBe(JSON.stringify(requestBodies[0].system));
		expect(JSON.stringify(requestBodies[1].tools)).toBe(JSON.stringify(requestBodies[0].tools));
		expect(message.diagnostics).toEqual([
			expect.objectContaining({
				type: "anthropic_latest_thinking_recovery",
				details: expect.objectContaining({
					lostAssistantTurns: 1,
					removedThinkingBlocks: 2,
				}),
			}),
		]);
	});

	it("strips thinking from every message in the final contiguous assistant turn", async () => {
		const context = poisonedContext([
			{ type: "thinking", thinking: "malformed split reasoning", thinkingSignature: "stale-signature" },
			{ type: "text", text: "first latest segment" },
		]);
		// The poisoned assistant is now the last message, so the second segment of
		// the final contiguous assistant turn is appended after it.
		context.messages.push(assistantMessage([{ type: "text", text: "last latest segment" }]));

		const stream = streamSimple(makeModel(), context, { apiKey: "k" });
		const message = await stream.result();

		expect(message.stopReason).toBe("stop");
		expect(requestBodies).toHaveLength(2);
		const originalAssistants = requestBodies[0].messages?.filter((entry) => entry.role === "assistant") ?? [];
		const retryAssistants = requestBodies[1].messages?.filter((entry) => entry.role === "assistant") ?? [];
		expect(retryAssistants).toEqual([
			originalAssistants[0],
			{ role: "assistant", content: [{ type: "text", text: "first latest segment" }] },
			originalAssistants[2],
		]);
		expect(message.diagnostics?.[0]?.details).toMatchObject({
			lostAssistantTurns: 1,
			removedThinkingBlocks: 1,
			removedAssistantMessage: false,
		});
	});

	it("drops a latest assistant message left empty by recovery", async () => {
		const stream = streamSimple(
			makeModel(),
			poisonedContext([
				{ type: "thinking", thinking: "malformed latest reasoning", thinkingSignature: "stale-signature" },
				{
					type: "thinking",
					thinking: "[Reasoning redacted]",
					thinkingSignature: "stale-redacted-payload",
					redacted: true,
				},
			]),
			{ apiKey: "k" },
		);
		const message = await stream.result();

		expect(message.stopReason).toBe("stop");
		const originalAssistants = requestBodies[0].messages?.filter((entry) => entry.role === "assistant") ?? [];
		const retryAssistants = requestBodies[1].messages?.filter((entry) => entry.role === "assistant") ?? [];
		expect(retryAssistants).toEqual([originalAssistants[0]]);
		expect(message.diagnostics?.[0]?.details).toMatchObject({
			lostAssistantTurns: 1,
			removedThinkingBlocks: 2,
			removedAssistantMessage: true,
		});
	});

	it("does not retry errors that only resemble Anthropic's signature-mutation 400", () => {
		expect(
			isLatestThinkingModifiedError(new Error("thinking blocks in the latest assistant message cannot be modified")),
		).toBe(false);
		for (const message of [
			"thinking blocks in the latest assistant message must come first",
			"thinking configuration on the latest assistant message cannot be modified",
		]) {
			expect(isLatestThinkingModifiedError(Object.assign(new Error(message), { status: 400 }))).toBe(false);
		}
	});
});
