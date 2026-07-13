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
								id: "resp_pro",
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

type ProModeModel = Model<"openai-responses"> & {
	apiModelId?: string;
	compat?: Model<"openai-responses">["compat"] & { reasoningMode?: "standard" | "pro" };
};

const model: Model<"openai-responses"> = {
	id: "gpt-5.6-terra",
	name: "GPT-5.6 Terra",
	api: "openai-responses",
	provider: "clawrouter",
	baseUrl: "http://127.0.0.1:8798/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
	contextWindow: 372000,
	maxTokens: 128000,
};

const context: Context = {
	messages: [{ role: "user", content: "Solve this", timestamp: 0 }],
};

async function request(testModel: Model<"openai-responses">) {
	await stream(testModel, context, { apiKey: "test", reasoningEffort: "max" }).result();
	return mockState.lastParams as { model?: string; reasoning?: { effort?: string; mode?: string } };
}

// Seam: the OpenAI Responses payload is the stable boundary between Pi and every OpenAI-compatible provider.
describe("OpenAI Responses Pro mode", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sends Pro mode with the selected reasoning effort", async () => {
		const params = await request({
			...model,
			compat: { reasoningMode: "pro" },
		} as ProModeModel);

		expect(params.reasoning).toMatchObject({ mode: "pro", effort: "max" });
	});

	it("sends the configured API model ID instead of a local profile ID", async () => {
		const params = await request({
			...model,
			id: "gpt-5.6-terra-pro",
			apiModelId: "gpt-5.6-terra",
			compat: { reasoningMode: "pro" },
		} as ProModeModel);

		expect(params.model).toBe("gpt-5.6-terra");
	});

	it("keeps standard profiles free of a mode override", async () => {
		const params = await request(model);

		expect(params.reasoning).toMatchObject({ effort: "max" });
		expect(params.reasoning?.mode).toBeUndefined();
	});
});
