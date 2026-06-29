import type { Usage } from "@valkyriweb/pi-ai";

export type CacheHealthWarning = "fresh_tail_large" | "prefix_cold_write" | "ttl_expiry_likely";
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
export const PREFIX_COLD_WRITE_TOKEN_THRESHOLD = 5_000;
export const TTL_EXPIRY_LIKELY_PROMPT_MIN = 30_000;
export const TTL_EXPIRY_LIKELY_PREVIOUS_CACHE_READ_MIN = 30_000;
export const TTL_EXPIRY_LIKELY_IDLE_MS = 4.5 * 60 * 1000;

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
	if (cacheWrite > PREFIX_COLD_WRITE_TOKEN_THRESHOLD && exemptions.length === 0) {
		warnings.push("prefix_cold_write");
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
		warmthPct: percent(cacheRead, cacheActivity),
		freshTailRatio,
		ttlGapMs,
		previousCacheRead,
		warnings,
		exemptions,
	};
}
