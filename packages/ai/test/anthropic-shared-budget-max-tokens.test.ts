import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions, Usage } from "../src/types.ts";

interface AnthropicPayload {
	max_tokens: number;
	thinking?: { type: string; budget_tokens?: number };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "vendor--minimax-m2.7",
		name: "Vendor MiniMax M2.7",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 204800,
		maxTokens: 131072,
		compat,
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const stream = streamSimple(model, context, {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});

	await stream.result();
	if (!capturedPayload) throw new Error("Expected payload to be captured before request failure");
	return capturedPayload;
}

describe("Anthropic shared-budget max_tokens compatibility", () => {
	it("clamps max_tokens for shared-budget providers", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "x".repeat(600_000), timestamp: Date.now() }],
		};

		const payload = await capturePayload(makeModel({ maxTokensSharesContextWindow: true }), context);

		expect(payload.max_tokens).toBe(204800 - Math.ceil(600_000 / 4));
	});

	it("uses provider usage baseline before clamping", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "x".repeat(800_000), timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "anthropic-messages",
					provider: "vendor-proxy",
					model: "vendor--minimax-m2.7",
					usage: usage(50_000),
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "x".repeat(400), timestamp: Date.now() },
			],
		};

		const payload = await capturePayload(makeModel({ maxTokensSharesContextWindow: true }), context);

		expect(payload.max_tokens).toBe(131072);
	});

	it("does not clamp Anthropic-style independent input/output budgets", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "x".repeat(600_000), timestamp: Date.now() }],
		};

		const payload = await capturePayload(makeModel(), context);

		expect(payload.max_tokens).toBe(131072);
	});

	it("keeps thinking budget below clamped max_tokens", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "x".repeat(800_000), timestamp: Date.now() }],
		};

		const payload = await capturePayload(makeModel({ maxTokensSharesContextWindow: true }), context, {
			reasoning: "high",
		});

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.thinking?.budget_tokens).toBeLessThan(payload.max_tokens);
	});

	it("marks built-in MiniMax models as shared-budget", () => {
		expect(getModel("minimax", "MiniMax-M2.7-highspeed").compat?.maxTokensSharesContextWindow).toBe(true);
		expect(getModel("minimax-cn", "MiniMax-M2.7-highspeed").compat?.maxTokensSharesContextWindow).toBe(true);
	});
});
