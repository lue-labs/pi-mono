import { describe, expect, it } from "vitest";
import { clampMaxTokensToContext } from "../src/api/simple-options.ts";
import type { Api, AssistantMessage, Context, Model, Usage, UserMessage } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";

// Regression: after compaction, the retained assistant message still carries its
// PRE-compaction `usage.totalTokens` (e.g. ~194k), while the messages actually
// present recount to a fraction of that (~a few k). estimateContextTokens
// anchored blindly on that stale usage, returning ~194k for a ~200k-window model.
// clampMaxTokensToContext then computed `window - 194k - 4096` ≈ 1131 output
// tokens and the next turn truncated to stopReason "length" with zero output.
// Fix: when the anchored estimate dwarfs a fresh recount of current messages +
// prefix, fall back to the recount.

function usage(totalTokens: number): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(text: string, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-fable-5",
		usage: usage(totalTokens),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

const model = {
	provider: "anthropic",
	id: "claude-fable-5",
	api: "anthropic-messages",
	contextWindow: 200000,
	maxTokens: 128000,
} as unknown as Model<Api>;

describe("estimateContextTokens stale usage anchor (post-compaction)", () => {
	it("ignores a stale usage anchor that dwarfs the recounted messages", () => {
		// Small compacted context whose retained assistant message still reports 194k.
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [user("short question"), assistant("short answer", 194_000), user("follow up")],
		};

		const estimate = estimateContextTokens(context);

		// Must NOT return the stale ~194k; recount is a few hundred tokens at most.
		expect(estimate.tokens).toBeLessThan(2000);
		expect(estimate.lastUsageIndex).toBeNull();
	});

	it("yields a healthy output budget after the stale anchor is discarded", () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [user("short question"), assistant("short answer", 194_000)],
		};

		// Pre-fix: 200000 - 194000 - 4096 ≈ 1904 (and worse with the real 194,773).
		const clamped = clampMaxTokensToContext(model, context, model.maxTokens);
		expect(clamped).toBeGreaterThan(100_000);
	});

	it("trusts a fresh usage anchor consistent with the messages present", () => {
		// Anchor (~500) is consistent with the recounted content (system prompt +
		// reply ≈ 500 char/4 tokens), so it must NOT be treated as stale.
		const context: Context = {
			systemPrompt: "s".repeat(1000), // ~250 tokens
			messages: [user("hi"), assistant("word ".repeat(200), 500)], // reply ~250 tokens
		};

		const estimate = estimateContextTokens(context);
		expect(estimate.lastUsageIndex).not.toBeNull();
		expect(estimate.usageTokens).toBe(500);
		expect(estimate.tokens).toBe(500 + estimate.trailingTokens);
	});
});
