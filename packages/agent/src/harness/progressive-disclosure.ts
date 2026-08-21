import type { ToolReferenceContent } from "@lue-labs/pi-ai";
import { type TSchema, Type } from "typebox";
import type { AgentTool } from "../types.ts";
import type { Skill } from "./types.ts";

const toolSearchSchema = Type.Object({
	query: Type.Optional(Type.String()),
	toolNames: Type.Optional(Type.Array(Type.String())),
});

const skillSearchSchema = Type.Object({
	query: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	names: Type.Optional(Type.Array(Type.String())),
});

type ToolSearchParams = {
	query?: string;
	toolNames?: string[];
};

type SkillSearchParams = {
	query?: string;
	name?: string;
	names?: string[];
};

export interface ProgressiveToolSearchOptions<TTool extends AgentTool<TSchema, unknown> = AgentTool<TSchema, unknown>> {
	getTools(): TTool[];
	getActiveToolNames(): string[];
	setActiveToolNames(toolNames: string[]): void | Promise<void>;
	alwaysActiveToolNames?: string[];
	maxResults?: number;
}

export interface SkillSearchOptions<TSkill extends Skill = Skill> {
	getSkills(): TSkill[];
	maxResults?: number;
}

export interface OpenClawProgressiveDisclosureOptions<
	TSkill extends Skill = Skill,
	TTool extends AgentTool<TSchema, unknown> = AgentTool<TSchema, unknown>,
> {
	getTools(): TTool[];
	getActiveToolNames(): string[];
	setActiveToolNames(toolNames: string[]): void | Promise<void>;
	getSkills(): TSkill[];
	alwaysActiveToolNames?: string[];
	maxToolResults?: number;
	maxSkillResults?: number;
}

export function createProgressiveToolSearchTool<
	TTool extends AgentTool<TSchema, unknown> = AgentTool<TSchema, unknown>,
>(options: ProgressiveToolSearchOptions<TTool>): AgentTool<typeof toolSearchSchema, { activatedToolNames: string[] }> {
	return {
		name: "tool_search",
		label: "Tool Search",
		description: "Discover and activate OpenClaw runtime tools by query or exact tool name.",
		parameters: toolSearchSchema,
		alwaysLoad: true,
		execute: async (_toolCallId, rawParams) => {
			const params = rawParams as ToolSearchParams;
			const tools = options.getTools();
			const searchableTools = tools.filter((tool) => tool.name !== "tool_search" && tool.name !== "skill_search");
			const matches = selectTools(searchableTools, params, options.maxResults ?? 8);
			const activatedToolNames = matches.map((tool) => tool.name);
			if (activatedToolNames.length > 0) {
				await options.setActiveToolNames(
					mergeNames(options.getActiveToolNames(), options.alwaysActiveToolNames ?? [], activatedToolNames),
				);
			}

			return {
				content: formatToolSearchResult(matches, params),
				details: { activatedToolNames },
			};
		},
	};
}

export function createSkillSearchTool<TSkill extends Skill = Skill>(
	options: SkillSearchOptions<TSkill>,
): AgentTool<typeof skillSearchSchema, { matchedSkillNames: string[] }> {
	return {
		name: "skill_search",
		label: "Skill Search",
		description: "Search OpenClaw runtime skills and load exact skill instructions when needed.",
		parameters: skillSearchSchema,
		alwaysLoad: true,
		execute: async (_toolCallId, rawParams) => {
			const params = rawParams as SkillSearchParams;
			const skills = options.getSkills().filter((skill) => !skill.disableModelInvocation);
			const exactNames = requestedSkillNames(params);
			const exactMatches = exactNames
				.map((name) => skills.find((skill) => skill.name === name))
				.filter((skill): skill is TSkill => skill !== undefined);
			const matches =
				exactMatches.length > 0 ? exactMatches : searchSkills(skills, params.query, options.maxResults ?? 8);

			return {
				content: [{ type: "text", text: formatSkillSearchResult(matches, exactMatches.length > 0) }],
				details: { matchedSkillNames: matches.map((skill) => skill.name) },
			};
		},
	};
}

export function createOpenClawProgressiveDisclosureTools<
	TSkill extends Skill = Skill,
	TTool extends AgentTool<TSchema, unknown> = AgentTool<TSchema, unknown>,
>(options: OpenClawProgressiveDisclosureOptions<TSkill, TTool>): Array<AgentTool<TSchema, unknown>> {
	return [
		createProgressiveToolSearchTool({
			getTools: options.getTools,
			getActiveToolNames: options.getActiveToolNames,
			setActiveToolNames: options.setActiveToolNames,
			alwaysActiveToolNames: ["tool_search", "skill_search", ...(options.alwaysActiveToolNames ?? [])],
			maxResults: options.maxToolResults,
		}),
		createSkillSearchTool({ getSkills: options.getSkills, maxResults: options.maxSkillResults }),
	];
}

export function formatProgressiveSkillsForSystemPrompt(skills: Skill[]): string {
	const visibleCount = skills.filter((skill) => !skill.disableModelInvocation).length;
	if (visibleCount === 0) return "";

	return [
		"Skills are available through progressive disclosure.",
		`Use skill_search to find and load specialized instructions when needed (${visibleCount} available).`,
		"Do not assume the full skill catalog is in the prompt; search by task or exact skill name first.",
	].join("\n");
}

export function estimateHarnessToolSchemaChars(tools: AgentTool<TSchema, unknown>[]): number {
	return JSON.stringify(
		tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
	).length;
}

function selectTools<TTool extends AgentTool<TSchema, unknown>>(
	tools: TTool[],
	params: ToolSearchParams,
	maxResults: number,
): TTool[] {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const exactMatches = (params.toolNames ?? [])
		.map((name) => byName.get(name))
		.filter((tool): tool is TTool => tool !== undefined);
	if (exactMatches.length > 0) return uniqueTools(exactMatches).slice(0, maxResults);

	const query = normalizeSearchText(params.query ?? "");
	if (!query) return [];
	return tools
		.map((tool) => ({ tool, score: scoreTool(tool, query) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
		.slice(0, maxResults)
		.map((entry) => entry.tool);
}

function formatToolSearchResult<TTool extends AgentTool<TSchema, unknown>>(
	matches: TTool[],
	params: ToolSearchParams,
): ToolReferenceContent[] | Array<{ type: "text"; text: string }> {
	if (matches.length === 0) {
		const query = params.query ? ` for "${params.query}"` : "";
		return [{ type: "text", text: `No OpenClaw tools matched${query}. Try a narrower query or exact toolNames.` }];
	}
	return matches.map((tool) => ({ type: "tool_reference", name: tool.name }));
}

function requestedSkillNames(params: SkillSearchParams): string[] {
	return mergeNames(params.name ? [params.name] : [], params.names ?? []);
}

function searchSkills<TSkill extends Skill>(skills: TSkill[], query: string | undefined, maxResults: number): TSkill[] {
	const normalizedQuery = normalizeSearchText(query ?? "");
	if (!normalizedQuery) return [];
	return skills
		.map((skill) => ({ skill, score: scoreText(`${skill.name} ${skill.description}`, normalizedQuery) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
		.slice(0, maxResults)
		.map((entry) => entry.skill);
}

function formatSkillSearchResult(skills: Skill[], includeContent: boolean): string {
	if (skills.length === 0) return "No OpenClaw skills matched. Try a narrower query or exact name.";
	if (includeContent) {
		return skills
			.map((skill) => [`# ${skill.name}`, `Path: ${skill.filePath}`, "", skill.content].join("\n"))
			.join("\n\n---\n\n");
	}
	return skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.filePath})`).join("\n");
}

function scoreTool(tool: AgentTool<TSchema, unknown>, query: string): number {
	const searchable = [tool.name, tool.label, tool.description, tool.searchHint ?? ""].join(" ");
	return scoreText(searchable, query);
}

function scoreText(value: string, query: string): number {
	const haystack = normalizeSearchText(value);
	const terms = query.split(" ").filter(Boolean);
	if (terms.length === 0) return 0;
	let score = 0;
	for (const term of terms) {
		if (haystack === term) score += 10;
		else if (haystack.includes(term)) score += 1;
		else return 0;
	}
	return score;
}

function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_:-]+/g, " ")
		.trim();
}

function uniqueTools<TTool extends AgentTool<TSchema, unknown>>(tools: TTool[]): TTool[] {
	const seen = new Set<string>();
	const result: TTool[] = [];
	for (const tool of tools) {
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		result.push(tool);
	}
	return result;
}

function mergeNames(...groups: string[][]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const group of groups) {
		for (const name of group) {
			if (!name || seen.has(name)) continue;
			seen.add(name);
			result.push(name);
		}
	}
	return result;
}
