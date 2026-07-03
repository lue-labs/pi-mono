import { describe, expect, it } from "vitest";
import { parseOpenAIResponsesUsage } from "../src/api/openai-responses-shared.ts";

describe("OpenAI Responses usage parsing", () => {
	it("reports native OpenAI cache reads without inventing cache writes", () => {
		const usage = parseOpenAIResponsesUsage({
			input_tokens: 1000,
			output_tokens: 120,
			total_tokens: 1120,
			input_tokens_details: { cached_tokens: 256 },
			output_tokens_details: { reasoning_tokens: 32 },
		});

		expect(usage.input).toBe(744);
		expect(usage.cacheRead).toBe(256);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.output).toBe(120);
		expect(usage.reasoning).toBe(32);
		expect(usage.totalTokens).toBe(1120);
	});

	it("captures OpenAI-compatible cache write metadata", () => {
		const usage = parseOpenAIResponsesUsage({
			input_tokens: 2000,
			input_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
		});

		expect(usage.cacheRead).toBe(300);
		expect(usage.cacheWrite).toBe(100);
		expect(usage.input).toBe(1600);
	});

	it("does not double-count Anthropic-compatible cache write total and breakdown fields", () => {
		const usage = parseOpenAIResponsesUsage({
			input_tokens: 2000,
			input_tokens_details: { cached_tokens: 300 },
			cache_creation_input_tokens: 200,
			cache_creation: {
				ephemeral_5m_input_tokens: 160,
				ephemeral_1h_input_tokens: 40,
			},
		});

		expect(usage.cacheRead).toBe(300);
		expect(usage.cacheWrite).toBe(200);
		expect(usage.cacheWrite1h).toBe(40);
		expect(usage.input).toBe(1500);
	});

	it("falls back to cache write breakdown fields when no total is reported", () => {
		const usage = parseOpenAIResponsesUsage({
			input_tokens: 1000,
			cache_creation: {
				ephemeral_5m_input_tokens: 120,
				ephemeral_1h_input_tokens: 30,
			},
		});

		expect(usage.cacheWrite).toBe(150);
		expect(usage.cacheWrite1h).toBe(30);
		expect(usage.input).toBe(850);
	});

	it("clamps non-cached input at zero when providers include cache writes in input_tokens", () => {
		const usage = parseOpenAIResponsesUsage({
			input_tokens: 100,
			input_tokens_details: { cached_tokens: 80, cache_write_tokens: 80 },
		});

		expect(usage.input).toBe(0);
		expect(usage.cacheRead).toBe(80);
		expect(usage.cacheWrite).toBe(80);
	});
});
