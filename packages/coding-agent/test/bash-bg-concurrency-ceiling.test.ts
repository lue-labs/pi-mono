import { describe, expect, it } from "vitest";
import { assertBashBgCapacity, BASH_BG_MAX_CONCURRENT } from "../src/core/tools/bash.ts";

describe("bash-bg concurrency ceiling", () => {
	it("allows starting below the ceiling", () => {
		expect(() => assertBashBgCapacity(0, 4)).not.toThrow();
		expect(() => assertBashBgCapacity(3, 4)).not.toThrow();
	});

	it("refuses at or above the ceiling", () => {
		expect(() => assertBashBgCapacity(4, 4)).toThrow(/4\/4 already running/);
		expect(() => assertBashBgCapacity(9, 4)).toThrow(/PI_BASH_BG_MAX/);
	});

	it("defaults to a sane non-zero ceiling", () => {
		expect(BASH_BG_MAX_CONCURRENT).toBeGreaterThan(0);
		expect(() => assertBashBgCapacity(BASH_BG_MAX_CONCURRENT - 1)).not.toThrow();
		expect(() => assertBashBgCapacity(BASH_BG_MAX_CONCURRENT)).toThrow();
	});
});
