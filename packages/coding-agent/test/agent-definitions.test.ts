import { describe, expect, test } from "vitest";
import { getBuiltinAgentDefinitions } from "../src/core/agents/definitions.ts";
import { findAgentDefinition } from "../src/core/agents/registry.ts";
import { createAgentToolDefinition } from "../src/core/tools/agent.ts";

const READ_ONLY_AGENTS = new Set(["decompose", "explore", "plan", "reviewer"]);

describe("built-in agent definitions", () => {
	test("include the MVP base agents with non-empty prompts", () => {
		const agents = getBuiltinAgentDefinitions();
		expect(agents.map((agent) => agent.id).sort()).toEqual([
			"decompose",
			"explore",
			"general",
			"plan",
			"reviewer",
			"worker",
		]);
		for (const agent of agents) {
			expect(agent.description.trim()).not.toBe("");
			expect(agent.prompt.trim()).not.toBe("");
		}
	});

	test("read-only agents do not allow mutating tools or recursive agent", () => {
		for (const agent of getBuiltinAgentDefinitions()) {
			if (!READ_ONLY_AGENTS.has(agent.id)) continue;
			expect(agent.denyTools).toEqual(expect.arrayContaining(["agent", "edit", "write", "bash"]));
			expect(agent.tools).toEqual(["read", "grep", "find", "ls"]);
		}
	});

	test("stable agents use no dynamic child context", () => {
		const agents = new Map(getBuiltinAgentDefinitions().map((agent) => [agent.id, agent]));
		expect(agents.get("decompose")).toMatchObject({ cacheProfile: "stable", defaultContext: "none", model: "fast" });
		expect(agents.get("explore")).toMatchObject({
			cacheProfile: "stable",
			defaultContext: "none",
			model: "fast",
			thinking: "off",
		});
	});

	test("built-in prompts require structured output", () => {
		const agents = new Map(getBuiltinAgentDefinitions().map((agent) => [agent.id, agent.prompt]));
		expect(agents.get("decompose")).toContain("### Decomposition");
		expect(agents.get("decompose")).toContain("### Execution Shape");
		expect(agents.get("plan")).toContain("### Critical Files for Implementation");
		expect(agents.get("explore")).toContain("### Findings");
		expect(agents.get("explore")).toContain("### Open Questions");
		expect(agents.get("reviewer")).toContain("VERDICT: PASS|FAIL|PARTIAL");
	});

	test("agent tool guidance lists explore with routing dials", () => {
		const agentTool = createAgentToolDefinition("/tmp");
		const joined = agentTool.promptGuidelines?.join("\n") ?? "";
		// Routing pair lifted from Claude Code: positive trigger + negative foil.
		expect(joined).toMatch(/Reach for this when/i);
		expect(joined).toMatch(/single-fact lookup where you already know/i);
		// Anti-duplication clause.
		expect(joined).toMatch(/don't also run it yourself/i);
		// Explore listed with breadth dial.
		const exploreLine = agentTool.promptGuidelines?.find((line) => line.includes("`explore`"));
		expect(exploreLine).toContain("no transcript/project context/skills");
		expect(exploreLine).toMatch(/quick \| medium \| very thorough/);
	});

	test("built-in agent casing aliases resolve when unique", () => {
		const registry = { agents: getBuiltinAgentDefinitions(), diagnostics: [] };
		expect(findAgentDefinition(registry, "Explore")?.id).toBe("explore");
		expect(findAgentDefinition(registry, "Plan")?.id).toBe("plan");
	});

	test("exact agent id wins before case-insensitive fallback", () => {
		const agents = [
			...getBuiltinAgentDefinitions(),
			{ ...getBuiltinAgentDefinitions()[0], id: "Explore", source: "project" as const },
		];
		const registry = { agents, diagnostics: [] };
		expect(findAgentDefinition(registry, "Explore")?.id).toBe("Explore");
	});

	test("worker denies recursive agent; general may nest (runtime depth-gated)", () => {
		const byId = new Map(getBuiltinAgentDefinitions().map((agent) => [agent.id, agent]));
		// worker is a leaf executor — never delegates.
		expect(byId.get("worker")?.denyTools ?? []).toContain("agent");
		// general is the one built-in allowed to fan out; whether it actually can is
		// gated at runtime by subagents.maxDelegationDepth (default 0 = no nesting),
		// so it must NOT statically deny the agent tool.
		expect(byId.get("general")?.denyTools ?? []).not.toContain("agent");
	});
});
