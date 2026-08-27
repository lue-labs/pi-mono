import { afterEach, describe, expect, it } from "vitest";
import { resolveCacheRetention } from "../src/utils/cache-retention.ts";

const originalRetention = process.env.PI_CACHE_RETENTION;

afterEach(() => {
	if (originalRetention === undefined) {
		delete process.env.PI_CACHE_RETENTION;
	} else {
		process.env.PI_CACHE_RETENTION = originalRetention;
	}
});

describe("resolveCacheRetention", () => {
	it("prefers an explicit retention over environment configuration", () => {
		process.env.PI_CACHE_RETENTION = "none";

		expect(resolveCacheRetention("short")).toBe("short");
	});

	it("accepts supported environment values and defaults to long", () => {
		for (const retention of ["short", "none", "long"] as const) {
			process.env.PI_CACHE_RETENTION = retention;
			expect(resolveCacheRetention()).toBe(retention);
		}

		delete process.env.PI_CACHE_RETENTION;
		expect(resolveCacheRetention()).toBe("long");
	});

	it("uses request-scoped environment values before process environment", () => {
		process.env.PI_CACHE_RETENTION = "short";

		expect(resolveCacheRetention(undefined, { PI_CACHE_RETENTION: "none" })).toBe("none");
	});

	it("supports adapters with a backend-owned default and narrower env policy", () => {
		process.env.PI_CACHE_RETENTION = "short";

		expect(
			resolveCacheRetention(undefined, undefined, {
				defaultRetention: undefined,
				allowedEnvValues: ["long"],
			}),
		).toBeUndefined();

		process.env.PI_CACHE_RETENTION = "long";
		expect(
			resolveCacheRetention(undefined, undefined, {
				defaultRetention: undefined,
				allowedEnvValues: ["long"],
			}),
		).toBe("long");
	});
});
