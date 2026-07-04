import { describe, expect, it } from "vitest";
import {
	checkNativeToolGuard,
	createBashToolDefinition,
	redundantCdToCurrentWorkingDirectory,
} from "../src/core/tools/bash.ts";

function getText(result: any): string {
	return result.content?.[0]?.text ?? "";
}

function isError(result: any): boolean {
	return result.isError === true;
}

const ctx: any = {};

describe("bash native tool guard (hard, runtime-enforced)", () => {
	it("blocks standalone grep/rg/find/ls as the head of a pipeline", () => {
		for (const command of [
			"grep foo README.md",
			"rg foo src",
			"find . -name '*.ts'",
			"ls -la",
			"egrep foo README.md",
			"cd /tmp && grep -rn foo .",
			"FOO=bar grep foo README.md",
			"sudo grep foo /etc/hosts",
			"/usr/bin/grep foo README.md",
			"grep foo README.md | head -5",
		]) {
			expect(checkNativeToolGuard(command), command).toContain("use the native");
		}
	});

	it("allows pipeline filters on command output and non-head usage", () => {
		for (const command of [
			"echo hello | grep hello",
			"kubectl get pods | grep Ready",
			"git log --oneline | grep fix",
			"git grep foo",
			"ps aux | grep node | awk '{print $2}'",
			"jq -r '.id' file.json | sort | uniq",
		]) {
			expect(checkNativeToolGuard(command), command).toBeUndefined();
		}
	});

	it("blocks guarded heads in later `&&`/`;`/`||` statements", () => {
		expect(checkNativeToolGuard("echo a && ls src")).toContain("use the native");
		expect(checkNativeToolGuard("true; find . -name x")).toContain("use the native");
		expect(checkNativeToolGuard("test -f x || grep foo x")).toContain("use the native");
	});

	it("rejects standalone grep at execute time with native-tool steering", async () => {
		const bash = createBashToolDefinition(process.cwd());
		const result = await bash.execute("t1", { command: "grep foo README.md" }, undefined, undefined, ctx);
		expect(isError(result)).toBe(true);
		expect(getText(result)).toContain("use the native Grep tool");
	});

	it("still executes pipeline filters on command output", async () => {
		const bash = createBashToolDefinition(process.cwd());
		const result = await bash.execute("t1", { command: "echo hello | grep hello" }, undefined, undefined, ctx);
		expect(isError(result)).toBe(false);
		expect(getText(result)).toContain("hello");
	});

	it("documents Bash rejection of native-search commands with pipeline-filter exception", () => {
		const bash = createBashToolDefinition(process.cwd());

		expect(bash.description).toContain("prefer native file tools for repo exploration");
		expect(bash.description).toContain("pipeline filters on command output");
		expect(bash.description).toContain("kubectl ... | grep Ready");
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
