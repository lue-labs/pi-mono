/**
 * System-prompt cache split (fork-owned) — THE cache primitive.
 *
 * Splits a system prompt at `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` into a stable
 * block (carrying `cache_control`) and a dynamic tail (no cache_control), so
 * per-session/dynamic content never busts the shared static prefix. Output
 * must remain byte-identical for a given input — Anthropic's prompt cache is
 * prefix-matching on exact bytes.
 *
 * Fork provenance: extracted verbatim from anthropic-messages.ts (fork-delta
 * reforge slice 6); tier `platform` in pi-fork-patch-inventory.
 */
import type { CacheControlEphemeral } from "@anthropic-ai/sdk/resources/messages.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

export function splitSystemPromptForCache(systemPrompt: string, cacheControl?: CacheControlEphemeral) {
	const boundaryIndex = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
	if (boundaryIndex === -1) {
		return [
			{
				type: "text" as const,
				text: sanitizeSurrogates(systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	const stable = systemPrompt.slice(0, boundaryIndex).trimEnd();
	const dynamic = systemPrompt.slice(boundaryIndex + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trimStart();
	return [
		stable
			? {
					type: "text" as const,
					text: sanitizeSurrogates(stable),
					...(cacheControl ? { cache_control: cacheControl } : {}),
				}
			: undefined,
		dynamic
			? {
					type: "text" as const,
					text: sanitizeSurrogates(dynamic),
				}
			: undefined,
	].filter((block): block is Exclude<typeof block, undefined> => Boolean(block));
}
