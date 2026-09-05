import type { Usage } from "@lue-labs/pi-ai";

export type CacheHealthWarning =
	| "fresh_tail_large"
	| "cache_write_unhealthy"
	| "ttl_expiry_likely"
	| "thinking_strip_likely";
export type CacheHealthExemption = "first_assistant_turn" | "post_compaction" | "model_change";

export interface CacheHealthTurnContext {
	usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">;
	timestamp?: string | number;
	model?: string;
}

export interface CacheHealthInput extends CacheHealthTurnContext {
	assistantTurn?: number;
	postCompactionTurn?: boolean;
	exemptions?: CacheHealthExemption[];
	previousAssistant?: CacheHealthTurnContext;
	/** True when a non-tool-result user message arrived between the previous and
	 * current assistant turns. Anthropic strips all thinking blocks accrued since
	 * the last user boundary when such a message is added, invalidating cached
	 * message prefixes back to the first stripped block (tools+system survive).
	 * That expected one-time rewrite is classified as `thinking_strip_likely`
	 * instead of `cache_write_unhealthy`. */
	followsUserTurn?: boolean;
	/** `cacheRead + cacheWrite` of the first assistant turn after the *previous*
	 * user boundary. The strip removes every thinking block accrued since that
	 * boundary, and the first of them sits in that turn's own reply, so the warm
	 * prefix breaks exactly at this size. Lets a partial strip (read well above
	 * the tools+system anchor) be recognised without the 50% collapse heuristic. */
	previousUserBoundaryPrefix?: number;
}

export interface CacheHealthMetrics {
	type: "cache_health";
	input: number;
	cacheRead: number;
	cacheWrite: number;
	coveragePct: number;
	warmthPct: number;
	freshTailRatio: number | null;
	ttlGapMs: number | null;
	previousCacheRead: number;
	warnings: CacheHealthWarning[];
	exemptions: CacheHealthExemption[];
}

export const FRESH_TAIL_RATIO_WARNING_THRESHOLD = 0.8;
export const CACHE_WRITE_WARNING_TOKEN_THRESHOLD = 5_000;
export const CACHE_WRITE_WARNING_WARMTH_THRESHOLD = 80;
export const TTL_EXPIRY_LIKELY_PROMPT_MIN = 30_000;
export const TTL_EXPIRY_LIKELY_PREVIOUS_CACHE_READ_MIN = 30_000;
export const TTL_EXPIRY_LIKELY_IDLE_MS = 4.5 * 60 * 1000;
export const THINKING_STRIP_PREVIOUS_CACHE_READ_MIN = 30_000;
export const THINKING_STRIP_COLLAPSE_RATIO = 0.5;
export const THINKING_STRIP_ANCHOR_TOLERANCE_TOKENS = 256;

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percent(numerator: number, denominator: number): number {
	return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function ratio(numerator: number, denominator: number): number | null {
	if (denominator <= 0) return null;
	return Math.round((numerator / denominator) * 100) / 100;
}

function timestampMs(value: string | number | undefined): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.length === 0) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function computeCacheHealth(input: CacheHealthInput): CacheHealthMetrics {
	const usage = input.usage;
	const freshInput = finiteNumber(usage.input);
	const cacheRead = finiteNumber(usage.cacheRead);
	const cacheWrite = finiteNumber(usage.cacheWrite);
	const totalInput = freshInput + cacheRead + cacheWrite;
	const cacheActivity = cacheRead + cacheWrite;
	const freshTailRatio = ratio(freshInput, cacheRead);
	const previous = input.previousAssistant;
	const previousCacheRead = finiteNumber(previous?.usage.cacheRead);
	const currentTimestampMs = timestampMs(input.timestamp);
	const previousTimestampMs = timestampMs(previous?.timestamp);
	const ttlGapMs =
		currentTimestampMs !== null && previousTimestampMs !== null ? currentTimestampMs - previousTimestampMs : null;
	const sameModel =
		input.model !== undefined &&
		input.model !== "unknown" &&
		previous?.model !== undefined &&
		previous.model !== "unknown" &&
		input.model === previous.model;
	const exemptions: CacheHealthExemption[] = [...(input.exemptions ?? [])];
	if ((input.assistantTurn ?? 0) <= 1 && !exemptions.includes("first_assistant_turn")) {
		exemptions.push("first_assistant_turn");
	}
	if (input.postCompactionTurn && !exemptions.includes("post_compaction")) exemptions.push("post_compaction");

	const warnings: CacheHealthWarning[] = [];
	if (cacheRead > 0 && freshInput > cacheRead * FRESH_TAIL_RATIO_WARNING_THRESHOLD) {
		warnings.push("fresh_tail_large");
	}
	const warmthPct = percent(cacheRead, cacheActivity);
	// Anthropic thinking-block strip: on the first real user message after an
	// agentic loop the API drops the loop's thinking blocks from history, so the
	// warm prefix rewinds to the previous user boundary and rewrites once. When
	// that boundary was the session start the read collapses toward the static
	// tools+system anchor; after later boundaries it lands exactly on the
	// previous boundary's prefix, which can still be most of the context.
	// Signature: was warm, still partially read (an anchor survived, so not a
	// TTL death), big write, short gap (a >TTL gap makes plain expiry likelier),
	// same model, and a user turn in between. Expected cost, not prefix drift.
	const boundaryPrefix = finiteNumber(input.previousUserBoundaryPrefix);
	const rewoundToBoundary =
		boundaryPrefix > 0 &&
		cacheRead < previousCacheRead &&
		Math.abs(cacheRead - boundaryPrefix) <= THINKING_STRIP_ANCHOR_TOLERANCE_TOKENS;
	const collapsedToAnchor = cacheRead < previousCacheRead * THINKING_STRIP_COLLAPSE_RATIO;
	const thinkingStripLikely =
		input.followsUserTurn === true &&
		exemptions.length === 0 &&
		sameModel &&
		cacheRead > 0 &&
		previousCacheRead >= THINKING_STRIP_PREVIOUS_CACHE_READ_MIN &&
		(collapsedToAnchor || rewoundToBoundary) &&
		cacheWrite > CACHE_WRITE_WARNING_TOKEN_THRESHOLD &&
		ttlGapMs !== null &&
		ttlGapMs < TTL_EXPIRY_LIKELY_IDLE_MS;
	if (thinkingStripLikely) warnings.push("thinking_strip_likely");
	if (
		!thinkingStripLikely &&
		cacheWrite > CACHE_WRITE_WARNING_TOKEN_THRESHOLD &&
		warmthPct < CACHE_WRITE_WARNING_WARMTH_THRESHOLD &&
		exemptions.length === 0
	) {
		warnings.push("cache_write_unhealthy");
	}
	if (
		exemptions.length === 0 &&
		cacheRead === 0 &&
		cacheWrite === 0 &&
		freshInput >= TTL_EXPIRY_LIKELY_PROMPT_MIN &&
		previousCacheRead >= TTL_EXPIRY_LIKELY_PREVIOUS_CACHE_READ_MIN &&
		ttlGapMs !== null &&
		ttlGapMs >= TTL_EXPIRY_LIKELY_IDLE_MS &&
		sameModel
	) {
		warnings.push("ttl_expiry_likely");
	}

	return {
		type: "cache_health",
		input: freshInput,
		cacheRead,
		cacheWrite,
		coveragePct: percent(cacheRead, totalInput),
		warmthPct,
		freshTailRatio,
		ttlGapMs,
		previousCacheRead,
		warnings,
		exemptions,
	};
}
