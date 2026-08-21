import type { ThinkingLevel } from "@lue-labs/pi-agent-core";
import type { Api, Model } from "@lue-labs/pi-ai";
import type { ModelRegistry } from "../model-registry.ts";
import { parseModelPattern } from "../model-resolver.ts";
import { loadAgentChainRegistry } from "./chains.ts";
import { findNearestProjectAgentsDir, getUserAgentsDir } from "./loader.ts";
import { loadAgentRegistry } from "./registry.ts";
import type { AgentDefinition } from "./types.ts";

export interface AgentDoctorOptions {
	cwd: string;
	activeTools: string[];
	modelRegistry?: ModelRegistry;
	parentModel?: Model<Api>;
	parentThinkingLevel?: ThinkingLevel;
	runtimeServicesAvailable: boolean;
}

function formatTools(agent: AgentDefinition, activeTools: Set<string>): string[] {
	const warnings: string[] = [];
	const declared = agent.tools === "*" || agent.tools === undefined ? [] : agent.tools;
	const unavailable = declared.filter((tool) => !activeTools.has(tool));
	if (unavailable.length > 0) warnings.push(`- unavailable tools for ${agent.id}: ${unavailable.join(", ")}`);
	return warnings;
}

function formatModel(agent: AgentDefinition, modelRegistry?: ModelRegistry): string | undefined {
	if (!agent.model || agent.model === "inherit" || !modelRegistry) return undefined;
	const result = parseModelPattern(agent.model, modelRegistry.getAvailable());
	return result.model ? undefined : `- unavailable model for ${agent.id}: ${agent.model}`;
}

export async function buildAgentDoctorReport(options: AgentDoctorOptions): Promise<string> {
	const registry = await loadAgentRegistry({ cwd: options.cwd, agentScope: "both" });
	const chains = await loadAgentChainRegistry(options.cwd);
	const activeTools = new Set(options.activeTools);
	const userAgentsDir = getUserAgentsDir();
	const projectAgentsDir = findNearestProjectAgentsDir(options.cwd);
	const lines = [
		"Native agents doctor report",
		"",
		"Runtime",
		`- cwd: ${options.cwd}`,
		`- agent runtime services: ${options.runtimeServicesAvailable ? "available" : "unavailable"}`,
		`- active parent tools: ${options.activeTools.length > 0 ? options.activeTools.join(", ") : "none"}`,
		`- parent model: ${options.parentModel ? `${options.parentModel.provider}/${options.parentModel.id}` : "inherit/unavailable"}`,
		`- parent thinking: ${options.parentThinkingLevel ?? "inherit/unavailable"}`,
		"",
		"Discovery",
		`- user agents dir: ${userAgentsDir}`,
		`- project agents dir: ${projectAgentsDir ?? "not found"}`,
		"- project agents: require interactive confirmation when run with agentScope project/both",
		`- agents: ${registry.agents.length}`,
		`- chains: ${chains.chains.length}`,
		`- user chains dir: ${chains.userChainsDir}`,
		`- project chains dir: ${chains.projectChainsDir ?? "not found"}`,
	];
	const diagnostics = [...registry.diagnostics, ...chains.diagnostics];
	lines.push("", "Definition diagnostics");
	if (diagnostics.length === 0) lines.push("- none");
	else
		for (const diagnostic of diagnostics)
			lines.push(`- ${diagnostic.level}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`);
	lines.push("", "Agent config checks");
	const configWarnings = registry.agents.flatMap((agent) =>
		[...formatTools(agent, activeTools), formatModel(agent, options.modelRegistry)].filter((line): line is string =>
			Boolean(line),
		),
	);
	if (configWarnings.length === 0) lines.push("- none");
	else lines.push(...configWarnings);
	return lines.join("\n");
}
