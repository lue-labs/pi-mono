import type { Message } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/core/compaction/index.ts";
import type { CustomEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const estimate = (msgs: Message[]) => msgs.reduce((sum, m) => sum + estimateTokens(m), 0);

// Regression #257: auto-compaction silently crossed the configured threshold
// (every skip/fail path was a silent `return false` that persisted nothing) and
// overflow recovery reused the already-oversized transcript so the summary
// request itself overflowed. These tests prove:
//   1. skip/fail exits now persist a durable `compaction_skipped` custom entry.
//   2. overflow recovery bounds the summarizer input under the context window.

interface PrivateSession {
	_autoCompactDisabledThisSession: boolean;
	_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean>;
	_boundOverflowSummaryMessages(messages: Message[], reserveTokens: number): Message[];
	_estimateFixedPrefixTokens(): number;
}

function skipRecords(harness: Harness): CustomEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((e): e is CustomEntry => e.type === "custom" && e.customType === "compaction_skipped");
}

function makeMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

describe("regression #257: compaction skip observability + bounded overflow recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("persists a durable compaction_skipped record when a threshold attempt has nothing to compact", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const priv = harness.session as unknown as PrivateSession;

		// Fresh session: prepareCompaction() returns undefined -> old code returned
		// false silently. Threshold was warranted (we called _runAutoCompaction) yet
		// nothing was persisted, so an unattended run could not tell why.
		const result = await priv._runAutoCompaction("threshold", false);
		expect(result).toBe(false);

		const records = skipRecords(harness);
		expect(records).toHaveLength(1);
		expect((records[0].data as { skipReason: string }).skipReason).toBe("nothing_to_compact");
		expect((records[0].data as { reason: string }).reason).toBe("threshold");
	});

	it("persists a durable compaction_skipped record when the circuit breaker is already tripped", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const priv = harness.session as unknown as PrivateSession;
		priv._autoCompactDisabledThisSession = true;

		const result = await priv._runAutoCompaction("threshold", false);
		expect(result).toBe(false);

		const records = skipRecords(harness);
		expect(records).toHaveLength(1);
		const data = records[0].data as { skipReason: string; circuitTripped: boolean };
		expect(data.skipReason).toBe("circuit_breaker_tripped");
		expect(data.circuitTripped).toBe(true);
	});

	it("bounds the overflow summarizer input under the context window instead of reusing the oversized transcript", async () => {
		// triggerTokens set so reserveTokens = contextWindow - triggerTokens is known.
		const harness = await createHarness({ settings: { compaction: { triggerTokens: 100_000 } } });
		harnesses.push(harness);
		const priv = harness.session as unknown as PrivateSession;

		const contextWindow = harness.getModel().contextWindow; // faux default 128_000
		const reserveTokens = contextWindow - 100_000;
		const budget = contextWindow - reserveTokens - priv._estimateFixedPrefixTokens();

		// ~5k tokens each (20k chars); 40 messages ~200k tokens >> 128k window.
		const oversized = Array.from({ length: 40 }, (_, i) => makeMessage(`m${i} ${"x".repeat(20_000)}`));
		expect(estimate(oversized)).toBeGreaterThan(contextWindow);

		const bounded = priv._boundOverflowSummaryMessages(oversized, reserveTokens);

		// Trimmed strictly below the full transcript, fits under the budget, and
		// keeps the most recent message (closest to retained context).
		expect(bounded.length).toBeGreaterThan(0);
		expect(bounded.length).toBeLessThan(oversized.length);
		expect(estimate(bounded)).toBeLessThanOrEqual(budget);
		expect(bounded[bounded.length - 1]).toBe(oversized[oversized.length - 1]);

		// A small transcript is returned unchanged (threshold path stays cache-safe).
		const small = [makeMessage("hello"), makeMessage("world")];
		expect(priv._boundOverflowSummaryMessages(small, reserveTokens)).toBe(small);
	});
});
