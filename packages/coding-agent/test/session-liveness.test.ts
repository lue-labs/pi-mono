import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@valkyriweb/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	listActiveSessionPaths,
	SessionLiveness,
	sweepStaleMarkers,
} from "../src/core/session-liveness.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeSession(path: string, id: string): SessionInfo {
	return {
		path,
		id,
		cwd: "",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: `msg-${id}`,
		allMessagesText: `msg-${id}`,
	};
}

function writeMarker(sessionPath: string, marker: { pid: number; heartbeat: number }): void {
	writeFileSync(`${sessionPath}.live`, JSON.stringify({ startedAt: marker.heartbeat, ...marker }));
}

const DEAD_PID = 0x3fffffff; // Astronomically unlikely to be a live process.

describe("session liveness", () => {
	const tempDirs: string[] = [];

	const makeDir = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "pi-liveness-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	beforeAll(() => {
		initTheme("dark");
	});

	it("reports a session whose marker has a live pid and fresh heartbeat", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "live.jsonl");
		writeMarker(sessionPath, { pid: process.pid, heartbeat: Date.now() });

		const active = listActiveSessionPaths([sessionPath]);
		expect(active.has(sessionPath)).toBe(true);
	});

	it("skips and removes a stale marker (old heartbeat)", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "stale.jsonl");
		writeMarker(sessionPath, { pid: process.pid, heartbeat: Date.now() - 60_000 });

		const active = listActiveSessionPaths([sessionPath]);
		expect(active.has(sessionPath)).toBe(false);
		expect(existsSync(`${sessionPath}.live`)).toBe(false);
	});

	it("skips and removes a marker owned by a dead pid", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "dead.jsonl");
		writeMarker(sessionPath, { pid: DEAD_PID, heartbeat: Date.now() });

		const active = listActiveSessionPaths([sessionPath]);
		expect(active.has(sessionPath)).toBe(false);
		expect(existsSync(`${sessionPath}.live`)).toBe(false);
	});

	it("sweeps dead and stale markers across nested session dirs, keeping live ones", () => {
		const dir = makeDir();
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);

		const live = join(projectA, "live.jsonl");
		const dead = join(projectA, "dead.jsonl");
		const stale = join(projectB, "stale.jsonl");
		writeMarker(live, { pid: process.pid, heartbeat: Date.now() });
		writeMarker(dead, { pid: DEAD_PID, heartbeat: Date.now() });
		writeMarker(stale, { pid: process.pid, heartbeat: Date.now() - 60_000 });

		const removed = sweepStaleMarkers(dir);

		expect(removed).toBe(2);
		expect(existsSync(`${live}.live`)).toBe(true);
		expect(existsSync(`${dead}.live`)).toBe(false);
		expect(existsSync(`${stale}.live`)).toBe(false);
	});

	it("sweep returns 0 for a missing sessions dir", () => {
		expect(sweepStaleMarkers(join(tmpdir(), "pi-liveness-does-not-exist-xyz"))).toBe(0);
	});

	it("ignores sessions with no marker", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "none.jsonl");
		expect(listActiveSessionPaths([sessionPath]).size).toBe(0);
	});

	it("SessionLiveness writes a live marker and removes it on stop", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "owned.jsonl");
		const liveness = new SessionLiveness();
		liveness.start(() => sessionPath);
		expect(existsSync(`${sessionPath}.live`)).toBe(true);
		expect(listActiveSessionPaths([sessionPath]).has(sessionPath)).toBe(true);
		liveness.stop();
		expect(existsSync(`${sessionPath}.live`)).toBe(false);
	});

	it("SessionLiveness moves the marker when the session path changes", () => {
		const dir = makeDir();
		const first = join(dir, "first.jsonl");
		const second = join(dir, "second.jsonl");
		let current = first;
		const liveness = new SessionLiveness();
		liveness.start(() => current);
		expect(existsSync(`${first}.live`)).toBe(true);
		current = second;
		liveness.sync();
		expect(existsSync(`${first}.live`)).toBe(false);
		expect(existsSync(`${second}.live`)).toBe(true);
		liveness.stop();
	});

	it("badges a session open in another live pi process", async () => {
		setKeybindings(new KeybindingsManager());
		const dir = makeDir();
		const activePath = join(dir, "active.jsonl");
		const idlePath = join(dir, "idle.jsonl");
		writeMarker(activePath, { pid: process.pid, heartbeat: Date.now() });

		const sessions = [makeSession(activePath, "active"), makeSession(idlePath, "idle")];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		const activeLine = output.split("\n").find((l) => l.includes("msg-active")) ?? "";
		const idleLine = output.split("\n").find((l) => l.includes("msg-idle")) ?? "";
		expect(activeLine).toContain("●");
		expect(idleLine).not.toContain("●");
	});

	it("does not badge the current session even when it has a live marker", async () => {
		setKeybindings(new KeybindingsManager());
		const dir = makeDir();
		const currentPath = join(dir, "current.jsonl");
		writeMarker(currentPath, { pid: process.pid, heartbeat: Date.now() });

		const sessions = [makeSession(currentPath, "current")];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
			currentPath,
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		const currentLine = output.split("\n").find((l) => l.includes("msg-current")) ?? "";
		expect(currentLine).not.toContain("●");
	});
});
