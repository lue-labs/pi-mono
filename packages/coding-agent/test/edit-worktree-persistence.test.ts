import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

/**
 * lue-labs/pi-mono#249: a child in a git worktree reported edit success while
 * that worktree's disk stayed unchanged. Core edit resolves relative paths with
 * `ctx?.cwd || constructionCwd` and writes before returning success. These
 * cases pin that contract against a real worktree, a relocated process cwd,
 * and an explicit symlink target.
 */
function fakeCtx(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n") || ""
	);
}

type EditTool = ReturnType<typeof createEditToolDefinition>;

function runEdit(
	tool: EditTool,
	id: string,
	params: { path: string; edits: Array<{ oldText: string; newText: string }> },
	ctx?: ExtensionContext,
) {
	return tool.execute(id, params, undefined, undefined, ctx as ExtensionContext);
}

function createWorktreeFixture() {
	const root = mkdtempSync(join(tmpdir(), "edit-persist-249-"));
	const main = join(root, "main");
	const wt = join(root, "wt");
	const caller = join(root, "caller");
	const outside = join(root, "outside-target.txt");
	mkdirSync(main, { recursive: true });
	mkdirSync(join(main, "sub"), { recursive: true });
	mkdirSync(caller, { recursive: true });
	writeFileSync(join(main, "rel.txt"), "relative original\n");
	writeFileSync(join(main, "tracked.txt"), "hello tracked\n");
	writeFileSync(join(main, "sub", "nested.txt"), "nested original\n");
	writeFileSync(outside, "symlink original\n");
	git(main, ["init"]);
	git(main, ["config", "user.email", "fixture@example.test"]);
	git(main, ["config", "user.name", "Fixture"]);
	git(main, ["add", "."]);
	execFileSync("git", ["-C", main, "-c", "commit.gpgsign=false", "commit", "-m", "init"], {
		encoding: "utf8",
	});
	git(main, ["worktree", "add", wt, "HEAD"]);
	symlinkSync(outside, join(wt, "linked.txt"));
	return { root, main, wt, caller, outside };
}

describe("issue249 edit persistence in a git worktree", () => {
	const fixtures: string[] = [];
	const originalCwd = process.cwd();

	afterEach(() => {
		process.chdir(originalCwd);
		while (fixtures.length > 0) {
			const root = fixtures.pop();
			if (root) rmSync(root, { recursive: true, force: true });
		}
	});

	it("relative edit with tool cwd = worktree persists while process cwd is elsewhere", async () => {
		const repo = createWorktreeFixture();
		fixtures.push(repo.root);
		process.chdir(repo.caller);

		const tool = createEditToolDefinition(repo.wt);
		const result = await runEdit(tool, "edit-rel-wt", {
			path: "rel.txt",
			edits: [{ oldText: "relative original\n", newText: "relative worktree\n" }],
		});

		expect(textOf(result)).toContain("Successfully replaced 1 block(s) in rel.txt.");
		expect(readFileSync(join(repo.wt, "rel.txt"), "utf8")).toBe("relative worktree\n");
		expect(readFileSync(join(repo.main, "rel.txt"), "utf8")).toBe("relative original\n");
		expect(git(repo.wt, ["diff", "--", "rel.txt"])).toContain("+relative worktree");
		expect(git(repo.main, ["diff", "--", "rel.txt"]).trim()).toBe("");
	});

	it("ctx.cwd routes a parent-constructed relative edit into the worktree", async () => {
		const repo = createWorktreeFixture();
		fixtures.push(repo.root);
		process.chdir(repo.caller);

		const tool = createEditToolDefinition(repo.main);
		const result = await runEdit(
			tool,
			"edit-ctx-wt",
			{ path: "rel.txt", edits: [{ oldText: "relative original\n", newText: "via ctx.cwd\n" }] },
			fakeCtx(repo.wt),
		);

		expect(textOf(result)).toContain("Successfully replaced");
		expect(readFileSync(join(repo.wt, "rel.txt"), "utf8")).toBe("via ctx.cwd\n");
		expect(readFileSync(join(repo.main, "rel.txt"), "utf8")).toBe("relative original\n");
	});

	it("without ctx, a parent-constructed relative edit writes the parent checkout", async () => {
		const repo = createWorktreeFixture();
		fixtures.push(repo.root);
		process.chdir(repo.caller);

		const tool = createEditToolDefinition(repo.main);
		await runEdit(tool, "edit-no-ctx", {
			path: "rel.txt",
			edits: [{ oldText: "relative original\n", newText: "parent no-ctx\n" }],
		});

		expect(readFileSync(join(repo.main, "rel.txt"), "utf8")).toBe("parent no-ctx\n");
		expect(readFileSync(join(repo.wt, "rel.txt"), "utf8")).toBe("relative original\n");
	});

	it("absolute worktree path persists even when the tool was constructed at the parent", async () => {
		const repo = createWorktreeFixture();
		fixtures.push(repo.root);
		process.chdir(repo.caller);

		const abs = join(repo.wt, "tracked.txt");
		const tool = createEditToolDefinition(repo.main);
		const result = await runEdit(tool, "edit-abs-wt", {
			path: abs,
			edits: [{ oldText: "hello tracked\n", newText: "absolute worktree\n" }],
		});

		expect(textOf(result)).toContain("Successfully replaced");
		expect(readFileSync(abs, "utf8")).toBe("absolute worktree\n");
		expect(readFileSync(join(repo.main, "tracked.txt"), "utf8")).toBe("hello tracked\n");
		expect(git(repo.wt, ["diff", "--", "tracked.txt"])).toContain("+absolute worktree");
	});

	it("symlink relative path writes the real target, not a new worktree file", async () => {
		const repo = createWorktreeFixture();
		fixtures.push(repo.root);
		process.chdir(repo.caller);

		const tool = createEditToolDefinition(repo.wt);
		const result = await runEdit(tool, "edit-symlink", {
			path: "linked.txt",
			edits: [{ oldText: "symlink original\n", newText: "symlink updated\n" }],
		});

		expect(textOf(result)).toContain("Successfully replaced");
		expect(readFileSync(repo.outside, "utf8")).toBe("symlink updated\n");
		expect(readFileSync(join(repo.wt, "linked.txt"), "utf8")).toBe("symlink updated\n");
		// Target sits outside the repo, so tracked worktree files stay clean.
		expect(git(repo.wt, ["status", "--porcelain", "--untracked-files=no"]).trim()).toBe("");
	});

	it("no-match, duplicate, and identical replacement error without writing", async () => {
		const repo = createWorktreeFixture();
		fixtures.push(repo.root);
		const file = join(repo.wt, "tracked.txt");
		const tool = createEditToolDefinition(repo.wt);

		await expect(
			runEdit(tool, "edit-no-match", {
				path: "tracked.txt",
				edits: [{ oldText: "does not exist\n", newText: "nope\n" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
		expect(readFileSync(file, "utf8")).toBe("hello tracked\n");

		writeFileSync(file, "foo foo\n");
		await expect(
			runEdit(tool, "edit-dup", {
				path: "tracked.txt",
				edits: [{ oldText: "foo", newText: "bar" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
		expect(readFileSync(file, "utf8")).toBe("foo foo\n");

		writeFileSync(file, "same text\n");
		await expect(
			runEdit(tool, "edit-noop", {
				path: "tracked.txt",
				edits: [{ oldText: "same text\n", newText: "same text\n" }],
			}),
		).rejects.toThrow(/No changes made/);
		expect(readFileSync(file, "utf8")).toBe("same text\n");
	});

	it("success implies the worktree file bytes and git diff changed", async () => {
		const repo = createWorktreeFixture();
		fixtures.push(repo.root);
		process.chdir(repo.caller);

		const tool = createEditToolDefinition(repo.wt);
		const result = await runEdit(tool, "edit-nested", {
			path: "sub/nested.txt",
			edits: [{ oldText: "nested original\n", newText: "nested updated\n" }],
		});

		expect(textOf(result)).toMatch(/^Successfully replaced/);
		expect(readFileSync(join(repo.wt, "sub", "nested.txt"), "utf8")).toBe("nested updated\n");
		expect(git(repo.wt, ["diff", "--", "sub/nested.txt"])).toContain("+nested updated");
	});
});
