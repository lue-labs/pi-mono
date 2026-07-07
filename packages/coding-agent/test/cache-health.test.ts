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
});
