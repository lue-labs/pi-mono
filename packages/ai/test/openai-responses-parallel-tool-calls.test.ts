import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/index.ts";
import type { Tool } from "../src/types.ts";
import { pickModel } from "./helpers/models.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: (params: unknown) => {
				mockState.lastParams = params;
				const stream = {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.completed",
							response: {
								id: "resp_test",
								status: "completed",
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									total_tokens: 2,
									input_tokens_details: { cached_tokens: 0 },
								},
							},
						};
					},
				};
				return {
					withResponse: async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					}),
				};
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai responses parallel tool calls", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("enables parallel_tool_calls when tools are present", async () => {
		const model = pickModel("openai");
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({ ok: Type.Boolean() }),
			},
		];

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "call ping", timestamp: Date.now() }],
				tools,
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { parallel_tool_calls?: boolean; tools?: unknown[] };
		expect(params.parallel_tool_calls).toBe(true);
		expect(params.tools?.length).toBe(1);
	});

	it("omits parallel_tool_calls when no tools are present", async () => {
		const model = pickModel("openai");

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { parallel_tool_calls?: boolean; tools?: unknown[] };
		expect(params.parallel_tool_calls).toBeUndefined();
		expect(params.tools).toBeUndefined();
	});
});
