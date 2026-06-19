import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/index.ts";
import { getModel } from "../src/models.ts";
import { allOf, isReasoning, pickModel, supportsThinkingLevel } from "./helpers/models.ts";

// Adaptive-thinking Anthropic models are exactly the ones exposing the xhigh level
// (opus 4.6+); budget-based reasoning models do not expose xhigh.
const budgetBasedReasoningModel = allOf(isReasoning, (model) => !supportsThinkingLevel("xhigh")(model));
// Fable 5 exposes xhigh but cannot be turned off (off: null) and never sends
// thinking.type=disabled, so adaptive predicates also require "off" support.
const adaptiveReasoningModel = allOf(isReasoning, supportsThinkingLevel("xhigh"), supportsThinkingLevel("off"));
// Models whose xhigh level maps to the "xhigh" effort (opus 4.7+); opus 4.6 maps to "max".
const xhighEffortReasoningModel = allOf(
	isReasoning,
	(model) => model.thinkingLevelMap?.xhigh === "xhigh",
	supportsThinkingLevel("off"),
);

import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

interface RunResult {
	thinkingEventCount: number;
	thinkingCharCount: number;
	text: string;
	contentTypes: string[];
}

function makeE2EContext(): Context {
	return {
		systemPrompt: "You are a precise assistant. Follow the requested output format exactly.",
		messages: [
			{
				role: "user",
				content:
					"Before replying, carefully solve 36863 * 5279 internally. Then reply with the word pong repeated exactly 40 times, separated by single spaces. Do not add any other text.",
				timestamp: Date.now(),
			},
		],
	};
}

function countPongs(text: string): number {
	return text.match(/\bpong\b/gi)?.length ?? 0;
}

async function runWithoutReasoning(model: Model<"anthropic-messages">): Promise<RunResult> {
	const s = streamSimple(model, makeE2EContext(), {
		temperature: 0,
		maxTokens: 160,
	});

	let thinkingEventCount = 0;
	let thinkingCharCount = 0;

	for await (const event of s) {
		if (event.type === "thinking_start" || event.type === "thinking_end") {
			thinkingEventCount += 1;
		}
		if (event.type === "thinking_delta") {
			thinkingEventCount += 1;
			thinkingCharCount += event.delta.length;
		}
	}

	const response = await s.result();
	expect(response.stopReason, response.errorMessage).toBe("stop");

	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();

	return {
		thinkingEventCount,
		thinkingCharCount,
		text,
		contentTypes: response.content.map((block) => block.type),
	};
}

describe("Anthropic thinking disable payload", () => {
	it("sends thinking.type=disabled for budget-based reasoning models when thinking is off", async () => {
		const payload = await capturePayload(pickModel("anthropic", budgetBasedReasoningModel));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for adaptive reasoning models when thinking is off", async () => {
		const payload = await capturePayload(pickModel("anthropic", adaptiveReasoningModel));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for Claude Opus 4.8 when thinking is off", async () => {
		const payload = await capturePayload(pickModel("anthropic", adaptiveReasoningModel));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("omits thinking.type=disabled for Claude Fable 5 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"));

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
	});

	it("uses adaptive thinking for Claude Opus 4.8 when reasoning is enabled", async () => {
		const payload = await capturePayload(pickModel("anthropic", adaptiveReasoningModel), { reasoning: "high" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.8", async () => {
		const payload = await capturePayload(pickModel("anthropic", xhighEffortReasoningModel), { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic thinking disable E2E", () => {
	it("disables thinking for Claude reasoning models", { retry: 2, timeout: 30000 }, async () => {
		const result = await runWithoutReasoning(pickModel("anthropic", budgetBasedReasoningModel));

		expect(result.thinkingEventCount).toBe(0);
		expect(result.thinkingCharCount).toBe(0);
		expect(result.contentTypes).not.toContain("thinking");
		expect(countPongs(result.text)).toBeGreaterThanOrEqual(35);
	});
});
