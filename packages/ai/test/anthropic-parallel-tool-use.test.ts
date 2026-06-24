import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Tool } from "../src/types.ts";
import { pickModel } from "./helpers/models.ts";

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createAnthropicResponse(): Response {
	const body =
		sse("message_start", {
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-test",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		}) +
		sse("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		}) +
		sse("message_stop", { type: "message_stop" });

	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("anthropic parallel tool use", () => {
	it("explicitly leaves parallel tool use enabled for Anthropic-compatible Pi paths", async () => {
		const baseModel = pickModel("anthropic");
		const model = { ...baseModel, provider: "claude-bridge" as const };
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({ ok: Type.Boolean() }),
			},
		];
		let payload: unknown;
		const client = {
			messages: {
				create: () => ({
					asResponse: async () => createAnthropicResponse(),
				}),
			},
		};

		await streamAnthropic(
			model,
			{
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
				tools,
			},
			{
				apiKey: "test",
				client,
				onPayload: (params: unknown) => {
					payload = params;
				},
			} as unknown as Parameters<typeof streamAnthropic>[2],
		).result();

		const params = payload as { tool_choice?: { type?: string; disable_parallel_tool_use?: boolean } };
		expect(params.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: false });
	});

	it("preserves explicit toolChoice overrides", async () => {
		const baseModel = pickModel("anthropic");
		const model = { ...baseModel, provider: "claude-bridge" as const };
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({ ok: Type.Boolean() }),
			},
		];
		let payload: unknown;
		const client = {
			messages: {
				create: () => ({
					asResponse: async () => createAnthropicResponse(),
				}),
			},
		};

		await streamAnthropic(
			model,
			{
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
				tools,
			},
			{
				apiKey: "test",
				client,
				toolChoice: "none",
				onPayload: (params: unknown) => {
					payload = params;
				},
			} as unknown as Parameters<typeof streamAnthropic>[2],
		).result();

		const params = payload as { tool_choice?: { type?: string; disable_parallel_tool_use?: boolean } };
		expect(params.tool_choice).toEqual({ type: "none" });
	});
});
