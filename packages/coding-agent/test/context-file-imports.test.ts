import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ContextFile,
	createContextFileImportCache,
	expandContextFilesImports,
	expandSystemPromptImports,
	extractContextFileImports,
	MAX_CONTEXT_IMPORT_DEPTH,
} from "../src/core/context-file-imports.ts";

function file(path: string, content: string): ContextFile {
	return { path, content };
}

describe("context file @ imports", () => {
	let tempDir: string;
	let projectDir: string;
	let agentDir: string;
	let cleanupPaths: string[];

	beforeEach(() => {
		tempDir = join(process.cwd(), ".tmp-context-imports", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		cleanupPaths = [tempDir];
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		for (const path of cleanupPaths) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	function expand(rootContent: string, rootPath = join(projectDir, "AGENTS.md")) {
		return expandContextFilesImports([file(rootPath, rootContent)], {
			cwd: projectDir,
			agentDir,
			cache: createContextFileImportCache(),
		});
	}

	it("loads a basic bare relative import", () => {
		const child = join(projectDir, "child.md");
		writeFileSync(child, "child instructions");

		const result = expand("root\n@child.md");

		expect(result.contextFiles.map((f) => f.path)).toEqual([join(projectDir, "AGENTS.md"), child]);
		expect(result.contextFiles[1].content).toBe("child instructions");
		expect(result.contextFiles[1].parentPath).toBe(join(projectDir, "AGENTS.md"));
	});

	it("resolves ./ and ../ imports relative to the importing file", () => {
		const dir = join(projectDir, "docs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(projectDir, "shared.md"), "shared");
		writeFileSync(join(dir, "nested.md"), "nested @../shared.md");

		const result = expand("@./docs/nested.md");

		expect(result.contextFiles.map((f) => f.content)).toEqual([
			"@./docs/nested.md",
			"nested @../shared.md",
			"shared",
		]);
	});

	it("resolves home-relative imports", () => {
		const homeImport = join(homedir(), `.pi-context-import-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
		cleanupPaths.push(homeImport);
		writeFileSync(homeImport, "home import");

		const result = expand(`@~/${homeImport.slice(homedir().length + 1)}`);

		// The importer reports paths resolved with realpathSync.native (it dedups
		// imports across roots by real path), so compare the same way: on macOS the
		// temp HOME lives under /var, a symlink to /private/var. The other cases in
		// this file build paths under cwd, so only the home-relative one is exposed.
		expect(result.contextFiles[1].path).toBe(realpathSync.native(homeImport));
		expect(result.contextFiles[1].content).toBe("home import");
	});

	it("resolves absolute imports", () => {
		const child = join(projectDir, "absolute.md");
		writeFileSync(child, "absolute");

		const result = expand(`@${child}`);

		expect(result.contextFiles[1].path).toBe(child);
	});

	it("strips fragments before resolving imports", () => {
		const child = join(projectDir, "fragment.md");
		writeFileSync(child, "fragment");

		const result = expand("@fragment.md#heading");

		expect(result.contextFiles[1].path).toBe(child);
	});

	it("unescapes escaped spaces in import paths", () => {
		const child = join(projectDir, "my file.md");
		writeFileSync(child, "space");

		const result = expand("@my\\ file.md");

		expect(result.contextFiles[1].path).toBe(child);
	});

	it("ignores imports inside fenced code blocks", () => {
		writeFileSync(join(projectDir, "ignored.md"), "ignored");
		const result = expand("```\n@ignored.md\n```");
		expect(result.contextFiles).toHaveLength(1);
	});

	it("ignores imports inside indented code blocks", () => {
		writeFileSync(join(projectDir, "ignored.md"), "ignored");
		const result = expand("    @ignored.md");
		expect(result.contextFiles).toHaveLength(1);
	});

	it("ignores imports inside inline code spans", () => {
		writeFileSync(join(projectDir, "ignored.md"), "ignored");
		const result = expand("Use `@ignored.md` literally");
		expect(result.contextFiles).toHaveLength(1);
	});

	it("ignores imports inside HTML comments", () => {
		writeFileSync(join(projectDir, "ignored.md"), "ignored");
		const result = expand("<!-- @ignored.md -->");
		expect(result.contextFiles).toHaveLength(1);
	});

	it("scans residue outside HTML comments", () => {
		writeFileSync(join(projectDir, "ignored.md"), "ignored");
		writeFileSync(join(projectDir, "real.md"), "real");
		const result = expand("<!-- @ignored.md --> @real.md");
		expect(result.contextFiles.map((f) => f.content)).toEqual(["<!-- @ignored.md --> @real.md", "real"]);
	});

	it("warns and skips unsupported file extensions", () => {
		const child = join(projectDir, "binary.png");
		writeFileSync(child, "not really png");

		const result = expand("@binary.png");

		expect(result.contextFiles).toHaveLength(1);
		expect(result.diagnostics[0].message).toContain("unsupported file extension");
	});

	it("warns and skips missing files", () => {
		const result = expand("@missing.md");
		expect(result.contextFiles).toHaveLength(1);
		expect(result.diagnostics[0].message).toContain("does not exist");
	});

	it("prevents duplicate imports and cycles", () => {
		writeFileSync(join(projectDir, "a.md"), "A @b.md");
		writeFileSync(join(projectDir, "b.md"), "B @a.md");

		const result = expand("@a.md\n@a.md");

		expect(result.contextFiles.map((f) => f.content)).toEqual(["@a.md\n@a.md", "A @b.md", "B @a.md"]);
		expect(result.diagnostics.some((d) => d.message.includes("duplicate or circular"))).toBe(true);
	});

	it("stops at the maximum include depth", () => {
		for (let i = 1; i <= MAX_CONTEXT_IMPORT_DEPTH + 1; i++) {
			writeFileSync(join(projectDir, `d${i}.md`), `depth ${i} @d${i + 1}.md`);
		}

		const result = expand("@d1.md");

		expect(result.contextFiles.map((f) => f.content)).toEqual([
			"@d1.md",
			"depth 1 @d2.md",
			"depth 2 @d3.md",
			"depth 3 @d4.md",
			"depth 4 @d5.md",
		]);
		expect(result.diagnostics[0].message).toContain("Maximum context import depth reached");
	});

	it("returns byte-identical content from cache when files are unchanged", () => {
		const cache = createContextFileImportCache();
		writeFileSync(join(projectDir, "cached.md"), "cached");
		const root = file(join(projectDir, "AGENTS.md"), "@cached.md");

		const first = expandContextFilesImports([root], { cwd: projectDir, agentDir, cache });
		const second = expandContextFilesImports([root], { cwd: projectDir, agentDir, cache });

		expect(JSON.stringify(second.contextFiles)).toBe(JSON.stringify(first.contextFiles));
	});

	it("invalidates cache when a dependency mtime or size changes", () => {
		const cache = createContextFileImportCache();
		const child = join(projectDir, "dep.md");
		writeFileSync(child, "old");
		const root = file(join(projectDir, "AGENTS.md"), "@dep.md");
		expandContextFilesImports([root], { cwd: projectDir, agentDir, cache });

		writeFileSync(child, "new content with different size");
		const second = expandContextFilesImports([root], { cwd: projectDir, agentDir, cache });

		expect(second.contextFiles[1].content).toBe("new content with different size");
	});

	it("expands multiple context files independently", () => {
		writeFileSync(join(projectDir, "one.md"), "one");
		writeFileSync(join(projectDir, "two.md"), "two");

		const result = expandContextFilesImports(
			[file(join(projectDir, "AGENTS.md"), "@one.md"), file(join(projectDir, "sub", "AGENTS.md"), "@../two.md")],
			{ cwd: projectDir, agentDir, cache: createContextFileImportCache() },
		);

		expect(result.contextFiles.map((f) => f.content)).toEqual(["@one.md", "one", "@../two.md", "two"]);
	});

	it("extracts only path-like @ references", () => {
		const imports = extractContextFileImports(
			"email@example.com @ok.md @@no.md @#no @valkyriweb @import",
			join(projectDir, "AGENTS.md"),
		);
		expect(imports.map((i) => i.path)).toEqual([join(projectDir, "ok.md")]);
	});

	it("ignores extensionless @ mentions before resolving paths", () => {
		const result = expand("Handles: @valkyriweb\n@import ./TOOLS.md");

		expect(result.contextFiles).toHaveLength(1);
		expect(result.diagnostics).toEqual([]);
	});

	it("dedupes the same file imported by multiple roots (cross-root realpath dedup)", () => {
		writeFileSync(join(projectDir, "shared.md"), "shared content");

		const result = expandContextFilesImports(
			[file(join(projectDir, "a.md"), "@shared.md"), file(join(projectDir, "b.md"), "@shared.md")],
			{ cwd: projectDir, agentDir, cache: createContextFileImportCache() },
		);

		const paths = result.contextFiles.map((f) => f.path);
		expect(paths).toEqual([join(projectDir, "a.md"), join(projectDir, "shared.md"), join(projectDir, "b.md")]);
		expect(paths.filter((p) => p === join(projectDir, "shared.md"))).toHaveLength(1);
	});

	it("dedupes a root reached via symlink against the same file reached directly", () => {
		const real = join(projectDir, "AGENTS.md");
		const link = join(projectDir, "AGENTS.link.md");
		writeFileSync(real, "root content");
		symlinkSync(real, link);

		const result = expandContextFilesImports([file(real, "root content"), file(link, "root content")], {
			cwd: projectDir,
			agentDir,
			cache: createContextFileImportCache(),
		});

		expect(result.contextFiles).toHaveLength(1);
		expect(result.contextFiles[0].path).toBe(real);
	});
});

describe("system-prompt @ imports (inline substitution)", () => {
	let tempDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = join(process.cwd(), ".tmp-system-imports", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("substitutes a single @import inline", () => {
		const child = join(projectDir, "persona.md");
		writeFileSync(child, "You are a helpful agent.");
		const parent = join(projectDir, "APPEND_SYSTEM.md");
		const input = "Override:\n@persona.md\n\nAlways use TypeScript.";
		writeFileSync(parent, input);

		const result = expandSystemPromptImports(input, parent);

		expect(result.content).toBe("Override:\nYou are a helpful agent.\n\nAlways use TypeScript.");
		expect(result.diagnostics).toEqual([]);
	});

	it("substitutes recursively", () => {
		const leaf = join(projectDir, "leaf.md");
		writeFileSync(leaf, "leaf content");
		const mid = join(projectDir, "mid.md");
		writeFileSync(mid, "before\n@leaf.md\nafter");
		const root = join(projectDir, "SYSTEM.md");
		const input = "root\n@mid.md\ndone";
		writeFileSync(root, input);

		const result = expandSystemPromptImports(input, root);

		expect(result.content).toBe("root\nbefore\nleaf content\nafter\ndone");
	});

	it("leaves @imports inside fenced code blocks unchanged", () => {
		const child = join(projectDir, "frag.md");
		writeFileSync(child, "frag content");
		const parent = join(projectDir, "SYSTEM.md");
		const input = "Use this:\n```\n@frag.md\n```\n@frag.md";
		writeFileSync(parent, input);

		const result = expandSystemPromptImports(input, parent);

		expect(result.content).toBe("Use this:\n```\n@frag.md\n```\nfrag content");
	});

	it("warns and preserves token for missing imports", () => {
		const parent = join(projectDir, "APPEND_SYSTEM.md");
		writeFileSync(parent, "@missing.md");

		const result = expandSystemPromptImports("@missing.md", parent);

		expect(result.content).toBe("@missing.md");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].message).toContain("does not exist");
	});

	it("leaves extensionless @ mentions unchanged without diagnostics", () => {
		const parent = join(projectDir, "APPEND_SYSTEM.md");
		const input = "Handles: @valkyriweb\n@import ./TOOLS.md";
		writeFileSync(parent, input);

		const result = expandSystemPromptImports(input, parent);

		expect(result.content).toBe(input);
		expect(result.diagnostics).toEqual([]);
	});

	it("breaks cycles via realpath dedup", () => {
		const a = join(projectDir, "a.md");
		const b = join(projectDir, "b.md");
		writeFileSync(a, "A1\n@b.md\nA2");
		writeFileSync(b, "B1\n@a.md\nB2");

		const result = expandSystemPromptImports("A1\n@b.md\nA2", a);

		// b.md inlines, then b.md's @a.md is dropped (cycle), leaving B1/B2 around.
		expect(result.content).toBe("A1\nB1\n\nB2\nA2");
		expect(result.diagnostics.some((d) => d.message.includes("duplicate or circular"))).toBe(true);
	});

	it("caps recursion at MAX_CONTEXT_IMPORT_DEPTH", () => {
		// Build a chain longer than the depth cap.
		const names = ["a", "b", "c", "d", "e", "f"];
		for (let i = 0; i < names.length; i++) {
			const next = names[i + 1];
			const path = join(projectDir, `${names[i]}.md`);
			writeFileSync(path, next ? `${names[i]}\n@${next}.md` : "f");
		}
		const root = join(projectDir, "a.md");

		const result = expandSystemPromptImports("a\n@b.md", root);
		expect(result.diagnostics.some((d) => d.message.includes("Maximum context import depth"))).toBe(true);
		expect(result.content.startsWith("a\nb\n")).toBe(true);
		expect(MAX_CONTEXT_IMPORT_DEPTH).toBe(5);
	});
});
