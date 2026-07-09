import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../types.ts";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/**
 * Split a system prompt at `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` into a stable prefix
 * (eligible for an explicit prompt-cache breakpoint) and a dynamic tail.
 * Mirrors the Anthropic `splitSystemPromptForCache` semantics: no boundary means
 * the whole prompt is stable. Output must stay byte-deterministic for a given
 * input — OpenAI prompt caching is exact-prefix matching.
 */
export function splitSystemPromptAtDynamicBoundary(systemPrompt: string): { stable: string; dynamic: string } {
	const boundaryIndex = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
	if (boundaryIndex === -1) return { stable: systemPrompt, dynamic: "" };
	return {
		stable: systemPrompt.slice(0, boundaryIndex).trimEnd(),
		dynamic: systemPrompt.slice(boundaryIndex + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trimStart(),
	};
}

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
