import { describe, expect, it } from "vitest";
import { computeCacheHealth } from "../src/core/cache-health.ts";

describe("computeCacheHealth", () => {
	it("does not warn for a large write when read/write warmth is still healthy", () => {
		const health = computeCacheHealth({
			usage: { input: 7, cacheRead: 35_168, cacheWrite: 7_390 },
			assistantTurn: 5,
		});

		expect(health.warmthPct).toBe(83);
		expect(health.warnings).not.toContain("cache_write_unhealthy");
	});

	it("warns when a large write makes the cache read/write ratio unhealthy", () => {
		const health = computeCacheHealth({
			usage: { input: 2, cacheRead: 26_589, cacheWrite: 89_371 },
			assistantTurn: 64,
		});

		expect(health.warmthPct).toBe(23);
		expect(health.warnings).toContain("cache_write_unhealthy");
	});

	describe("thinking_strip_likely", () => {
		// Real-world case: session 019f40ab turn 70 (2026-07-08). A user message
		// after a 35-turn agentic loop made Anthropic strip the loop's thinking
		// blocks; the warm 140k prefix collapsed to the 26,913 tools+system anchor.
		const stripTurn = {
			usage: { input: 2, cacheRead: 26_913, cacheWrite: 121_790 },
			timestamp: "2026-07-08T10:15:06.000Z",
			model: "claude-opus-4-8-200k",
			assistantTurn: 70,
			previousAssistant: {
				usage: { input: 2, cacheRead: 140_605, cacheWrite: 1_374 },
				timestamp: "2026-07-08T10:12:20.000Z",
				model: "claude-opus-4-8-200k",
			},
			followsUserTurn: true,
		};

		it("classifies a warm→anchor collapse after a user turn as thinking strip, not unhealthy write", () => {
			const health = computeCacheHealth(stripTurn);

			expect(health.warnings).toContain("thinking_strip_likely");
			expect(health.warnings).not.toContain("cache_write_unhealthy");
		});

		it("keeps cache_write_unhealthy when no user turn intervened", () => {
			const health = computeCacheHealth({ ...stripTurn, followsUserTurn: false });

			expect(health.warnings).not.toContain("thinking_strip_likely");
			expect(health.warnings).toContain("cache_write_unhealthy");
		});

		it("defers to TTL expiry when the idle gap exceeds the TTL window", () => {
			// Session 019f4127 turn 30: 5m53s think-time gap — rolling entries simply
			// expired; same anchor floor but plain expiry is the likelier cause.
			const health = computeCacheHealth({
				...stripTurn,
				timestamp: "2026-07-08T10:18:13.000Z",
			});

			expect(health.warnings).not.toContain("thinking_strip_likely");
		});

		it("does not classify a full cold read (TTL death) as thinking strip", () => {
			const health = computeCacheHealth({
				...stripTurn,
				usage: { input: 148_705, cacheRead: 0, cacheWrite: 0 },
			});

			expect(health.warnings).not.toContain("thinking_strip_likely");
		});

		it("does not fire when the prefix stayed warm across the user turn", () => {
			const health = computeCacheHealth({
				...stripTurn,
				usage: { input: 1_200, cacheRead: 141_979, cacheWrite: 6_726 },
			});

			expect(health.warnings).not.toContain("thinking_strip_likely");
		});

		it("stays exempt on post-compaction turns", () => {
			const health = computeCacheHealth({ ...stripTurn, postCompactionTurn: true });

			expect(health.warnings).not.toContain("thinking_strip_likely");
			expect(health.exemptions).toContain("post_compaction");
		});

		it("requires the same model across turns", () => {
			const health = computeCacheHealth({ ...stripTurn, model: "claude-sonnet-5-200k" });

			expect(health.warnings).not.toContain("thinking_strip_likely");
		});
	});
});
