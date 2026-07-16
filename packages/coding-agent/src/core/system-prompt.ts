/**
 * System prompt construction and project context loading
 */

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@valkyriweb/pi-ai";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import type { ContextFile } from "./context-file-imports.ts";
import {
	GUIDELINE_BASH_SHELL_WORK,
	GUIDELINE_NATIVE_FILE_TOOLS,
	GUIDELINE_READ_EDIT_WRITE,
} from "./prompt-guidelines.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: all built-in tools. */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: ContextFile[];
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Tool-provided guidelines travel with the tools, even under a custom prompt.
		// They are stable for a given tools[] set, so they stay in the cached prefix
		// (before the dynamic boundary). Deduped + trimmed like the default path.
		const customGuidelines: string[] = [];
		const customGuidelinesSeen = new Set<string>();
		for (const guideline of promptGuidelines ?? []) {
			const normalized = guideline.trim();
			if (normalized.length > 0 && !customGuidelinesSeen.has(normalized)) {
				customGuidelinesSeen.add(normalized);
				customGuidelines.push(normalized);
			}
		}
		if (customGuidelines.length > 0) {
			prompt += `\n\nTool guidelines:\n${customGuidelines.map((g) => `- ${g}`).join("\n")}`;
		}

		prompt += `\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}`;

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read") || selectedTools.includes("Read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["Read", "Bash", "Edit", "Write", "Grep", "Glob"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash") || tools.includes("Bash");
	const hasGrep = tools.includes("grep") || tools.includes("Grep");
	const hasGlob = tools.includes("Glob");
	const hasLs = tools.includes("ls") || tools.includes("Ls");
	const hasRead = tools.includes("read") || tools.includes("Read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasGlob && !hasLs) {
		addGuideline("Use Bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasGlob || hasLs)) {
		// Shared with bash.ts promptGuidelines via prompt-guidelines.ts so
		// addGuideline deduplicates by exact string match.
		addGuideline(GUIDELINE_NATIVE_FILE_TOOLS);
		addGuideline(GUIDELINE_BASH_SHELL_WORK);
		addGuideline(GUIDELINE_READ_EDIT_WRITE);
	}

	if (hasRead || hasGrep || hasGlob || hasLs) {
		addGuideline(
			"Batch independent tool calls in a single message: when several calls have no data dependency on each other — reads, directory listings, searches, bounded reads, independent read-only bash queries, edits to different files, or multiple Agent launches — emit them together in one assistant message instead of one call per turn. Serialize only when a later call needs an earlier call's result.",
		);
	}

	if (hasBash) {
		addGuideline(
			"Run bash commands from the current working directory unless the command truly needs another directory. To run in another directory, pass the bash `workdir` parameter (absolute path) instead of `cd <dir> && ...`; or use command-native flags like `git -C <dir>` or `npm --prefix <dir>`.",
		);
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	prompt += `\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
