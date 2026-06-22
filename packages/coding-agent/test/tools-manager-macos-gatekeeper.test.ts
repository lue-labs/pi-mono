import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Regression coverage for the macOS Gatekeeper hot-loop fix: on Darwin, Pi must
// never resolve a system-PATH (Homebrew adhoc-signed) search binary, because
// spawning it on every Grep/Find triggers a Gatekeeper assessment. The resolver
// must return null so callers fall through to Pi's managed, quarantine-free copy.

let currentPlatform = "darwin";
let localBinaryExists = false;

vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>();
	return { ...actual, platform: () => currentPlatform, arch: actual.arch };
});

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return { ...actual, existsSync: () => localBinaryExists };
});

// commandExists() uses spawnSync; track whether the system-PATH probe is reached.
const spawnSyncMock = vi.fn(() => ({ status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null }));
vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return { ...actual, spawnSync: () => spawnSyncMock() };
});

const { getOptionalSearchToolPath, getToolPath } = await import("../src/utils/tools-manager.ts");

describe("macOS search-backend Gatekeeper bypass", () => {
	beforeEach(() => {
		localBinaryExists = false;
		spawnSyncMock.mockClear();
		delete process.env.PI_OFFLINE;
	});
	afterEach(() => {
		currentPlatform = "darwin";
	});

	test("getOptionalSearchToolPath returns null on darwin without probing PATH", () => {
		currentPlatform = "darwin";
		expect(getOptionalSearchToolPath("ugrep")).toBe(null);
		expect(getOptionalSearchToolPath("bfs")).toBe(null);
		// Never spawned the Homebrew binary to detect it — that probe is the loop.
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	test("getOptionalSearchToolPath still uses system PATH on linux", () => {
		currentPlatform = "linux";
		expect(getOptionalSearchToolPath("ugrep")).toBe("ugrep");
		expect(spawnSyncMock).toHaveBeenCalled();
	});

	test("getToolPath returns null on darwin (online) so a managed copy is downloaded", () => {
		currentPlatform = "darwin";
		expect(getToolPath("rg")).toBe(null);
		expect(getToolPath("fd")).toBe(null);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	test("getToolPath keeps the PATH fallback on darwin in offline mode", () => {
		currentPlatform = "darwin";
		process.env.PI_OFFLINE = "1";
		expect(getToolPath("rg")).toBe("rg");
		expect(spawnSyncMock).toHaveBeenCalled();
	});

	test("getToolPath uses system PATH on linux", () => {
		currentPlatform = "linux";
		expect(getToolPath("rg")).toBe("rg");
		expect(spawnSyncMock).toHaveBeenCalled();
	});

	test("a present managed binary is returned on darwin (no PATH probe)", () => {
		currentPlatform = "darwin";
		localBinaryExists = true;
		// getLocalToolPath hits first; resolves inside TOOLS_DIR, never the system probe.
		expect(getOptionalSearchToolPath("ugrep")).toContain("ugrep");
		expect(getToolPath("rg")).toContain("rg");
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});
