import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: (params: unknown) => {
				mockState.lastParams = params;
				const events = {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.completed",
							response: {
								id: "resp_ultra",
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
						data: events,
						response: { status: 200, headers: new Headers() },
					}),
				};
			},
		};
	}

	return { default: FakeOpenAI };
});

const model: Model<"openai-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_050_000,
	maxTokens: 128_000,
};

const context: Context = {
	messages: [{ role: "user", content: "Solve this", timestamp: 0 }],
};

describe("OpenAI Responses Ultra wire mapping", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("serializes Ultra as max even without a model-level mapping", async () => {
		await stream(model, context, { apiKey: "test", reasoningEffort: "ultra" }).result();

		const params = mockState.lastParams as { reasoning?: { effort?: string } };
		expect(params.reasoning?.effort).toBe("max");
	});

	it("never forwards an explicit ultra mapping literally", async () => {
		await stream({ ...model, thinkingLevelMap: { ultra: "ultra" } }, context, {
			apiKey: "test",
			reasoningEffort: "ultra",
		}).result();

		const params = mockState.lastParams as { reasoning?: { effort?: string } };
		expect(params.reasoning?.effort).toBe("max");
	});
});
