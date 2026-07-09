/**
 * Fork-owned footer usage computation (fork delta reforge).
 *
 * Scans session entries for cumulative token/cost totals, latest/previous
 * assistant usage snapshots, cache-health exemptions, and post-compaction
 * flags, memoized on a cheap change key. Also resolves which provider
 * adapter (claude-code / codex) is active for the footer's adapter pill.
 *
 * Extracted verbatim from `footer.ts` so the upstream component file keeps a
 * minimal fork delta. Behavior must not change here without updating
 * `~/Projects/personal/my-pi/docs/pi-fork-patch-inventory.md`.
 */
import type { CacheHealthExemption } from "../../../core/cache-health.ts";
import { getLatestCompactionEntry, type SessionEntry } from "../../../core/session-manager.ts";

export interface UsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

export interface UsageTotals {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	assistantTurns: number;
	lastUsage?: UsageSnapshot;
	lastTimestamp?: string | number;
	lastApi?: string;
	lastProvider?: string;
	lastModel?: string;
	lastResponseModel?: string;
	previousUsage?: UsageSnapshot;
	previousTimestamp?: string | number;
	previousModel?: string;
	cacheHealthExemptions: CacheHealthExemption[];
	/** True when the latest assistant turn is the first after a compaction —
	 * its cold cache write is expected, not prefix drift. */
	postCompactionTurn: boolean;
	/** True when a user message arrived between the previous and latest
	 * assistant turns — Anthropic's thinking-block strip makes the resulting
	 * one-time prefix rewrite expected (`thinking_strip_likely`). */
	followsUserTurn: boolean;
}

/** Memoized usage-totals scan over session entries for the footer. */
export class FooterUsageTracker {
	private usageCacheKey = "";
	private usageCache: UsageTotals = {
		totalInput: 0,
		totalOutput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		assistantTurns: 0,
		cacheHealthExemptions: [],
		postCompactionTurn: false,
		followsUserTurn: false,
	};

	getTotals(entries: SessionEntry[]): UsageTotals {
		let lastAssistantEntry: (typeof entries)[number] | undefined;
		let previousAssistantEntry: (typeof entries)[number] | undefined;
		let lastAssistantIndex = -1;
		let previousAssistantIndex = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type === "message" && entry.message.role === "assistant") {
				if (lastAssistantEntry === undefined) {
					lastAssistantEntry = entry;
					lastAssistantIndex = i;
				} else {
					previousAssistantEntry = entry;
					previousAssistantIndex = i;
					break;
				}
			}
		}
		const lastUsage =
			lastAssistantEntry?.type === "message" && lastAssistantEntry.message.role === "assistant"
				? lastAssistantEntry.message.usage
				: undefined;
		const previousUsage =
			previousAssistantEntry?.type === "message" && previousAssistantEntry.message.role === "assistant"
				? previousAssistantEntry.message.usage
				: undefined;
		const cacheHealthExemptions: CacheHealthExemption[] =
			previousAssistantIndex >= 0 && lastAssistantIndex >= 0
				? entries
						.slice(previousAssistantIndex + 1, lastAssistantIndex)
						.some((entry) => entry.type === "model_change")
					? ["model_change"]
					: []
				: [];
		const followsUserTurn =
			previousAssistantIndex >= 0 && lastAssistantIndex >= 0
				? entries
						.slice(previousAssistantIndex + 1, lastAssistantIndex)
						.some((entry) => entry.type === "message" && entry.message.role === "user")
				: false;
		const latestCompaction = getLatestCompactionEntry(entries);
		const cacheKey = [
			entries.length,
			entries.at(-1)?.id ?? "",
			latestCompaction?.id ?? "",
			latestCompaction?.timestamp ?? "",
			lastUsage?.input ?? 0,
			lastUsage?.output ?? 0,
			lastUsage?.cacheRead ?? 0,
			lastUsage?.cacheWrite ?? 0,
			lastUsage?.cost.total ?? 0,
			lastAssistantEntry?.timestamp ?? "",
			lastAssistantEntry?.type === "message"
				? ((lastAssistantEntry.message as { provider?: string }).provider ?? "")
				: "",
			lastAssistantEntry?.type === "message" ? ((lastAssistantEntry.message as { model?: string }).model ?? "") : "",
			lastAssistantEntry?.type === "message"
				? ((lastAssistantEntry.message as { responseModel?: string }).responseModel ?? "")
				: "",
			previousUsage?.input ?? 0,
			previousUsage?.cacheRead ?? 0,
			previousUsage?.cacheWrite ?? 0,
			previousAssistantEntry?.timestamp ?? "",
			previousAssistantEntry?.type === "message"
				? ((previousAssistantEntry.message as { model?: string }).model ?? "")
				: "",
			cacheHealthExemptions.join(","),
			followsUserTurn,
		].join(":");

		if (cacheKey === this.usageCacheKey) {
			return this.usageCache;
		}

		const totals: UsageTotals = {
			totalInput: 0,
			totalOutput: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalCost: 0,
			assistantTurns: 0,
			lastUsage,
			lastTimestamp: lastAssistantEntry?.timestamp,
			lastApi:
				lastAssistantEntry?.type === "message" && lastAssistantEntry.message.role === "assistant"
					? (lastAssistantEntry.message as { api?: string }).api
					: undefined,
			lastProvider:
				lastAssistantEntry?.type === "message" && lastAssistantEntry.message.role === "assistant"
					? (lastAssistantEntry.message as { provider?: string }).provider
					: undefined,
			lastModel:
				lastAssistantEntry?.type === "message" && lastAssistantEntry.message.role === "assistant"
					? (lastAssistantEntry.message as { model?: string }).model
					: undefined,
			lastResponseModel:
				lastAssistantEntry?.type === "message" && lastAssistantEntry.message.role === "assistant"
					? (lastAssistantEntry.message as { responseModel?: string }).responseModel
					: undefined,
			previousUsage,
			previousTimestamp: previousAssistantEntry?.timestamp,
			previousModel:
				previousAssistantEntry?.type === "message" && previousAssistantEntry.message.role === "assistant"
					? (previousAssistantEntry.message as { model?: string }).model
					: undefined,
			cacheHealthExemptions,
			postCompactionTurn: false,
			followsUserTurn,
		};

		const startIndex =
			latestCompaction === null ? 0 : entries.findIndex((entry) => entry.id === latestCompaction.id) + 1;
		for (const entry of entries.slice(startIndex)) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totals.totalInput += entry.message.usage.input;
				totals.totalOutput += entry.message.usage.output;
				totals.totalCacheRead += entry.message.usage.cacheRead;
				totals.totalCacheWrite += entry.message.usage.cacheWrite;
				totals.totalCost += entry.message.usage.cost.total;
				totals.assistantTurns += 1;
			}
		}

		// The first assistant turn after a compaction rewrites the full prefix —
		// an expected one-time cache write, not prefix drift. Flag it so render()
		// doesn't alarm on the cold hit-rate (CC notifyCompaction analog: the
		// compaction entry in the session IS the notification; no event needed).
		totals.postCompactionTurn = latestCompaction !== null && totals.assistantTurns <= 1;

		this.usageCacheKey = cacheKey;
		this.usageCache = totals;
		return totals;
	}
}
