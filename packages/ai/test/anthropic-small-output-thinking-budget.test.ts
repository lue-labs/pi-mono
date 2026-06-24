import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

// Regression: a fork with a small output cap (forkAgent maxOutputTokens) clamps
// the CHILD model's maxTokens (e.g. to 1500). When that child inherits a thinking
// level, the budget-based path computes `max(0, maxTokens - minOutput)` = 476, which
// is below Anthropic's hard floor (budget_tokens >= 1024). Anthropic then DROPS the
// request as an empty completion (0 tokens) instead of erroring — silently breaking
// the fork. The verifier oracle (verify() on a cheap model) hit exactly this.
// Fix: when no valid (>=1024) thinking budget fits, disable thinking for the request.

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	max_tokens?: number;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

// Non-adaptive, thinking-capable model (no compat.forceAdaptiveThinking) — mirrors
// claude-bridge/claude-haiku-4-5. `maxTokens` mimics a forkAgent-clamped child cap.
function makeModel(maxTokens: number): Model<"anthropic-messages"> {
	return {
		id: "vendor--claude-haiku-latest",
		name: "Vendor Proxy Haiku Latest",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let captured: AnthropicThinkingPayload | undefined;
	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});
	await s.result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

describe("Anthropic thinking budget floor (small output cap)", () => {
	it("disables thinking when the cap is too small for a valid (>=1024) budget", async () => {
		// model.maxTokens=1500 + reasoning + no per-call cap => pre-fix budget 476 (invalid).
		const payload = await capturePayload(makeModel(1500), { reasoning: "adaptive" });

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.max_tokens).toBe(1500); // full output room preserved, no thinking
	});

	it("still disables thinking for an explicit small level (low) under a tiny cap", async () => {
		const payload = await capturePayload(makeModel(1500), { reasoning: "low" });
		expect(payload.thinking).toEqual({ type: "disabled" });
	});

	it("keeps budget-based thinking when the cap leaves room for a valid budget", async () => {
		// model.maxTokens=4096, medium => budget max(0,4096-1024)=3072 (>=1024) — valid.
		const payload = await capturePayload(makeModel(4096), { reasoning: "medium" });

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.thinking?.budget_tokens ?? 0).toBeGreaterThanOrEqual(1024);
	});

	it("leaves uncapped requests untouched (full budget for the level)", async () => {
		// No small cap (large model maxTokens) => budget stays at the level default.
		const payload = await capturePayload(makeModel(64000), { reasoning: "high" });

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.thinking?.budget_tokens).toBe(16384);
	});
});
