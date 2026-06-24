import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Message, Model } from "../src/types.ts";

// A session poisoned by a drifted thinking signature gets a 400 on every
// request ("thinking ... in the latest assistant message cannot be modified").
// streamAnthropic must recover by retrying once with thinking blocks stripped.

let server: Server;
let port: number;
const requestBodies: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
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

function poisonedContext(): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "drifted reasoning", thinkingSignature: "stale-signature" },
			{ type: "text", text: "partial answer" },
		],
		provider: "claude-bridge",
		api: "anthropic-messages",
		model: "claude-opus-4-8",
		timestamp: Date.now(),
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
	const messages: Message[] = [
		{ role: "user", content: "hello", timestamp: Date.now() },
		assistant,
		{ role: "user", content: "continue", timestamp: Date.now() },
	];
	return { messages };
}

describe("Anthropic thinking-modified 400 recovery (#thinking-roundtrip)", () => {
	it("retries once with thinking blocks stripped and succeeds", async () => {
		const stream = streamSimple(makeModel(), poisonedContext(), { apiKey: "k" });
		const message = await stream.result();

		// Recovered: a completed assistant turn, not a thrown error.
		expect(message.stopReason).toBe("stop");

		// Two requests: the original (with thinking) and the stripped retry.
		expect(requestBodies).toHaveLength(2);
		const firstAssistant = requestBodies[0].messages?.find((m) => m.role === "assistant");
		const retryAssistant = requestBodies[1].messages?.find((m) => m.role === "assistant");
		const types = (m: { content: unknown } | undefined) =>
			Array.isArray(m?.content) ? (m!.content as Array<{ type: string }>).map((b) => b.type) : [];

		expect(types(firstAssistant)).toContain("thinking");
		expect(types(retryAssistant)).not.toContain("thinking");
		expect(types(retryAssistant)).toContain("text");
	});
});
