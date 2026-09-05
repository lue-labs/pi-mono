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

		describe("partial strip rewinding to the previous user boundary", () => {
			// Session 01a06c3c (2026-09-05). Turn 61 was a full collapse to the
			// 27,269 anchor (read 27,269 + write 62,844 = 90,113). Turn 67, six
			// tool turns and one user prompt later, read exactly 90,113: the strip
			// removed turn 61's own thinking block, so the prefix broke right after
			// the previous user message — 92% of the previous read survived and the
			// 50% collapse rule missed it. Turn 101 repeated the shape after a
			// background-task notification (read 101,639 = turn 67's 90,113 + 11,526).
			const partialStripTurn = {
				usage: { input: 4, cacheRead: 90_113, cacheWrite: 11_526 },
				timestamp: "2026-09-05T07:30:32.841Z",
				model: "claude-fable-5-1",
				assistantTurn: 67,
				previousAssistant: {
					usage: { input: 2, cacheRead: 98_474, cacheWrite: 2_429 },
					timestamp: "2026-09-05T07:30:23.821Z",
					model: "claude-fable-5-1",
				},
				followsUserTurn: true,
				previousUserBoundaryPrefix: 27_269 + 62_844,
			};

			it("classifies a rewind to the previous boundary prefix as thinking strip", () => {
				const health = computeCacheHealth(partialStripTurn);

				expect(health.warnings).toContain("thinking_strip_likely");
				expect(health.warnings).not.toContain("cache_write_unhealthy");
			});

			// Turn 101: warmth 78%, so before the anchor signal this one surfaced
			// as cache_write_unhealthy and was chased as prefix drift.
			const notificationStripTurn = {
				usage: { input: 4, cacheRead: 101_639, cacheWrite: 28_590 },
				timestamp: "2026-09-05T07:36:23.383Z",
				model: "claude-fable-5-1",
				assistantTurn: 101,
				previousAssistant: {
					usage: { input: 2, cacheRead: 135_126, cacheWrite: 571 },
					timestamp: "2026-09-05T07:36:18.378Z",
					model: "claude-fable-5-1",
				},
				followsUserTurn: true,
				previousUserBoundaryPrefix: 90_113 + 11_526,
			};

			it("classifies the notification-triggered repeat (turn 101) instead of cache_write_unhealthy", () => {
				const health = computeCacheHealth(notificationStripTurn);

				expect(health.warnings).toContain("thinking_strip_likely");
				expect(health.warnings).not.toContain("cache_write_unhealthy");
			});

			it("stays cache_write_unhealthy when the read lands away from the boundary prefix", () => {
				const health = computeCacheHealth({ ...notificationStripTurn, previousUserBoundaryPrefix: 80_000 });

				expect(health.warnings).not.toContain("thinking_strip_likely");
				expect(health.warnings).toContain("cache_write_unhealthy");
			});

			it("stays cache_write_unhealthy without a boundary prefix to match", () => {
				const health = computeCacheHealth({ ...notificationStripTurn, previousUserBoundaryPrefix: undefined });

				expect(health.warnings).not.toContain("thinking_strip_likely");
				expect(health.warnings).toContain("cache_write_unhealthy");
			});

			it("leaves a healthy-warmth partial strip unflagged without the boundary prefix", () => {
				const health = computeCacheHealth({ ...partialStripTurn, previousUserBoundaryPrefix: undefined });

				expect(health.warnings).toEqual([]);
			});

			it("does not fire when no user turn intervened, even at the boundary prefix", () => {
				const health = computeCacheHealth({ ...partialStripTurn, followsUserTurn: false });

				expect(health.warnings).not.toContain("thinking_strip_likely");
			});

			it("does not fire when the prefix grew past the boundary (a normal warm turn)", () => {
				const health = computeCacheHealth({
					...partialStripTurn,
					usage: { input: 2, cacheRead: 100_903, cacheWrite: 6_000 },
					previousUserBoundaryPrefix: 100_903,
				});

				expect(health.warnings).not.toContain("thinking_strip_likely");
			});
		});
	});
});
