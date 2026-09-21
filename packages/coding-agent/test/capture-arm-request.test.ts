/**
 * Capture the REAL Context that the split-turn compaction path emits, so the eval
 * harness can be built against what the code actually sends rather than a
 * hand-written reconstruction of it.
 *
 * This exists because the criterion-4 amendment in
 * `my-pi/reports/compaction-blob-eval-proposal-260917.md` was derived from
 * hand-built HTTP payloads. If that reconstruction is wrong, the amendment and
 * every number downstream of it are wrong. This test makes the real request
 * observable and writes it to disk for diffing.
 *
 * It asserts the structural facts the eval depends on: the turn-prefix request
 * carries the boundary marker and does NOT re-serialize the conversation as a
 * `<split-turn-prefix>` blob. It throws rather than early-returning if the
 * split-turn branch is not exercised, so it cannot pass vacuously.
 *
 * Set `ARM_CAPTURE_OUT=/path/file.json` to also write the captured request shape
 * to disk for diffing; nothing is written otherwise.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Context } from "@lue-labs/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@lue-labs/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const OUT = process.env.ARM_CAPTURE_OUT ? resolve(process.env.ARM_CAPTURE_OUT) : undefined;

/** Minimal well-formed stream result so compaction proceeds past each call. */
function fauxResult() {
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "CAPTURED SUMMARY" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
	};
	return {
		result: async () => message,
		[Symbol.asyncIterator]: async function* () {
			yield { type: "text_delta", delta: "CAPTURED SUMMARY" };
		},
	} as never;
}

it("captures the real split-turn summarization request", async () => {
	const captured: Context[] = [];

	// Register a provider that records the Context and returns a canned summary.
	const sourceId = "arm-capture";
	const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
	harnesses.push(harness);

	const model = harness.getModel();

	// Build the conversation FIRST, through the harness's own faux provider. The capture
	// provider throws, so registering it before the prompts would abort them and leave no
	// conversation to split — which is exactly what happened on the first attempt.
	await harness.session.prompt("first turn");
	await harness.session.prompt("second turn");
	await harness.session.prompt("third turn");

	registerApiProvider(
		{
			api: model.api,
			// NB: do NOT structuredClone(context) — tool definitions carry functions, which are
			// not cloneable. The clone throws before push() runs, silently capturing nothing and
			// presenting as "branch not exercised". Keep the live reference instead.
			//
			// Also do NOT throw: split-turn compaction issues TWO calls (turn-prefix summary,
			// then the main summary). Throwing on the first aborts before the one we care about.
			// Return a valid response so the whole sequence runs and both are captured.
			stream: (_m: unknown, context: Context) => {
				captured.push(context);
				return fauxResult();
			},
			streamSimple: (_m: unknown, context: Context) => {
				captured.push(context);
				return fauxResult();
			},
		} as never,
		sourceId,
	);

	try {
		await harness.session.compact().catch(() => undefined);
	} finally {
		unregisterApiProviders(sourceId);
	}

	if (captured.length === 0) {
		throw new Error("BRANCH NOT EXERCISED: no summarization request was captured");
	}

	// Pick the turn-prefix call: the one carrying the boundary marker (arm B) or the
	// re-serialized blob (arm A). Fall back to the first call if neither marker is present,
	// which itself is a finding worth seeing in the output.
	const textOf = (ctx: Context) =>
		ctx.messages
			.map((m: { content?: unknown }) =>
				typeof m.content === "string"
					? m.content
					: Array.isArray(m.content)
						? m.content.map((b: { text?: string }) => b.text ?? "").join("")
						: "",
			)
			.join("\n---\n");
	const last =
		captured.find((c) => {
			const t = textOf(c);
			return t.includes("<boundary>") || t.includes("<split-turn-prefix>");
		}) ?? captured[0]!;
	const texts = last.messages.map((m: { content?: unknown }) =>
		typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content.map((b: { text?: string }) => b.text ?? "").join("")
				: "",
	);
	const joined = texts.join("\n---\n");

	if (OUT) {
		writeFileSync(
			OUT,
			JSON.stringify(
				{
					callsCaptured: captured.length,
					messageCount: last.messages.length,
					hasTools: Array.isArray(last.tools) && last.tools.length > 0,
					toolCount: Array.isArray(last.tools) ? last.tools.length : 0,
					systemPromptChars: (last.systemPrompt ?? "").length,
					hasSplitTurnPrefixBlob: joined.includes("<split-turn-prefix>"),
					hasBoundaryMarker: joined.includes("<boundary>"),
					lastMessageChars: texts[texts.length - 1]?.length ?? 0,
					totalChars: joined.length,
					lastMessage: texts[texts.length - 1] ?? "",
				},
				null,
				2,
			),
		);
	}

	// Structural invariants the eval depends on: split-turn compaction issues two calls, the
	// turn-prefix request marks the boundary, and it does not carry a second serialized copy
	// of a conversation that is already in the replayed context.
	expect(captured.length).toBe(2);
	expect(last.messages.length).toBeGreaterThan(0);
	expect(joined).toContain("<boundary>");
	expect(joined).not.toContain("<split-turn-prefix>");
});
