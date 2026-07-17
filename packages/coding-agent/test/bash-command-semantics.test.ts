import { describe, expect, it } from "vitest";
import { type BashOperations, createBashToolDefinition, semanticExitForBashCommand } from "../src/core/tools/bash.ts";

const ctx: any = {};

function getText(result: any): string {
	return result.content?.[0]?.text ?? "";
}

function isError(result: any): boolean {
	return result.isError === true;
}

function operationsWithExit(exitCode: number, output = ""): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			if (output) onData(Buffer.from(output));
			return { exitCode };
		},
	};
}

describe("bash command exit semantics", () => {
	it.each([
		["grep needle file.txt", "grep found no matches"],
		["egrep needle file.txt", "egrep found no matches"],
		["fgrep needle file.txt", "fgrep found no matches"],
		["rg needle .", "rg found no matches"],
		["git grep needle", "git grep found no matches"],
		["git -C repo grep needle", "git grep found no matches"],
		["diff a.txt b.txt", "diff found differences"],
		["git diff -- README.md", "git diff found differences"],
		["git -C repo diff -- README.md", "git diff found differences"],
		["test -f missing", "test condition was false"],
		["[ -f missing ]", "[ condition was false"],
		["find . -name nope", "find completed with partial results or inaccessible paths"],
	])("classifies %s exit 1 as semantic success", (command, summary) => {
		expect(semanticExitForBashCommand(command, 1)?.summary).toBe(summary);
	});

	it.each(["grep needle file.txt", "diff a.txt b.txt", "test -f missing", "find . -name nope"])(
		"keeps %s exit 2 as a real failure",
		(command) => {
			expect(semanticExitForBashCommand(command, 2)).toBeUndefined();
		},
	);

	it("does not classify compound commands where exit 1 may come from another command", () => {
		expect(semanticExitForBashCommand("git grep needle; false", 1)).toBeUndefined();
		expect(semanticExitForBashCommand("diff a b && false", 1)).toBeUndefined();
	});

	it.each([
		["git grep needle", "git grep found no matches"],
		["diff a.txt b.txt", "diff found differences"],
		["git diff -- README.md", "git diff found differences"],
		["test -f missing", "test condition was false"],
		["[ -f missing ]", "[ condition was false"],
	])("returns non-error result for %s exit 1", async (command, summary) => {
		const bash = createBashToolDefinition(process.cwd(), { operations: operationsWithExit(1) });
		const result = await bash.execute("t1", { command }, undefined, undefined, ctx);

		expect(isError(result)).toBe(false);
		expect(getText(result)).toContain(`Command exited with code 1 (${summary}; treated as success).`);
	});

	it("includes command output before the semantic success summary", async () => {
		const bash = createBashToolDefinition(process.cwd(), { operations: operationsWithExit(1, "one line\n") });
		const result = await bash.execute("t1", { command: "git diff -- README.md" }, undefined, undefined, ctx);

		expect(getText(result)).toContain("one line");
		expect(getText(result)).toContain("git diff found differences; treated as success");
	});

	it("throws for non-semantic exit 1", async () => {
		const bash = createBashToolDefinition(process.cwd(), { operations: operationsWithExit(1) });

		await expect(bash.execute("t1", { command: "false" }, undefined, undefined, ctx)).rejects.toThrow(
			"Command exited with code 1",
		);
	});

	it("throws for semantic commands with true failure exits", async () => {
		const bash = createBashToolDefinition(process.cwd(), { operations: operationsWithExit(2) });

		await expect(bash.execute("t1", { command: "git grep needle" }, undefined, undefined, ctx)).rejects.toThrow(
			"Command exited with code 2",
		);
	});

	it("runs standalone grep (no hard block) and reports its semantic exit", async () => {
		const bash = createBashToolDefinition(process.cwd(), { operations: operationsWithExit(1) });
		const result = await bash.execute("t1", { command: "grep needle README.md" }, undefined, undefined, ctx);

		expect(isError(result)).toBe(false);
		expect(getText(result)).not.toContain("use the native Grep tool");
		expect(getText(result)).toContain("grep found no matches");
	});
});
