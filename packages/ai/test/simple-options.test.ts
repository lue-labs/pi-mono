import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { Api, Model } from "../src/types.ts";

// buildBaseOptions only reads the model for context clamping; a minimal stub is enough.
const anyModel = { provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses" } as unknown as Model<Api>;

describe("buildBaseOptions", () => {
	// Regression: buildBaseOptions hand-enumerates which option fields survive into the
	// provider request. cacheAffinityKey was missing from that list, so every provider
	// (codex, openai-responses, completions, anthropic, …) silently dropped the affinity
	// one hop before deriving prompt_cache_key, collapsing back to sessionId at runtime.
	it("forwards cacheAffinityKey to the provider options", () => {
		const base = buildBaseOptions(
			anyModel,
			{ messages: [] },
			{ cacheAffinityKey: "pi:openai-codex:codex:abc123" },
			"k",
		);
		expect(base.cacheAffinityKey).toBe("pi:openai-codex:codex:abc123");
	});

	it("leaves cacheAffinityKey undefined when not supplied", () => {
		const base = buildBaseOptions(anyModel, { messages: [] }, {}, "k");
		expect(base.cacheAffinityKey).toBeUndefined();
	});
});
