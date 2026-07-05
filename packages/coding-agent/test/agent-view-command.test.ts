import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { __test, isAgentViewCommand } from "../src/cli/agent-view-command.ts";

describe("agent view command", () => {
	test("recognizes pi agents", () => {
		expect(isAgentViewCommand(["agents"])).toBe(true);
		expect(isAgentViewCommand(["agents", "--bg", "check tests"])).toBe(true);
		expect(isAgentViewCommand(["agent"])).toBe(false);
		expect(isAgentViewCommand([])).toBe(false);
	});

	test("finds the nearest pi-agent-view package root", () => {
		const root = join(tmpdir(), `pi-agent-view-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const packageRoot = join(root, "extensions", "agent-view");
		const entrypoint = join(packageRoot, "src", "index.ts");
		mkdirSync(join(packageRoot, "src"), { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-agent-view" }));
		writeFileSync(entrypoint, "export {};\n");

		expect(__test.findPackageRoot(entrypoint)).toBe(packageRoot);
		expect(__test.packageName(packageRoot)).toBe("pi-agent-view");
	});

	test("matches scoped package names ending in pi-agent-view", () => {
		// Bundles (e.g. my-pi-full) ship the extension published under an npm
		// org scope, not the bare package name — the resolver must still find
		// it or `pi agents` reports "requires the pi-agent-view package" even
		// though it's installed and enabled.
		expect(__test.isAgentViewPackageName("pi-agent-view")).toBe(true);
		expect(__test.isAgentViewPackageName("@valkyriweb/pi-agent-view")).toBe(true);
		expect(__test.isAgentViewPackageName("@other-org/pi-agent-view")).toBe(true);
		expect(__test.isAgentViewPackageName("pi-agent-view-extra")).toBe(false);
		expect(__test.isAgentViewPackageName("@valkyriweb/not-pi-agent-view")).toBe(false);
		expect(__test.isAgentViewPackageName(undefined)).toBe(false);
	});
});
