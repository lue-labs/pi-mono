import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModels } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { isReasoning, pickModel, supportsThinkingLevel } from "./helpers/models.ts";

// Capability-derived model selection so dropped/renamed model ids cannot break the
// suite. Reasoning models that support an "off" thinking level emit reasoning.effort
// "none"; those that do not omit reasoning entirely.
const openaiResponsesReasoningModels = getModels("openai").filter(
	(model) => model.api === "openai-responses" && isReasoning(model),
);
const offSupportedReasoningModels = openaiResponsesReasoningModels.filter(supportsThinkingLevel("off"));
const offUnsupportedReasoningModels = openaiResponsesReasoningModels.filter(
	(model) => !supportsThinkingLevel("off")(model),
);
// The 2.5x priority multiplier is hardcoded for id "gpt-5.5" in openai-responses.ts;
// every other model gets 2x. Select by id-shape so the test mirrors that source logic.
const nonGpt55ResponsesModel = pickModel(
	"openai",
	(model) => model.api === "openai-responses" && model.id !== "gpt-5.5",
);
const gpt55Model = pickModel("openai", (model) => model.id === "gpt-5.5");

type CapturedHeaders = RequestInit["headers"];

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== lowerName || value === undefined) continue;
		return typeof value === "string" ? value : Array.from(value).join(", ");
	}
	return null;
}

async function captureOpenAIResponseHeaders(
	options: Parameters<typeof streamOpenAIResponses>[2],
	model: Model<"openai-responses"> = pickModel("openai", (m) => m.api === "openai-responses"),
): Promise<{ sessionId: string | null; clientRequestId: string | null }> {
	const captured = { sessionId: null as string | null, clientRequestId: null as string | null };
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key", ...options },
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits reasoning when no reasoning is requested", async () => {
		const model = pickModel("github-copilot", (m) => m.api === "openai-responses") as Model<"openai-responses">;
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
	});

	it.each(offSupportedReasoningModels)(
		"sends none reasoning effort for OpenAI $id when no reasoning is requested",
		async (model) => {
			let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			reasoning: { effort: "none" },
		});
	});

	it.each(offUnsupportedReasoningModels)(
		"omits reasoning effort for OpenAI $id when off is unsupported",
		async (model) => {
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			expect(capturedPayload).not.toMatchObject({
				reasoning: expect.anything(),
			});
		},
	);

	it("sets cache-affinity headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured).toEqual({ sessionId: "session-123", clientRequestId: "session-123" });
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const sessionId = "x".repeat(67);
		let capturedPayload: { prompt_cache_key?: string } | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			nonGpt55ResponsesModel,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				sessionId,
				onPayload: (payload) => {
					capturedPayload = payload as { prompt_cache_key?: string };
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("sets cache-affinity headers for proxy OpenAI Responses requests with a sessionId", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...nonGpt55ResponsesModel,
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured).toEqual({ sessionId: "session-123", clientRequestId: "session-123" });
	});

	it("can omit the session_id header while preserving other cache-affinity headers", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...nonGpt55ResponsesModel,
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionIdHeader: false },
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured).toEqual({ sessionId: null, clientRequestId: "session-123" });
	});

	it("lets explicit headers override the default OpenAI cache-affinity headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured).toEqual({ sessionId: "override-session", clientRequestId: "override-request" });
	});

	it("omits OpenAI cache-affinity headers when cacheRetention is none", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured).toEqual({ sessionId: null, clientRequestId: null });
	});

	it.each([
		{ model: nonGpt55ResponsesModel, serviceTier: "priority", multiplier: 2 },
		{ model: gpt55Model, serviceTier: "priority", multiplier: 2.5 },
		{ model: gpt55Model, serviceTier: "flex", multiplier: 0.5 },
	] as const)(
		"applies $serviceTier service-tier cost multiplier ($multiplier)",
		async ({ model, serviceTier, multiplier }) => {
			const sse = `${[
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						service_tier: serviceTier,
						usage: {
							input_tokens: 1000000,
							output_tokens: 1000000,
							total_tokens: 2000000,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n")}\n\n`;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{ apiKey: "test-key", serviceTier },
			);

			const result = await stream.result();

			expect(result.usage.cost.input).toBe(model.cost.input * multiplier);
			expect(result.usage.cost.output).toBe(model.cost.output * multiplier);
			expect(result.usage.cost.total).toBe((model.cost.input + model.cost.output) * multiplier);
		},
	);
});
