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
			// CC 2.x / Codex parity: Ls is no longer a default tool.
			expect(prompt).not.toContain("- Ls:");
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
				selectedTools: ["bash", "grep", "Glob"],
				toolSnippets: {
					bash: "Execute bash commands",
					grep: "Search file contents",
					Glob: "Match files by glob pattern",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"File exploration uses native tools, never bash: Read = file contents (replaces cat/head/tail/sed on files); Grep = content search (known strings/regex); Glob = file discovery by glob; SemanticGrep = conceptual search. Bash calls whose command is standalone `grep`/`rg`/`find` are rejected — split into separate native-tool calls, do not combine with other shell work in one bash invocation. Directory listing via Bash `ls` is fine.",
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

	describe("custom prompt guidelines", () => {
		test("includes tool promptGuidelines under a custom prompt, inside the cached prefix", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "You are a child agent.",
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: "/repo",
			});

			const boundary = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
			const guidelineIdx = prompt.indexOf("- Use dynamic_tool for project summaries.");
			expect(guidelineIdx).toBeGreaterThan(0);
			expect(guidelineIdx).toBeLessThan(boundary);
			expect(prompt).toContain("Tool guidelines:");
		});

		test("deduplicates and trims promptGuidelines under a custom prompt", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "You are a child agent.",
				selectedTools: ["read"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: "/repo",
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});

		test("emits no Tool guidelines section when none are provided (byte-parity)", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "You are a child agent.",
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: "/repo",
			});

			expect(prompt).not.toContain("Tool guidelines:");
		});
	});

	describe("shared guideline strings", () => {
		test("bash tool promptGuidelines dedupe against the default guidelines (byte-identical shared rules)", async () => {
			const { createBashToolDefinition } = await import("../src/core/tools/bash.ts");
			const { GUIDELINE_NATIVE_FILE_TOOLS, GUIDELINE_BASH_SHELL_WORK, GUIDELINE_READ_EDIT_WRITE } = await import(
				"../src/core/prompt-guidelines.ts"
			);
			const bashGuidelines = createBashToolDefinition("/repo").promptGuidelines ?? [];

			// The shared rules must be the exact constants — a hand-copied variant
			// silently defeats addGuideline's exact-string dedupe.
			for (const shared of [GUIDELINE_NATIVE_FILE_TOOLS, GUIDELINE_BASH_SHELL_WORK, GUIDELINE_READ_EDIT_WRITE]) {
				expect(bashGuidelines).toContain(shared);
			}

			// End-to-end: feeding bash's guidelines into the default prompt must not
			// produce duplicate bullets.
			const prompt = buildSystemPrompt({
				selectedTools: ["bash", "grep", "Glob", "ls", "read"],
				promptGuidelines: bashGuidelines,
				contextFiles: [],
				skills: [],
				cwd: "/repo",
			});
			for (const shared of [GUIDELINE_NATIVE_FILE_TOOLS, GUIDELINE_BASH_SHELL_WORK, GUIDELINE_READ_EDIT_WRITE]) {
				expect(prompt.split(shared).length - 1).toBe(1);
			}
			// No leftover drifted variant of the native-tools rule.
			expect(prompt).not.toContain("Prefer native file tools for repo exploration");
		});
	});
});
