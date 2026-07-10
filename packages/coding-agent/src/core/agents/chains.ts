import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTaskConfig } from "./types.ts";

export interface AgentChainDefinition {
	name: string;
	description?: string;
	source: "user" | "project";
	path: string;
	chain: AgentTaskConfig[];
	concurrency?: number;
	context?: AgentTaskConfig["context"];
	model?: string;
	thinking?: AgentTaskConfig["thinking"];
	tools?: string[];
	outputMode?: AgentTaskConfig["outputMode"];
}

export interface AgentChainDiagnostic {
	level: "warning" | "error";
	message: string;
	path?: string;
}

export interface AgentChainRegistry {
	chains: AgentChainDefinition[];
	diagnostics: AgentChainDiagnostic[];
	userChainsDir: string;
	projectChainsDir?: string;
}

interface RawAgentChainDefinition {
	name?: unknown;
	description?: unknown;
	chain?: unknown;
	concurrency?: unknown;
	context?: unknown;
	model?: unknown;
	thinking?: unknown;
	tools?: unknown;
	outputMode?: unknown;
}

const CONTEXT_MODES = new Set(["default", "fork", "slim", "none"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "adaptive"]);
const OUTPUT_MODES = new Set(["inline", "file", "both"]);

export function getUserChainsDir(): string {
	return join(homedir(), ".pi", "agent", "chains");
}

export function findNearestProjectChainsDir(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi", "chains");
		if (existsSync(candidate)) {
			try {
				if (statSync(candidate).isDirectory()) return candidate;
			} catch {
				return undefined;
			}
		}
		const parent = resolve(current, "..");
		if (parent === current) return undefined;
		current = parent;
	}
}

function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
	return value.map((entry) => entry.trim()).filter(Boolean);
}

function parseChainFile(
	path: string,
	source: "user" | "project",
): { chain?: AgentChainDefinition; diagnostics: AgentChainDiagnostic[] } {
	const diagnostics: AgentChainDiagnostic[] = [];
	let raw: RawAgentChainDefinition;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8")) as RawAgentChainDefinition;
	} catch (error) {
		return { diagnostics: [{ level: "warning", message: `Could not parse chain JSON: ${String(error)}`, path }] };
	}
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (!name || !Array.isArray(raw.chain) || raw.chain.length === 0) {
		return {
			diagnostics: [
				{ level: "warning", message: "Skipping invalid chain; name and non-empty chain are required", path },
			],
		};
	}
	const chain: AgentTaskConfig[] = [];
	for (const [index, step] of raw.chain.entries()) {
		if (!step || typeof step !== "object") {
			diagnostics.push({ level: "warning", message: `Skipping invalid step ${index + 1}; expected object`, path });
			continue;
		}
		const item = step as Record<string, unknown>;
		const preferredAgent = typeof item.subagent_type === "string" ? item.subagent_type : undefined;
		const legacyAgent = typeof item.agent === "string" ? item.agent : undefined;
		const preferredTask = typeof item.prompt === "string" ? item.prompt : undefined;
		const legacyTask = typeof item.task === "string" ? item.task : undefined;
		if (preferredAgent && legacyAgent && preferredAgent !== legacyAgent) {
			diagnostics.push({
				level: "warning",
				message: `Skipping invalid step ${index + 1}; subagent_type and agent differ`,
				path,
			});
			continue;
		}
		if (preferredTask && legacyTask && preferredTask !== legacyTask) {
			diagnostics.push({
				level: "warning",
				message: `Skipping invalid step ${index + 1}; prompt and task differ`,
				path,
			});
			continue;
		}
		const agent = (preferredAgent ?? legacyAgent ?? "").trim();
		const task = preferredTask ?? legacyTask ?? "";
		if (!agent || !task) {
			diagnostics.push({
				level: "warning",
				message: `Skipping invalid step ${index + 1}; subagent_type and prompt are required (legacy agent and task are accepted)`,
				path,
			});
			continue;
		}
		chain.push({
			agent,
			task,
			description: typeof item.description === "string" ? item.description : undefined,
			context:
				typeof item.context === "string" && CONTEXT_MODES.has(item.context)
					? (item.context as AgentTaskConfig["context"])
					: undefined,
			extraContext: typeof item.extraContext === "string" ? item.extraContext : undefined,
			model: typeof item.model === "string" ? item.model : undefined,
			tools: parseStringArray(item.tools),
			thinking:
				typeof item.thinking === "string" && THINKING_LEVELS.has(item.thinking)
					? (item.thinking as AgentTaskConfig["thinking"])
					: undefined,
			output: typeof item.output === "string" ? item.output : undefined,
			outputMode:
				typeof item.outputMode === "string" && OUTPUT_MODES.has(item.outputMode)
					? (item.outputMode as AgentTaskConfig["outputMode"])
					: undefined,
		});
	}
	if (chain.length === 0)
		diagnostics.push({ level: "warning", message: "Skipping invalid chain; no valid steps", path });
	return {
		chain:
			chain.length > 0
				? {
						name,
						description: typeof raw.description === "string" ? raw.description : undefined,
						source,
						path,
						chain,
						concurrency: typeof raw.concurrency === "number" ? raw.concurrency : undefined,
						context:
							typeof raw.context === "string" && CONTEXT_MODES.has(raw.context)
								? (raw.context as AgentTaskConfig["context"])
								: undefined,
						model: typeof raw.model === "string" ? raw.model : undefined,
						thinking:
							typeof raw.thinking === "string" && THINKING_LEVELS.has(raw.thinking)
								? (raw.thinking as AgentTaskConfig["thinking"])
								: undefined,
						tools: parseStringArray(raw.tools),
						outputMode:
							typeof raw.outputMode === "string" && OUTPUT_MODES.has(raw.outputMode)
								? (raw.outputMode as AgentTaskConfig["outputMode"])
								: undefined,
					}
				: undefined,
		diagnostics,
	};
}

function loadChainsFromDirectory(
	dir: string,
	source: "user" | "project",
): { chains: AgentChainDefinition[]; diagnostics: AgentChainDiagnostic[] } {
	if (!existsSync(dir)) return { chains: [], diagnostics: [] };
	const chains: AgentChainDefinition[] = [];
	const diagnostics: AgentChainDiagnostic[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir)
			.filter((entry) => entry.endsWith(".json"))
			.sort();
	} catch (error) {
		return {
			chains,
			diagnostics: [{ level: "warning", message: `Could not read chains directory: ${String(error)}`, path: dir }],
		};
	}
	const seen = new Set<string>();
	for (const entry of entries) {
		const result = parseChainFile(join(dir, entry), source);
		diagnostics.push(...result.diagnostics);
		if (!result.chain) continue;
		if (seen.has(result.chain.name)) {
			diagnostics.push({
				level: "warning",
				message: `Skipping duplicate ${source} chain "${result.chain.name}"`,
				path: result.chain.path,
			});
			continue;
		}
		seen.add(result.chain.name);
		chains.push(result.chain);
	}
	return { chains, diagnostics };
}

export async function loadAgentChainRegistry(cwd: string): Promise<AgentChainRegistry> {
	const userChainsDir = getUserChainsDir();
	const projectChainsDir = findNearestProjectChainsDir(cwd);
	const user = loadChainsFromDirectory(userChainsDir, "user");
	const project = projectChainsDir
		? loadChainsFromDirectory(projectChainsDir, "project")
		: { chains: [], diagnostics: [] };
	const byName = new Map<string, AgentChainDefinition>();
	for (const chain of user.chains) byName.set(chain.name, chain);
	for (const chain of project.chains) byName.set(chain.name, chain);
	return {
		chains: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
		diagnostics: [...user.diagnostics, ...project.diagnostics],
		userChainsDir,
		projectChainsDir,
	};
}

export function findAgentChain(registry: AgentChainRegistry, name: string): AgentChainDefinition | undefined {
	return registry.chains.find((chain) => chain.name === name);
}
