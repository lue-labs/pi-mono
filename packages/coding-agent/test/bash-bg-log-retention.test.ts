import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASH_BG_LOG_MAX_AGE_MS, sweepStaleBashBgLogs } from "../src/core/tools/bash.ts";

function writeLog(dir: string, name: string, ageMs: number, now: number): string {
	const path = join(dir, name);
	writeFileSync(path, "output");
	const seconds = (now - ageMs) / 1000;
	utimesSync(path, seconds, seconds); // backdate mtime
	return path;
}

describe("bash-bg log retention sweep", () => {
	const NOW = Date.now();

	it("deletes .log files older than the max age, keeps fresh ones", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bashbg-"));
		const old1 = writeLog(dir, "bg_old1.log", BASH_BG_LOG_MAX_AGE_MS + 60_000, NOW);
		const old2 = writeLog(dir, "bg_old2.log", 30 * 24 * 60 * 60 * 1000, NOW);
		const fresh = writeLog(dir, "bg_fresh.log", 60_000, NOW);

		const removed = sweepStaleBashBgLogs(BASH_BG_LOG_MAX_AGE_MS, NOW, dir);

		expect(removed).toBe(2);
		expect(existsSync(old1)).toBe(false);
		expect(existsSync(old2)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("ignores non-.log files even when old", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bashbg-"));
		const keep = writeLog(dir, "notes.txt", BASH_BG_LOG_MAX_AGE_MS + 60_000, NOW);

		expect(sweepStaleBashBgLogs(BASH_BG_LOG_MAX_AGE_MS, NOW, dir)).toBe(0);
		expect(existsSync(keep)).toBe(true);
	});

	it("returns 0 when the directory does not exist", () => {
		expect(sweepStaleBashBgLogs(BASH_BG_LOG_MAX_AGE_MS, NOW, join(tmpdir(), "pi-bashbg-missing-xyz"))).toBe(0);
	});
});
