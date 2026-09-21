import type { Context } from "@lue-labs/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@lue-labs/pi-ai/compat";
import { afterEach, expect, test } from "vitest";
import { generateTurnPrefixSummary } from "../src/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

/**
 * Guards the measurement seam.
 *
 * Cost evaluation of the cache-safe compaction path needs to call the turn-prefix
 * summarizer directly and attribute usage to it: compact() combines turn-prefix and
 * history usage into a single figure, so the public path cannot answer what the
 * turn-prefix call alone cost. If this export is ever dropped, harnesses fall back to
 * hand-rebuilding the request -- and a reconstruction that drifts from the real function
 * yields confidently wrong numbers. This test fails loudly instead.
 */
test("generateTurnPrefixSummary is callable from the package entry point", async () => {
	const harness = await createHarness();
	harnesses.push(harness);

	expect(typeof generateTurnPrefixSummary).toBe("function");

	const captured: Context[] = [];
	const sourceId = "turn-prefix-export-test";
	const model = harness.getModel();

	// Capture the emitted request rather than asserting on a stubbed return value, so this
	// also pins the shape the summarizer actually sends. Do not structuredClone the context:
	// tool definitions carry functions and the clone would throw before the push, which
	// looks identical to "never called".
	const respond = () =>
		({
			result: async () => ({
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "SUMMARY" }],
				usage: {
					input: 11,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 14,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
			}),
			[Symbol.asyncIterator]: async function* () {
				yield { type: "text_delta", delta: "SUMMARY" };
			},
		}) as never;

	registerApiProvider(
		{
			api: model.api,
			stream: (_m: unknown, context: Context) => {
				captured.push(context);
				return respond();
			},
			streamSimple: (_m: unknown, context: Context) => {
				captured.push(context);
				return respond();
			},
		} as never,
		sourceId,
	);

	try {
		const result = await generateTurnPrefixSummary(
			[
				{
					role: "user",
					content: [{ type: "text", text: "investigate the failing deploy" }],
					timestamp: 0,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "the cron overlaps log rotation" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
			],
			model,
			4000,
			"faux-key",
		);

		expect(result.text).toContain("SUMMARY");
		expect(result.usage.input).toBe(11);
	} finally {
		unregisterApiProviders(sourceId);
	}

	// A vacuous pass here would be worse than a failure: it would suggest the seam works
	// while measuring nothing.
	expect(captured.length).toBeGreaterThan(0);
});
