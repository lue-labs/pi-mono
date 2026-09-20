/**
 * System prompt construction and project context loading
 */

import { getSystemMessageText } from "@lue-labs/pi-ai";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import type { ContextFile } from "./context-file-imports.ts";
import {
	GUIDELINE_BASH_SHELL_WORK,
	GUIDELINE_NATIVE_FILE_TOOLS,
	GUIDELINE_READ_EDIT_WRITE,
} from "./prompt-guidelines.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the default prefix). */
	customPrompt?: string;
	/** Exact full prompt replacement set by a before_agent_start handler. */
	forceSystemPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write]. */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines?: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt rules. */
	promptGuidelines?: string[];
	/** Text appended from user configuration before project context, skills, and cwd. */
	appendSystemPrompt?: string;
	/** Additional XML-wrapped prompt sections keyed by tag name. */
	sections?: Record<string, string>;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: ContextFile[];
	/** Pre-loaded skills. */
	skills?: Skill[];
}

export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & {
	selectedTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	appendSystemPrompt: string;
	sections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Skill[];
};

/**
 * Ordered system prompt sections, keyed by name. `preamble` is untagged text; every other
 * section is wrapped in a tag of the same name so the model can match later updates to it.
 * These become `SystemMessage.sections` in the transcript.
 */
export type SystemPromptSections = Record<string, string>;

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? ["read", "bash", "edit", "write", "grep", "glob"])],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...(input.sections ?? {}) },
		cwd: input.cwd,
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
	};
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	return [
		"Project-specific instructions and guidelines:",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
}

function findCaseInsensitiveEntry<T>(record: Record<string, T>, name: string): [string, T] | undefined {
	const normalizedName = name.toLowerCase();
	return Object.entries(record).find(([key]) => key.toLowerCase() === normalizedName);
}

function renderGuidelines(guidelines: string[]): string {
	const seen = new Set<string>();
	const normalized = guidelines
		.map((guideline) => guideline.trim())
		.filter((guideline) => guideline.length > 0 && !seen.has(guideline) && seen.add(guideline));
	return normalized.map((guideline) => `- ${guideline}`).join("\n");
}

function buildRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	const selectedToolNames = new Set(selectedTools.map((name) => name.toLowerCase()));
	const hasBash = selectedToolNames.has("bash");
	const hasPowerShell = selectedToolNames.has("powershell");
	const hasGrep = selectedToolNames.has("grep");
	const hasGlob = selectedToolNames.has("glob");
	const hasFind = selectedToolNames.has("find");
	const hasLs = selectedToolNames.has("ls");
	const hasRead = selectedToolNames.has("read");

	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addRule("Use Bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addRule("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addRule("Use Bash for file operations like ls, rg, find");
		}
	} else if (hasBash && (hasGrep || hasGlob || hasLs)) {
		// Shared with bash.ts promptGuidelines via prompt-guidelines.ts so
		// addGuideline deduplicates by exact string match.
		addRule(GUIDELINE_NATIVE_FILE_TOOLS);
		addRule(GUIDELINE_BASH_SHELL_WORK);
		addRule(GUIDELINE_READ_EDIT_WRITE);
	}

	if (hasRead || hasGrep || hasGlob || hasLs) {
		addRule(
			"Batch independent tool calls in a single message: when several calls have no data dependency on each other — reads, directory listings, searches, bounded reads, independent read-only bash queries, edits to different files, or multiple Agent launches — emit them together in one assistant message instead of one call per turn. Serialize only when a later call needs an earlier call's result.",
		);
	}

	if (hasBash) {
		addRule(
			"Run bash commands from the current working directory unless the command truly needs another directory. To run in another directory, pass the bash `workdir` parameter (absolute path) instead of `cd <dir> && ...`; or use command-native flags like `git -C <dir>` or `npm --prefix <dir>`.",
		);
	}

	for (const name of selectedTools) {
		for (const rule of findCaseInsensitiveEntry(toolGuidelines, name)?.[1] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Build the ordered, independently replaceable sections of the structured system prompt. */
export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		sections: customSections,
		cwd,
		contextFiles,
		skills,
	} = options;

	for (const name of Object.keys(customSections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}

	const promptSections: Record<string, string> = {};
	if (customPrompt) {
		promptSections.preamble = customPrompt;
		const customGuidelines = renderGuidelines(promptGuidelines);
		if (customGuidelines) promptSections.tool_guidelines = `Tool guidelines:\n${customGuidelines}`;
	} else {
		promptSections.preamble =
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
		const visibleTools = selectedTools
			.map((name) => findCaseInsensitiveEntry(toolSnippets, name))
			.filter((entry): entry is [string, string] => entry !== undefined);
		const tools =
			visibleTools.length > 0 ? visibleTools.map(([name, snippet]) => `- ${name}: ${snippet}`).join("\n") : "(none)";
		promptSections.tools = `${tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
		promptSections.rules = buildRules(selectedTools, toolGuidelines, promptGuidelines);
		const selectedToolNames = new Set(selectedTools.map((name) => name.toLowerCase()));
		const hasPiSkill =
			selectedToolNames.has("read") && skills.some((skill) => skill.name === "pi" && !skill.disableModelInvocation);
		promptSections.docs = hasPiSkill
			? `Pi documentation: load skill \`pi\`; it routes runtime identity, updates, and the installed docs/examples at ${getReadmePath()}, ${getDocsPath()}, and ${getExamplesPath()}.`
			: `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
	}

	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	const selectedToolNames = new Set(selectedTools.map((name) => name.toLowerCase()));
	const skillFileReadTool = (["read", "bash"] as const).find((tool) => selectedToolNames.has(tool));
	if (skillFileReadTool && skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}
	promptSections.cwd = cwd.replace(/\\/g, "/");
	for (const [name, content] of Object.entries(customSections)) {
		if (content) promptSections[name] = content;
	}

	const sections: SystemPromptSections = { preamble: promptSections.preamble };
	for (const [name, content] of Object.entries(promptSections)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	return sections;
}

/**
 * The complete prompt state for `input`. A forced prompt is opaque and lives in `content`
 * with no sections; otherwise `content` is empty and the structured sections carry the prompt.
 */
export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	content: string;
	sections?: SystemPromptSections;
} {
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	return { content: "", sections: buildSystemPromptSections(input) };
}

/** Build the system prompt text, rendered exactly as the transcript's system message replays it. */
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	return getSystemMessageText({ role: "system", ...buildSystemPromptState(input), timestamp: 0 });
}

/**
 * Diff the sections the model currently has (replayed from the transcript, so never null)
 * against the desired ones. Returns a `SystemMessage.sections` patch, or undefined when
 * nothing changed.
 */
export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}
