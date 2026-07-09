import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type {
	AgentCacheProfile,
	AgentDefinition,
	AgentLoadDiagnostic,
	AgentSource,
	AgentToolList,
	ContextMode,
} from "./types.ts";

interface RawAgentFrontmatter extends Record<string, unknown> {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	denyTools?: unknown;
	model?: unknown;
	thinking?: unknown;
	context?: unknown;
	defaultContext?: unknown;
	cacheProfile?: unknown;
	inheritProjectContext?: unknown;
	inheritSkills?: unknown;
}

const CONTEXT_MODES = new Set<ContextMode>(["default", "fork", "slim", "none"]);
const CACHE_PROFILES = new Set<AgentCacheProfile>(["normal", "stable"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "adaptive", "inherit"]);

export function getUserAgentsDir(): string {
	return join(homedir(), ".pi", "agent", "agents");
}

export function findNearestProjectAgentsDir(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi", "agents");
		if (existsSync(candidate)) {
			try {
				if (statSync(candidate).isDirectory()) {
					return candidate;
				}
			} catch {
				return undefined;
			}
		}
		const parent = resolve(current, "..");
		if (parent === current) return undefined;
		current = parent;
	}
}

function parseStringList(
	value: unknown,
	field: string,
	path: string,
	diagnostics: AgentLoadDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
		return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	}
	diagnostics.push({
		level: "warning",
		message: `Ignoring invalid ${field}; expected comma-separated string or string array`,
		path,
	});
	return undefined;
}

function parseTools(value: unknown, path: string, diagnostics: AgentLoadDiagnostic[]): AgentToolList | undefined {
	if (value === undefined) return undefined;
	if (value === "*") return "*";
	return parseStringList(value, "tools", path, diagnostics);
}

function parseContext(value: unknown, path: string, diagnostics: AgentLoadDiagnostic[]): ContextMode | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && CONTEXT_MODES.has(value as ContextMode)) {
		return value as ContextMode;
	}
	diagnostics.push({ level: "warning", message: `Ignoring invalid context "${String(value)}"`, path });
	return undefined;
}

function parseCacheProfile(
	value: unknown,
	path: string,
	diagnostics: AgentLoadDiagnostic[],
): AgentCacheProfile | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && CACHE_PROFILES.has(value as AgentCacheProfile)) {
		return value as AgentCacheProfile;
	}
	diagnostics.push({ level: "warning", message: `Ignoring invalid cacheProfile "${String(value)}"`, path });
	return undefined;
}

function parseBoolean(
	value: unknown,
	field: string,
	path: string,
	diagnostics: AgentLoadDiagnostic[],
): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	diagnostics.push({ level: "warning", message: `Ignoring invalid ${field}; expected boolean`, path });
	return undefined;
}

function parseAgentFile(
	filePath: string,
	source: AgentSource,
): { agent?: AgentDefinition; diagnostics: AgentLoadDiagnostic[] } {
	const diagnostics: AgentLoadDiagnostic[] = [];
	let parsed: { frontmatter: RawAgentFrontmatter; body: string };
	try {
		parsed = parseFrontmatter<RawAgentFrontmatter>(readFileSync(filePath, "utf-8"));
	} catch (error) {
		return {
			diagnostics: [{ level: "warning", message: `Could not read agent file: ${String(error)}`, path: filePath }],
		};
	}

	const frontmatter = parsed.frontmatter;
	const id = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	const prompt = parsed.body.trim();

	if (!id || !description || !prompt) {
		return {
			diagnostics: [
				{
					level: "warning",
					message: "Skipping invalid agent file; name, description, and prompt body are required",
					path: filePath,
				},
			],
		};
	}

	const defaultContext = parseContext(frontmatter.defaultContext ?? frontmatter.context, filePath, diagnostics);
	const thinking =
		typeof frontmatter.thinking === "string" && THINKING_LEVELS.has(frontmatter.thinking)
			? (frontmatter.thinking as AgentDefinition["thinking"])
			: undefined;
	if (frontmatter.thinking !== undefined && thinking === undefined) {
		diagnostics.push({
			level: "warning",
			message: `Ignoring invalid thinking "${String(frontmatter.thinking)}"`,
			path: filePath,
		});
	}

	return {
		agent: {
			id,
			description,
			prompt,
			source,
			path: filePath,
			tools: parseTools(frontmatter.tools, filePath, diagnostics),
			denyTools: parseStringList(frontmatter.denyTools, "denyTools", filePath, diagnostics),
			model: typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined,
			thinking,
			defaultContext,
			cacheProfile: parseCacheProfile(frontmatter.cacheProfile, filePath, diagnostics),
			inheritProjectContext: parseBoolean(
				frontmatter.inheritProjectContext,
				"inheritProjectContext",
				filePath,
				diagnostics,
			),
			inheritSkills: parseBoolean(frontmatter.inheritSkills, "inheritSkills", filePath, diagnostics),
		},
		diagnostics,
	};
}

export async function loadAgentDefinitionsFromDirectory(
	dir: string,
	source: AgentSource,
): Promise<{ agents: AgentDefinition[]; diagnostics: AgentLoadDiagnostic[] }> {
	const diagnostics: AgentLoadDiagnostic[] = [];
	if (!existsSync(dir)) {
		return { agents: [], diagnostics };
	}

	let entries: string[];
	try {
		entries = readdirSync(dir)
			.filter((entry) => entry.endsWith(".md"))
			.sort();
	} catch (error) {
		return {
			agents: [],
			diagnostics: [{ level: "warning", message: `Could not read agents directory: ${String(error)}`, path: dir }],
		};
	}

	const agents: AgentDefinition[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const filePath = join(dir, entry);
		const result = parseAgentFile(filePath, source);
		diagnostics.push(...result.diagnostics);
		if (!result.agent) continue;
		if (seen.has(result.agent.id)) {
			diagnostics.push({
				level: "warning",
				message: `Skipping duplicate ${source} agent "${result.agent.id}"`,
				path: filePath,
			});
			continue;
		}
		seen.add(result.agent.id);
		agents.push(result.agent);
	}

	return { agents, diagnostics };
}
