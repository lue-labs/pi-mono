import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@valkyriweb/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	listActiveSessionPaths,
	listCrashedSessionPaths,
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
		// Named so fixtures survive the picker's default "named" filter (#166).
		name: `msg-${id}`,
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

	it("preserves a stale marker as a crash tombstone", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "crashed.jsonl");
		writeMarker(sessionPath, { pid: DEAD_PID, heartbeat: Date.now() });

		listActiveSessionPaths([sessionPath]);
		expect(existsSync(`${sessionPath}.live`)).toBe(false);
		expect(existsSync(`${sessionPath}.crashed`)).toBe(true);
		expect(listCrashedSessionPaths([sessionPath]).has(sessionPath)).toBe(true);
	});

	it("listCrashedSessionPaths ignores sessions without a tombstone", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "clean.jsonl");
		expect(listCrashedSessionPaths([sessionPath]).size).toBe(0);
	});

	it("skips and removes a marker owned by a dead pid", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "dead.jsonl");
		writeMarker(sessionPath, { pid: DEAD_PID, heartbeat: Date.now() });

		const active = listActiveSessionPaths([sessionPath]);
		expect(active.has(sessionPath)).toBe(false);
		expect(existsSync(`${sessionPath}.live`)).toBe(false);
	});

	it("yields before sweeping nested session dirs, keeping live markers", async () => {
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

		let completed = false;
		const sweep = Promise.resolve(sweepStaleMarkers(dir)).then((removed) => {
			completed = true;
			return removed;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		const removed = await sweep;

		expect(removed).toBe(2);
		expect(existsSync(`${live}.live`)).toBe(true);
		expect(existsSync(`${dead}.live`)).toBe(false);
		expect(existsSync(`${stale}.live`)).toBe(false);
		// Dirty-shutdown evidence is preserved as tombstones, not deleted.
		expect(existsSync(`${live}.crashed`)).toBe(false);
		expect(existsSync(`${dead}.crashed`)).toBe(true);
		expect(existsSync(`${stale}.crashed`)).toBe(true);
	});

	it("sweep ages out old tombstones but keeps fresh ones", async () => {
		const dir = makeDir();
		const fresh = join(dir, "fresh.jsonl.crashed");
		const old = join(dir, "old.jsonl.crashed");
		writeFileSync(fresh, JSON.stringify({ pid: DEAD_PID, startedAt: 0, heartbeat: 0 }));
		writeFileSync(old, JSON.stringify({ pid: DEAD_PID, startedAt: 0, heartbeat: 0 }));
		const thirtyOneDaysAgo = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
		utimesSync(old, thirtyOneDaysAgo, thirtyOneDaysAgo);

		const removed = await sweepStaleMarkers(dir);
		expect(removed).toBe(1);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(old)).toBe(false);
	});

	it("opening a session clears its crash tombstone", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "restored.jsonl");
		writeFileSync(`${sessionPath}.crashed`, JSON.stringify({ pid: DEAD_PID, startedAt: 0, heartbeat: 0 }));

		const liveness = new SessionLiveness();
		liveness.start(() => sessionPath);
		expect(existsSync(`${sessionPath}.crashed`)).toBe(false);
		expect(existsSync(`${sessionPath}.live`)).toBe(true);
		liveness.stop();
		expect(existsSync(`${sessionPath}.live`)).toBe(false);
	});

	it("heals a false tombstone from heartbeat starvation on the owner's next sync", () => {
		// Repro: a live session's heartbeat starves (sleep-wake, SIGSTOP, long
		// synchronous block) past the stale threshold; a sibling picker refresh
		// entombs the marker as crashed. The owner's next heartbeat must clear
		// the false tombstone so a graceful exit leaves no crash evidence.
		const dir = makeDir();
		const sessionPath = join(dir, "starved.jsonl");
		const liveness = new SessionLiveness();
		liveness.start(() => sessionPath);

		// Backdate the heartbeat: live pid, stale-looking marker.
		writeMarker(sessionPath, { pid: process.pid, heartbeat: Date.now() - 60_000 });
		// Sibling refresh entombs the "stale" marker.
		listActiveSessionPaths([sessionPath]);
		expect(existsSync(`${sessionPath}.crashed`)).toBe(true);

		// Owner's next heartbeat rewrites the marker and heals the tombstone.
		liveness.sync();
		expect(existsSync(`${sessionPath}.crashed`)).toBe(false);
		expect(existsSync(`${sessionPath}.live`)).toBe(true);

		liveness.stop();
		expect(existsSync(`${sessionPath}.live`)).toBe(false);
		expect(listCrashedSessionPaths([sessionPath]).size).toBe(0);
	});

	it("listActiveSessionPaths heals a stale tombstone alongside a live marker", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "healed.jsonl");
		writeMarker(sessionPath, { pid: process.pid, heartbeat: Date.now() });
		writeFileSync(`${sessionPath}.crashed`, JSON.stringify({ pid: DEAD_PID, startedAt: 0, heartbeat: 0 }));

		expect(listActiveSessionPaths([sessionPath]).has(sessionPath)).toBe(true);
		expect(existsSync(`${sessionPath}.crashed`)).toBe(false);
	});

	it("listCrashedSessionPaths excludes sessions with a live marker", () => {
		const dir = makeDir();
		const sessionPath = join(dir, "alive.jsonl");
		writeMarker(sessionPath, { pid: process.pid, heartbeat: Date.now() });
		writeFileSync(`${sessionPath}.crashed`, JSON.stringify({ pid: DEAD_PID, startedAt: 0, heartbeat: 0 }));

		expect(listCrashedSessionPaths([sessionPath]).size).toBe(0);
	});

	it("sweep returns 0 for a missing sessions dir", async () => {
		expect(await sweepStaleMarkers(join(tmpdir(), "pi-liveness-does-not-exist-xyz"))).toBe(0);
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

	it("badges a crashed session with a crash marker", async () => {
		setKeybindings(new KeybindingsManager());
		const dir = makeDir();
		const crashedPath = join(dir, "crashed.jsonl");
		const cleanPath = join(dir, "clean.jsonl");
		writeFileSync(`${crashedPath}.crashed`, JSON.stringify({ pid: DEAD_PID, startedAt: 0, heartbeat: 0 }));

		const sessions = [makeSession(crashedPath, "crashed"), makeSession(cleanPath, "clean")];
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
		const crashedLine = output.split("\n").find((l) => l.includes("msg-crashed")) ?? "";
		const cleanLine = output.split("\n").find((l) => l.includes("msg-clean")) ?? "";
		expect(crashedLine).toContain("✗");
		expect(cleanLine).not.toContain("✗");
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
