import { describe, expect, it } from "vitest";
import {
	type AssistantMessage,
	type Context,
	calculateContextTokens,
	estimateContextTokens,
	estimateMessageTokens,
	type Usage,
} from "../src/index.ts";

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

function assistant(totalTokens: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "test-provider",
		model: "test-model",
		usage: usage(totalTokens),
		stopReason,
		timestamp: Date.now(),
	};
}

describe("token estimation", () => {
	it("calculates context tokens from usage", () => {
		expect(calculateContextTokens({ ...usage(0), input: 10, output: 20, cacheRead: 3, cacheWrite: 4 })).toBe(37);
		expect(calculateContextTokens(usage(123))).toBe(123);
	});

	it("estimates message tokens from content", () => {
		expect(estimateMessageTokens({ role: "user", content: "x".repeat(400), timestamp: 0 })).toBe(100);
	});

	it("uses the latest valid assistant usage as baseline and estimates only trailing messages", () => {
		const context: Context = {
			systemPrompt: "system text that should already be counted by provider usage",
			messages: [
				{ role: "user", content: "x".repeat(10_000), timestamp: 0 },
				assistant(50_000),
				{ role: "user", content: "x".repeat(400), timestamp: 0 },
			],
		};

		expect(estimateContextTokens(context)).toMatchObject({
			tokens: 50_100,
			usageTokens: 50_000,
			trailingTokens: 100,
			lastUsageIndex: 1,
		});
	});

	it("ignores error/aborted assistant usage", () => {
		const context: Context = {
			messages: [assistant(50_000, "error"), { role: "user", content: "x".repeat(400), timestamp: 0 }],
		};

		expect(estimateContextTokens(context)).toMatchObject({
			tokens: 101,
			usageTokens: 0,
			lastUsageIndex: null,
		});
	});
});
