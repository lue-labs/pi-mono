/**
 * Adapter: Pi `Model<Api>` → harness `ModelCaller`.
 *
 * Wires the generative-UI harness to Pi's existing model-call infrastructure
 * (any registered provider — Anthropic, OpenAI, OpenRouter, etc.) without
 * coupling the harness itself to pi-ai.
 *
 * Usage:
 *
 *   import { completeSimple, type Model } from "@valkyriweb/pi-ai";
 *   const harness = createLLMHarness({
 *     call: createPiModelCaller(myModel),
 *   });
 *   const tool = createBuildInterfaceToolDefinition({ harness });
 *
 * In production, use a cheap fast model here (Haiku / Flash / Mistral
 * Small) per the proposal's Oracle-routing recommendation (§4.3). The
 * harness call is on the hot path for every BuildInterface invocation.
 */

import type { Api, Model } from "@valkyriweb/pi-ai";
import { completeSimple } from "@valkyriweb/pi-ai/compat";
import type { ModelCaller } from "./ui-harness.ts";

export interface PiModelCallerOptions {
	/**
	 * Maximum output tokens for the harness response. LayoutGraphs are
	 * usually small (~500–2000 tokens); default keeps a safety margin.
	 */
	maxTokens?: number;
	/** Temperature passed to the model. Default: 0.2 (mostly deterministic). */
	temperature?: number;
}

/**
 * Build a `ModelCaller` that delegates one-shot completions to Pi's
 * `completeSimple()`. Concatenates assistant text content, drops
 * thinking/tool/reference blocks (the harness only emits JSON text).
 */
export function createPiModelCaller(model: Model<Api>, options: PiModelCallerOptions = {}): ModelCaller {
	const maxTokens = options.maxTokens ?? 2048;
	const temperature = options.temperature ?? 0.2;
	return async ({ system, user, signal }) => {
		const result = await completeSimple(
			model,
			{
				systemPrompt: system,
				messages: [{ role: "user", content: user, timestamp: Date.now() }],
			},
			{ signal, maxTokens, temperature },
		);
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			throw new Error(`PiModelCaller: ${result.stopReason}: ${result.errorMessage ?? "(no error message)"}`);
		}
		return result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
	};
}
