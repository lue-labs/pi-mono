import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

// Regression: models with compat.forceAdaptiveThinking (e.g. Claude Fable 5) took
// an early return that sent thinking.type=adaptive with whatever max_tokens the
// context clamp produced — and NO floor guard. When a stale post-compaction
// estimate collapsed max_tokens to ~1131, unconstrained adaptive thinking ate the
// entire budget and the turn ended with stopReason "length" and zero visible
// output. Adaptive thinking can't be given an explicit budget, so the fix disables
// thinking when there is no room for a meaningful budget plus an answer — mirroring
// the budget-based floor guard the non-adaptive path already had.

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
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

// forceAdaptiveThinking model whose (clamped) maxTokens mimics a near-full context.
function makeAdaptiveModel(maxTokens: number): Model<"anthropic-messages"> {
	return {
		id: "vendor--claude-fable-latest",
		name: "Vendor Proxy Fable Latest",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
		compat: { forceAdaptiveThinking: true },
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

describe("Anthropic adaptive thinking budget floor (near-full context)", () => {
	it("disables adaptive thinking when the clamped budget is below the floor", async () => {
		// maxTokens=1131 => below MIN_THINKING_BUDGET*2 (2048): the exact doomed turn.
		const payload = await capturePayload(makeAdaptiveModel(1131), { reasoning: "adaptive" });

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
		expect(payload.max_tokens).toBe(1131); // whole budget goes to visible output
	});

	it("also disables adaptive thinking for an explicit effort level under the floor", async () => {
		const payload = await capturePayload(makeAdaptiveModel(1500), { reasoning: "medium" });
		expect(payload.thinking).toEqual({ type: "disabled" });
	});

	it("keeps adaptive thinking when the budget clears the floor", async () => {
		const payload = await capturePayload(makeAdaptiveModel(128000), { reasoning: "adaptive" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
	});
});
