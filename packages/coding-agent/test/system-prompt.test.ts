import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@valkyriweb/pi-ai";
import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					Read: "Read file contents",
					Bash: "Execute bash commands",
					Edit: "Make surgical edits",
					Write: "Create or overwrite files",
					Grep: "Search file contents",
					Glob: "Match files by glob pattern",
					Ls: "List directory contents",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Read:");
			expect(prompt).toContain("- Bash:");
			expect(prompt).toContain("- Edit:");
			expect(prompt).toContain("- Write:");
			expect(prompt).toContain("- Grep:");
			expect(prompt).toContain("- Glob:");
			expect(prompt).toContain("- Ls:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("cache boundary", () => {
		test("places dynamic context after the stable boundary", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [{ path: "/repo/AGENTS.md", content: "Project rules" }],
				skills: [],
				cwd: "/repo",
			});

			const boundary = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
			expect(boundary).toBeGreaterThan(0);
			expect(prompt.indexOf("<project_context>")).toBeGreaterThan(boundary);
			expect(prompt.indexOf("Current date:")).toBeGreaterThan(boundary);
			expect(prompt.indexOf("Current working directory:")).toBeGreaterThan(boundary);
		});
	});

	describe("context files", () => {
		test("renders imported context files as separate stable sections", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [
					{ path: "/repo/AGENTS.md", content: "Root @docs/rules.md" },
					{
						path: "/repo/docs/rules.md",
						content: "Imported rules",
						parentPath: "/repo/AGENTS.md",
						rootPath: "/repo/AGENTS.md",
						importDepth: 1,
					},
				],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain('<project_instructions path="/repo/AGENTS.md">\nRoot @docs/rules.md');
			expect(prompt).toContain('<project_instructions path="/repo/docs/rules.md">\nImported rules');
			expect(prompt.indexOf('path="/repo/AGENTS.md"')).toBeLessThan(prompt.indexOf('path="/repo/docs/rules.md"'));
		});
	});

	describe("prompt guidelines", () => {
		test("routes repo exploration to native tools and shell output to Bash", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["bash", "grep", "Glob", "ls"],
				toolSnippets: {
					bash: "Execute bash commands",
					grep: "Search file contents",
					Glob: "Match files by glob pattern",
					ls: "List directory contents",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"File/dir exploration uses native tools, never bash: Read = file contents (replaces cat/head/tail/sed on files); Ls = directory listing; Grep = content search (known strings/regex); Glob = file discovery by glob; SemanticGrep = conceptual search. Bash calls containing `ls`/`grep`/`rg`/`find` are rejected in full — split into separate native-tool calls, do not combine with other shell work in one bash invocation.",
			);
			expect(prompt).toContain(
				"Use Bash for shell work and non-repo command output: `kubectl ... | jq`, `ps ... | awk`, git, package managers, `stat`/`wc`/`head`/`tail`.",
			);
			expect(prompt).toContain(
				"Use Read/Edit/Write for files instead of shelling out to view or modify file contents.",
			);
		});

		test("steers independent work into batched parallel tool calls", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "grep", "Glob", "ls"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"Batch independent tool calls in a single message: when several calls have no data dependency on each other — reads, directory listings, searches, bounded reads, independent read-only bash queries, edits to different files, or multiple Agent launches — emit them together in one assistant message instead of one call per turn. Serialize only when a later call needs an earlier call's result.",
			);
		});

		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
