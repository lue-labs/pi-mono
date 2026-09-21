/**
 * Guards the compaction prompt's anti-invention and failure-retention rules.
 *
 * These exist because a summary that invents plausible progress, or silently drops
 * a previously-recorded failed approach, is worse than a short one: the next reader
 * cannot tell fabrication from fact, and repeats mistakes that were already paid for.
 *
 * The update path is the subtle one. It tells the model to use an EXACT format, so any
 * section missing from ITS format block gets dropped on the next compaction cycle even
 * if an earlier summary recorded it. Errors must therefore appear in every format block,
 * not just the initial one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const compactionSrc = readFileSync(
	fileURLToPath(new URL("../src/core/compaction/compaction.ts", import.meta.url)),
	"utf8",
);
const branchSrc = readFileSync(
	fileURLToPath(new URL("../src/core/compaction/branch-summarization.ts", import.meta.url)),
	"utf8",
);

/** Extracts a top-level `const NAME = \`...\`;` template literal body. */
function promptBody(src: string, name: string): string {
	const start = src.indexOf(`const ${name} = \``);
	expect(start, `prompt ${name} not found`).toBeGreaterThan(-1);
	const from = start + `const ${name} = \``.length;
	const end = src.indexOf("`;", from);
	expect(end, `unterminated template for ${name}`).toBeGreaterThan(-1);
	return src.slice(from, end);
}

const SUMMARY_PROMPTS = [
	["SUMMARIZATION_PROMPT", compactionSrc],
	["CACHE_SAFE_SUMMARIZATION_PROMPT", compactionSrc],
	["UPDATE_SUMMARIZATION_INSTRUCTIONS", compactionSrc],
	["BRANCH_SUMMARY_PROMPT", branchSrc],
] as const;

describe("compaction prompt grounding", () => {
	it.each(SUMMARY_PROMPTS)("%s retains an Errors & Failed Approaches section", (name, src) => {
		// Must be in the FORMAT block of every prompt: the update path copies its format
		// verbatim, so an omission here silently drops failures on long sessions.
		expect(promptBody(src, name)).toContain("## Errors & Failed Approaches");
	});

	it.each(SUMMARY_PROMPTS)("%s constrains Next Steps to user-approved work", (name, src) => {
		expect(promptBody(src, name)).toMatch(/ONLY steps the user actually asked for/);
	});

	it.each(SUMMARY_PROMPTS)("%s forbids inventing content for empty sections", (name, src) => {
		expect(promptBody(src, name)).toMatch(/\(none\)/);
	});

	it.each([
		["SUMMARIZATION_PROMPT", compactionSrc],
		["CACHE_SAFE_SUMMARIZATION_PROMPT", compactionSrc],
		["UPDATE_SUMMARIZATION_INSTRUCTIONS", compactionSrc],
	] as const)("%s preserves user corrections verbatim", (name, src) => {
		expect(promptBody(src, name)).toMatch(/corrections.*in their own words/);
	});

	it("update path preserves prior failures rather than only appending new ones", () => {
		// Without this, "use this EXACT format" plus a fresh read of recent messages
		// tends to rewrite the section from scratch and lose older entries.
		expect(promptBody(compactionSrc, "UPDATE_SUMMARIZATION_INSTRUCTIONS")).toMatch(
			/Preserve ALL previously recorded failures/,
		);
	});

	it("turn-prefix prompt refuses to infer content it did not observe", () => {
		const body = promptBody(compactionSrc, "CACHE_SAFE_TURN_PREFIX_SUMMARIZATION_PROMPT");
		expect(body).toMatch(/rather than inferring plausible content/);
	});
});

describe("compaction request does not double-pay", () => {
	it("cache-safe paths never serialize the conversation into the prompt", () => {
		// The cache-safe request replays the live conversation as structured messages.
		// Embedding a serialized copy too would bill the same bytes twice in one call --
		// as a cache WRITE outside the cached prefix, never read back.
		const cacheSafeBranch = compactionSrc.slice(
			compactionSrc.indexOf("const context: Context = cacheSafeContext"),
			compactionSrc.indexOf(
				"const response = await completeSummarization",
				compactionSrc.indexOf("const context: Context = cacheSafeContext"),
			),
		);
		expect(cacheSafeBranch.length).toBeGreaterThan(0);
		const cacheSafeArm = cacheSafeBranch.slice(0, cacheSafeBranch.indexOf(": buildSummarizationContext"));
		expect(cacheSafeArm).not.toContain("serializeConversation");
		expect(cacheSafeArm).not.toContain("<split-turn-prefix>");
	});

	it("legacy serialization only feeds standalone contexts", () => {
		// buildSummarizationContext builds a ONE-message context with no history, so the
		// serialized text is the only copy -- not duplication. If it ever gained history,
		// every legacy call would start double-paying.
		const fn = compactionSrc.slice(
			compactionSrc.indexOf("function buildSummarizationContext"),
			compactionSrc.indexOf("function buildSummarizationContext") + 500,
		);
		expect(fn).toContain("messages: [");
		expect(fn).not.toContain("...");
	});
});
