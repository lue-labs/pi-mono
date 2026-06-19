import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/index.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";
import { type ModelPredicate, pickModel } from "./helpers/models.ts";

// Temperature handling is driven by compat.supportsTemperature, not a specific model id.
const temperatureDisabled: ModelPredicate = (model) =>
	(model.compat as { supportsTemperature?: boolean } | undefined)?.supportsTemperature === false;

interface AnthropicTemperaturePayload {
	temperature?: number;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

function makeCustomModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "vendor--claude-opus-4-7",
		name: "Vendor Proxy Opus 4.7",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicTemperaturePayload> {
	let capturedPayload: AnthropicTemperaturePayload | undefined;

	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicTemperaturePayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic temperature compatibility", () => {
	it("omits temperature for Claude Opus 4.7", async () => {
		const payload = await capturePayload(pickModel("anthropic", temperatureDisabled), { temperature: 0 });

		expect(payload.temperature).toBeUndefined();
	});

	it("omits default temperature for a temperature-disabled Claude model", async () => {
		const payload = await capturePayload(pickModel("anthropic", temperatureDisabled), { temperature: 1 });

		expect(payload.temperature).toBeUndefined();
	});

	it("keeps temperature for a temperature-enabled Claude model", async () => {
		const payload = await capturePayload(
			pickModel("anthropic", (m) => !temperatureDisabled(m)),
			{ temperature: 0 },
		);

		expect(payload.temperature).toBe(0);
	});

	it("omits temperature for custom models with supportsTemperature disabled", async () => {
		const payload = await capturePayload(makeCustomModel({ supportsTemperature: false }), { temperature: 0 });

		expect(payload.temperature).toBeUndefined();
	});
});
