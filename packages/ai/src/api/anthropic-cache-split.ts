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

type SystemPromptBlock = {
	type: "text";
	text: string;
	cache_control?: CacheControlEphemeral;
};

/**
 * Builds one system-prompt text block.
 *
 * Keys are assigned in the order `type`, `text`, `cache_control`, and
 * `cache_control` is omitted entirely rather than set to a falsy value when
 * absent. Both matter: the wire bytes are produced by insertion-order
 * serialization, and Anthropic's prompt cache matches on the exact prefix
 * bytes.
 */
function systemPromptBlock(text: string, cacheControl?: CacheControlEphemeral): SystemPromptBlock {
	const block: SystemPromptBlock = {
		type: "text",
		text: sanitizeSurrogates(text),
	};
	if (cacheControl) {
		block.cache_control = cacheControl;
	}
	return block;
}

export function splitSystemPromptForCache(
	systemPrompt: string,
	cacheControl?: CacheControlEphemeral,
): SystemPromptBlock[] {
	const boundaryIndex = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
	if (boundaryIndex === -1) {
		return [systemPromptBlock(systemPrompt, cacheControl)];
	}

	const stable = systemPrompt.slice(0, boundaryIndex).trimEnd();
	const dynamic = systemPrompt.slice(boundaryIndex + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trimStart();
	const blocks: SystemPromptBlock[] = [];
	if (stable) {
		blocks.push(systemPromptBlock(stable, cacheControl));
	}
	if (dynamic) {
		// The dynamic tail deliberately carries no cache_control: that is what
		// keeps per-session content from busting the shared static prefix.
		blocks.push(systemPromptBlock(dynamic));
	}
	return blocks;
}
