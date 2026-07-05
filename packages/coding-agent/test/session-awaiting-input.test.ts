import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearSessionAwaitingInput,
	markSessionAwaitingInput,
	readSessionAwaitingInput,
} from "../src/core/session-awaiting-input.ts";

const tempDirs: string[] = [];

function makeSessionPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-awaiting-input-"));
	tempDirs.push(dir);
	return join(dir, "session.jsonl");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("markSessionAwaitingInput / readSessionAwaitingInput / clearSessionAwaitingInput", () => {
	it("round-trips a marker with the current pid and reason", () => {
		const sessionPath = makeSessionPath();
		markSessionAwaitingInput(sessionPath, "Which retry strategy?");

		const marker = readSessionAwaitingInput(sessionPath);
		expect(marker).toBeDefined();
		expect(marker?.pid).toBe(process.pid);
		expect(marker?.reason).toBe("Which retry strategy?");
		expect(existsSync(`${sessionPath}.awaiting-input`)).toBe(true);
	});

	it("returns undefined once cleared", () => {
		const sessionPath = makeSessionPath();
		markSessionAwaitingInput(sessionPath, "Confirm?");
		clearSessionAwaitingInput(sessionPath);

		expect(readSessionAwaitingInput(sessionPath)).toBeUndefined();
		expect(existsSync(`${sessionPath}.awaiting-input`)).toBe(false);
	});

	it("clearing a marker that was never written is a no-op, not an error", () => {
		const sessionPath = makeSessionPath();
		expect(() => clearSessionAwaitingInput(sessionPath)).not.toThrow();
	});

	it("treats a marker owned by a dead pid as absent (cross-process crash recovery)", () => {
		const sessionPath = makeSessionPath();
		// A pid essentially guaranteed not to exist.
		const deadPid = 2_000_000_000;
		writeFileSync(
			`${sessionPath}.awaiting-input`,
			JSON.stringify({ pid: deadPid, reason: "orphaned", since: Date.now() }),
		);

		expect(readSessionAwaitingInput(sessionPath)).toBeUndefined();
	});

	it("treats a stale marker (old heartbeat) from a live pid as absent", () => {
		const sessionPath = makeSessionPath();
		writeFileSync(
			`${sessionPath}.awaiting-input`,
			JSON.stringify({ pid: process.pid, reason: "ancient", since: Date.now() - 10 * 60_000 }),
		);

		expect(readSessionAwaitingInput(sessionPath)).toBeUndefined();
	});

	it("returns undefined for a malformed marker file", () => {
		const sessionPath = makeSessionPath();
		writeFileSync(`${sessionPath}.awaiting-input`, "{not json");

		expect(readSessionAwaitingInput(sessionPath)).toBeUndefined();
	});

	it("returns undefined when no marker file exists", () => {
		const sessionPath = makeSessionPath();
		expect(readSessionAwaitingInput(sessionPath)).toBeUndefined();
	});
});
