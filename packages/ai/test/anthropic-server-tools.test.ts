import type Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { AssistantMessageEvent, Context } from "../src/types.ts";
import { pickModel } from "./helpers/models.ts";

/**
 * Provider-executed (server-side) web tools — Anthropic native `web_search` /
 * `web_fetch` — arrive as `server_tool_use` + `web_search_tool_result` /
 * `web_fetch_tool_result` content blocks rather than ordinary `tool_use` blocks.
 * The parser must surface them as display-only `server_tool_use` /
 * `server_tool_result` stream events WITHOUT ever pushing them into
 * `AssistantMessage.content` (otherwise the agent loop would try to execute
 * them locally and they would round-trip to the API). See the activity-card
 * rendering in the interactive TUI and `docs/pi-fork-patch-inventory.md`.
 */

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createScriptedAnthropicClient(response: Response): {
	client: Anthropic;
	calls: MessageCreateParamsStreaming[];
} {
	const calls: MessageCreateParamsStreaming[] = [];
	const client = {
		messages: {
			create: (params: MessageCreateParamsStreaming) => {
				calls.push(params);
				return { asResponse: async () => response };
			},
		},
	} as unknown as Anthropic;
	return { client, calls };
}

function sse(type: string, extra: Record<string, unknown>): { event: string; data: string } {
	return { event: type, data: JSON.stringify({ type, ...extra }) };
}

const MESSAGE_START = sse("message_start", {
	message: {
		id: "msg_server_tool",
		usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
});

const TEXT_TURN = [
	sse("content_block_start", { index: 2, content_block: { type: "text", text: "" } }),
	sse("content_block_delta", { index: 2, delta: { type: "text_delta", text: "Here is what I found." } }),
	sse("content_block_stop", { index: 2 }),
	sse("message_delta", {
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	}),
	sse("message_stop", {}),
];

const baseContext: Context = {
	messages: [{ role: "user", content: "Search the web for X.", timestamp: Date.now() }],
};

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("Anthropic server tools (web_search / web_fetch)", () => {
	const model = pickModel("anthropic");

	it("emits server_tool_use + server_tool_result events and keeps them out of content", async () => {
		const { client } = createScriptedAnthropicClient(
			createSseResponse([
				MESSAGE_START,
				sse("content_block_start", {
					index: 0,
					content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
				}),
				sse("content_block_delta", {
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"query":"anthropic web search docs"}' },
				}),
				sse("content_block_stop", { index: 0 }),
				sse("content_block_start", {
					index: 1,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_1",
						content: [
							{
								type: "web_search_result",
								title: "Anthropic Docs",
								url: "https://docs.anthropic.com",
								page_age: null,
								encrypted_content: "a",
							},
							{
								type: "web_search_result",
								title: "Web search tool",
								url: "https://example.com/ws",
								page_age: null,
								encrypted_content: "b",
							},
						],
					},
				}),
				sse("content_block_stop", { index: 1 }),
				...TEXT_TURN,
			]),
		);

		const stream = streamAnthropic(model, baseContext, { client });
		const events = await collectEvents(stream);
		const result = await stream.result();

		const use = events.find((e) => e.type === "server_tool_use");
		expect(use).toBeDefined();
		expect(use).toMatchObject({ id: "srvtoolu_1", toolName: "web_search", query: "anthropic web search docs" });

		const toolResult = events.find((e) => e.type === "server_tool_result");
		expect(toolResult).toBeDefined();
		if (toolResult?.type !== "server_tool_result") throw new Error("expected server_tool_result");
		expect(toolResult.toolUseId).toBe("srvtoolu_1");
		expect(toolResult.status).toBe("completed");
		expect(toolResult.sources).toEqual([
			{ title: "Anthropic Docs", url: "https://docs.anthropic.com" },
			{ title: "Web search tool", url: "https://example.com/ws" },
		]);

		// Critical: server tools must never enter content (no local execution, no round-trip).
		expect(result.content.some((b) => b.type === "toolCall")).toBe(false);
		expect(result.content.filter((b) => b.type === "text")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
	});

	it("surfaces a server_tool_result error without polluting content", async () => {
		const { client } = createScriptedAnthropicClient(
			createSseResponse([
				MESSAGE_START,
				sse("content_block_start", {
					index: 0,
					content_block: { type: "server_tool_use", id: "srvtoolu_err", name: "web_search", input: {} },
				}),
				sse("content_block_delta", {
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"query":"rate limited"}' },
				}),
				sse("content_block_stop", { index: 0 }),
				sse("content_block_start", {
					index: 1,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_err",
						content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
					},
				}),
				sse("content_block_stop", { index: 1 }),
				...TEXT_TURN,
			]),
		);

		const stream = streamAnthropic(model, baseContext, { client });
		const events = await collectEvents(stream);
		const result = await stream.result();

		const toolResult = events.find((e) => e.type === "server_tool_result");
		if (toolResult?.type !== "server_tool_result") throw new Error("expected server_tool_result");
		expect(toolResult.status).toBe("error");
		expect(toolResult.errorCode).toBe("max_uses_exceeded");
		expect(result.content.some((b) => b.type === "toolCall")).toBe(false);
	});

	it("maps advisor_tool_result errors to the advisor tool name", async () => {
		const { client } = createScriptedAnthropicClient(
			createSseResponse([
				MESSAGE_START,
				sse("content_block_start", {
					index: 0,
					content_block: { type: "server_tool_use", id: "srvtoolu_adv", name: "advisor", input: {} },
				}),
				sse("content_block_stop", { index: 0 }),
				sse("content_block_start", {
					index: 1,
					content_block: {
						type: "advisor_tool_result",
						tool_use_id: "srvtoolu_adv",
						content: { type: "advisor_tool_result_error", error_code: "unavailable" },
					},
				}),
				sse("content_block_stop", { index: 1 }),
				...TEXT_TURN,
			]),
		);

		const stream = streamAnthropic(model, baseContext, { client });
		const events = await collectEvents(stream);
		const result = await stream.result();

		const use = events.find((e) => e.type === "server_tool_use");
		expect(use).toMatchObject({ id: "srvtoolu_adv", toolName: "advisor" });

		const toolResult = events.find((e) => e.type === "server_tool_result");
		if (toolResult?.type !== "server_tool_result") throw new Error("expected server_tool_result");
		expect(toolResult.toolName).toBe("advisor");
		expect(toolResult.status).toBe("error");
		expect(toolResult.errorCode).toBe("unavailable");
		expect(result.content.some((b) => b.type === "toolCall")).toBe(false);
	});

	it("treats web_fetch_tool_result as a web_fetch activity", async () => {
		const { client } = createScriptedAnthropicClient(
			createSseResponse([
				MESSAGE_START,
				sse("content_block_start", {
					index: 0,
					content_block: { type: "server_tool_use", id: "srvtoolu_fetch", name: "web_fetch", input: {} },
				}),
				sse("content_block_delta", {
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"url":"https://docs.anthropic.com/x"}' },
				}),
				sse("content_block_stop", { index: 0 }),
				sse("content_block_start", {
					index: 1,
					content_block: {
						type: "web_fetch_tool_result",
						tool_use_id: "srvtoolu_fetch",
						content: { type: "web_fetch_result", url: "https://docs.anthropic.com/x" },
					},
				}),
				sse("content_block_stop", { index: 1 }),
				...TEXT_TURN,
			]),
		);

		const stream = streamAnthropic(model, baseContext, { client });
		const events = await collectEvents(stream);
		const result = await stream.result();

		const use = events.find((e) => e.type === "server_tool_use");
		expect(use).toMatchObject({ toolName: "web_fetch", url: "https://docs.anthropic.com/x" });
		const toolResult = events.find((e) => e.type === "server_tool_result");
		if (toolResult?.type !== "server_tool_result") throw new Error("expected server_tool_result");
		expect(toolResult.toolName).toBe("web_fetch");
		expect(toolResult.sources).toEqual([{ url: "https://docs.anthropic.com/x" }]);
		expect(result.content.some((b) => b.type === "toolCall")).toBe(false);
	});
});
