import { describe, expect, it } from "vitest";
import { createBashToolDefinition, redundantCdToCurrentWorkingDirectory } from "../src/core/tools/bash.ts";

function getText(result: any): string {
	return result.content?.[0]?.text ?? "";
}

function isError(result: any): boolean {
	return result.isError === true;
}

const ctx: any = {};

// Claude Code parity: there is NO hard runtime block on standalone grep/rg/find.
// CC steers repo search toward Grep/Glob via prompt guidance only (with an
// explicit "unless a dedicated tool cannot accomplish the task" escape hatch),
// and gates bash through a user-configurable permission engine — never a
// built-in grep/find rejection. See docs/pi-fork-patch-inventory.md.
describe("bash native-tool steering (prompt-only, no runtime block)", () => {
	it("executes standalone grep/find instead of rejecting them", async () => {
		const bash = createBashToolDefinition(process.cwd());
		for (const command of ["grep -c '' package.json", "find . -maxdepth 1 -name package.json"]) {
			const result = await bash.execute("t1", { command }, undefined, undefined, ctx);
			expect(isError(result), `${command} should not be blocked`).toBe(false);
			expect(getText(result), command).not.toContain("use the native");
		}
	});

	it("executes composite verification harnesses that embed a grep statement", async () => {
		const bash = createBashToolDefinition(process.cwd());
		const result = await bash.execute(
			"t1",
			{ command: "echo '=== probe ==='\ngrep -c '\"name\"' package.json" },
			undefined,
			undefined,
			ctx,
		);
		expect(isError(result)).toBe(false);
		expect(getText(result)).toContain("=== probe ===");
	});

	it("still runs pipeline filters on command output", async () => {
		const bash = createBashToolDefinition(process.cwd());
		const result = await bash.execute("t1", { command: "echo hello | grep hello" }, undefined, undefined, ctx);
		expect(isError(result)).toBe(false);
		expect(getText(result)).toContain("hello");
	});

	it("steers toward native file tools via the description with CC's escape hatch, without claiming a block", () => {
		const bash = createBashToolDefinition(process.cwd());
		expect(bash.description).toContain("prefer native file tools for repo exploration");
		expect(bash.description).toContain("unless explicitly instructed or a dedicated tool cannot accomplish the task");
		expect(bash.description).toContain("pipeline filters on command output");
		// The old hard-block wording must be gone.
		expect(bash.description).not.toContain("is rejected");
	});

	it("detects redundant cd to the bash cwd", () => {
		const cwd = "/Users/luke/Projects/personal/pi-mono-fork";
		expect(redundantCdToCurrentWorkingDirectory(`cd ${cwd} && git status`, cwd)).toBe(true);
		expect(redundantCdToCurrentWorkingDirectory(`cd '${cwd}' && git status`, cwd)).toBe(true);
		expect(redundantCdToCurrentWorkingDirectory("cd packages/coding-agent && npm test", cwd)).toBe(false);
	});

	it("still blocks redundant cd to the bash cwd", async () => {
		const cwd = process.cwd();
		const bash = createBashToolDefinition(cwd);
		const result = await bash.execute("t1", { command: `cd ${cwd} && git status` }, undefined, undefined, ctx);

		expect(isError(result)).toBe(true);
		expect(getText(result)).toContain("Blocked redundant cd");
	});
});
