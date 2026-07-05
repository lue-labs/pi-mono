import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __test, isAgentViewCommand, runAgentViewCommand } from "../src/cli/agent-view-command.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const { findPackageRoot, packageName, matchesAgentViewPackageName, loadAgentViewModule } = __test;

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = join(tmpdir(), `pi-agent-view-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	delete process.env.PI_AGENT_VIEW_MODULE;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isAgentViewCommand", () => {
	it("matches only the `agents` subcommand", () => {
		expect(isAgentViewCommand(["agents"])).toBe(true);
		expect(isAgentViewCommand(["agents", "--help"])).toBe(true);
		expect(isAgentViewCommand(["other"])).toBe(false);
		expect(isAgentViewCommand([])).toBe(false);
	});
});

// Regression coverage for the bug where a scoped publish of the agent-view
// package (e.g. `@valkyriweb/pi-agent-view`) never matched the dispatcher's
// literal, unscoped `pi-agent-view` comparison, so `pi agents` always printed
// "requires the pi-agent-view package" even when agent-view was loaded.
describe("matchesAgentViewPackageName", () => {
	it("matches the unscoped literal name (regression baseline)", () => {
		expect(matchesAgentViewPackageName("pi-agent-view")).toBe(true);
	});

	it("matches any npm-scoped publish of the package", () => {
		expect(matchesAgentViewPackageName("@valkyriweb/pi-agent-view")).toBe(true);
		expect(matchesAgentViewPackageName("@someone-else/pi-agent-view")).toBe(true);
	});

	it("does not match an unrelated package", () => {
		expect(matchesAgentViewPackageName("pi-agent-view-extras")).toBe(false);
		expect(matchesAgentViewPackageName("@valkyriweb/some-other-package")).toBe(false);
		expect(matchesAgentViewPackageName(undefined)).toBe(false);
	});
});

describe("findPackageRoot + packageName + matchesAgentViewPackageName composition", () => {
	it("resolves a scoped agent-view package root and name from a nested resource path", () => {
		const pkgDir = makeTempDir();
		mkdirSync(join(pkgDir, "dist"), { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "@valkyriweb/pi-agent-view", version: "1.0.0" }),
		);
		writeFileSync(join(pkgDir, "dist", "index.js"), "export function runAgentViewCli() {}");

		const resourcePath = join(pkgDir, "dist", "index.js");
		const root = findPackageRoot(resourcePath);
		expect(root).toBe(pkgDir);
		expect(matchesAgentViewPackageName(packageName(root!))).toBe(true);
	});
});

describe("loadAgentViewModule", () => {
	it("PI_AGENT_VIEW_MODULE override still wins even when it resolves", async () => {
		const dir = makeTempDir();
		const modulePath = join(dir, "override.mjs");
		writeFileSync(modulePath, "export function runAgentViewCli() { return { marker: 'override' }; }\n");
		process.env.PI_AGENT_VIEW_MODULE = modulePath;

		const loaded = await loadAgentViewModule(process.cwd(), dir);
		expect(loaded).toBeDefined();
		expect(typeof loaded?.runAgentViewCli).toBe("function");
	});

	it("returns undefined when nothing resolves and no package is configured", async () => {
		const dir = makeTempDir();
		const loaded = await loadAgentViewModule(dir, dir);
		expect(loaded).toBeUndefined();
	});
});

describe("runAgentViewCommand", () => {
	it("passes through non-`agents` invocations unhandled", async () => {
		const result = await runAgentViewCommand(["chat"]);
		expect(result).toEqual({ handled: false, args: ["chat"] });
	});
});

describe("scoped package resolution end-to-end via the package manager", () => {
	it("resolves an enabled extension published under a scope as the agent-view module", async () => {
		const cwd = makeTempDir();
		const agentDir = join(cwd, ".pi-agent");
		mkdirSync(agentDir, { recursive: true });

		const pkgDir = join(cwd, "scoped-agent-view-pkg");
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "@valkyriweb/pi-agent-view",
				pi: { extensions: ["./extensions/main.ts"] },
			}),
		);
		writeFileSync(join(pkgDir, "extensions", "main.ts"), "export default function() {}");

		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setExtensionPaths([pkgDir]);
		const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
		const resolved = await packageManager.resolve(async () => "skip");

		const matched = resolved.extensions.find((resource) => {
			if (!resource.enabled) return false;
			const root = findPackageRoot(resource.path);
			return root ? matchesAgentViewPackageName(packageName(root)) : false;
		});

		expect(matched).toBeDefined();
	});
});
