import type { AgentDefinition } from "./types.ts";

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
	{
		id: "general",
		description:
			"General Agent profile for tasks that must write files, run mutating shell commands, or combine investigation, implementation, and verification.",
		tools: "*",
		// No denyTools["agent"]: general is the one builtin allowed to nest. Whether it
		// can actually delegate is gated at runtime by `subagents.maxDelegationDepth`
		// (default 0 = no nesting) via the executor's engine-binding depth cap.
		model: "inherit",
		thinking: "inherit",
		defaultContext: "default",
		inheritProjectContext: true,
		inheritSkills: true,
		source: "builtin",
		prompt: `Complete the requested outcome within the stated scope using the available tools and skills.
Make the smallest complete change and avoid unrelated work or documentation.
Return the outcome, relevant paths, changes made, verification evidence, and any blockers.`,
	},
	{
		id: "worker",
		description: "Implementation profile for scoped coding tasks with known files and acceptance criteria.",
		tools: "*",
		denyTools: ["agent"],
		model: "inherit",
		thinking: "inherit",
		defaultContext: "fork",
		inheritProjectContext: true,
		inheritSkills: true,
		source: "builtin",
		prompt: `Implement the requested outcome within the supplied scope and constraints.
Make the smallest complete change, do not broaden the task, and verify the result against its acceptance criteria.
Return the outcome, changed paths, verification evidence, and any blockers.`,
	},
	{
		id: "explore",
		description:
			"Fast read-only investigation for multi-file search, code-path tracing, audits, and history inspection. Uses native read/search tools plus executor-enforced read-only bash. Runs without project instructions or preloaded skills, so the Agent task must supply relevant paths, non-obvious context, and desired breadth.",
		tools: [
			"read",
			"grep",
			"Glob",
			"bash",
			"SemanticGrep",
			"ast_grep_outline",
			"ast_grep_search",
			"skill_search",
			"skill",
		],
		denyTools: ["agent", "edit", "write"],
		model: "fast",
		thinking: "off",
		defaultContext: "none",
		cacheProfile: "stable",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "builtin",
		prompt: `Perform the requested read-only investigation using the available tools.
Do not create, modify, delete, move, or copy files; mutate system state; send network data; install software; or start or stop processes. The executor enforces these limits. If required evidence needs mutation, report the gap instead of working around the restriction.
Return concise findings with path:line evidence where available, mark inference clearly, state the searched scope, and identify unresolved gaps. Self-verify that the evidence covers the requested breadth.`,
	},
	{
		id: "decompose",
		description:
			"Fast read-only decomposition for broad or token-heavy work. Produces bounded tasks with evidence and validation requirements.",
		tools: ["read", "grep", "Glob"],
		denyTools: ["agent", "edit", "write", "bash"],
		model: "fast",
		thinking: "inherit",
		defaultContext: "none",
		cacheProfile: "stable",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "builtin",
		prompt: `Decompose the requested outcome into bounded tasks without modifying files or solving the whole task unless it is already small.
For each task, return its goal, inputs and context, dependencies, execution order or parallelism, expected report, acceptance criteria, and required evidence.
Include validation for the combined result and identify uncovered gaps.`,
	},
	{
		id: "plan",
		description: "Read-only planning profile for implementation strategy, integration points, risks, and validation.",
		tools: ["read", "grep", "Glob"],
		denyTools: ["agent", "edit", "write", "bash"],
		model: "inherit",
		thinking: "inherit",
		defaultContext: "slim",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "builtin",
		prompt: `Develop an implementation plan from the requirement and current architecture without modifying files or system state.
Return the integration points and load-bearing files, ordered implementation steps, risks, acceptance criteria, and validation evidence needed to prove the result. Identify unresolved decisions explicitly.`,
	},
	{
		id: "reviewer",
		description: "Read-only correctness and regression review profile with an explicit verdict.",
		tools: ["read", "grep", "Glob"],
		denyTools: ["agent", "edit", "write", "bash"],
		model: "inherit",
		thinking: "inherit",
		defaultContext: "default",
		inheritProjectContext: true,
		inheritSkills: true,
		source: "builtin",
		prompt: `Review the requested change against concrete files and available evidence without modifying the implementation.
Prioritize correctness, regressions, safety, acceptance criteria, and missing verification.
Return findings in severity order with path:line evidence, then close with exactly one final line:
VERDICT: PASS|FAIL|PARTIAL`,
	},
];

export function getBuiltinAgentDefinitions(): AgentDefinition[] {
	return BUILTIN_AGENT_DEFINITIONS.map((agent) => ({ ...agent, denyTools: [...(agent.denyTools ?? [])] }));
}
