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
			// `explore` intentionally keeps read-only `bash` (git log/status/diff, cat,
			// gh pr view) gated to non-mutating commands by EXPLORE_BASH_POLICY in the
			// executor; the other read-only agents deny bash outright.
			if (agent.id === "explore") {
				expect(agent.denyTools).toEqual(expect.arrayContaining(["agent", "edit", "write"]));
				expect(agent.denyTools).not.toContain("bash");
				expect(agent.tools).toEqual([
					"read",
					"grep",
					"Glob",
					"bash",
					"SemanticGrep",
					"ast_grep_outline",
					"ast_grep_search",
					"skill_search",
					"skill",
				]);
			} else {
				expect(agent.denyTools).toEqual(expect.arrayContaining(["agent", "edit", "write", "bash"]));
				expect(agent.tools).toEqual(["read", "grep", "Glob"]);
			}
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

	test("built-in prompts are concise, identity-neutral outcome contracts", () => {
		for (const agent of getBuiltinAgentDefinitions()) {
			const modelFacingText = `${agent.description}\n${agent.prompt}`;
			expect(modelFacingText).not.toMatch(/\b(child|subagent|parent|invoker)\b/i);
			expect(agent.prompt.length).toBeLessThan(1400);
			expect(agent.prompt).toMatch(/return|report/i);
			expect(agent.prompt).toMatch(/verify|validation|evidence/i);
		}
		expect(getBuiltinAgentDefinitions().find((agent) => agent.id === "reviewer")?.prompt).toContain(
			"VERDICT: PASS|FAIL|PARTIAL",
		);
	});

	test("agent tool guidance is a concise capability and outcome contract", () => {
		const agentTool = createAgentToolDefinition("/tmp");
		const joined = agentTool.promptGuidelines?.join("\n") ?? "";
		const modelFacingText = [
			agentTool.description,
			agentTool.promptSnippet,
			joined,
			JSON.stringify(agentTool.parameters),
		].join("\n");
		expect(modelFacingText).not.toMatch(/\b(child|parent|invoker)\b|\bsubagent\b/i);
		expect(joined.length).toBeLessThan(3500);
		expect(joined).toMatch(/desired outcome/i);
		expect(joined).toMatch(/file structure/i);
		expect(joined).toMatch(/tools.*skills/i);
		expect(joined).toMatch(/acceptance criteria/i);
		expect(joined).toMatch(/expected report/i);
		expect(joined).toMatch(/self-verif/i);
		expect(joined).toMatch(/choose.*method|method.*choose/i);
		expect(joined).toMatch(/single known file, symbol, or value/i);
		expect(joined).toMatch(/do not duplicate an investigation/i);
		expect(joined).toMatch(/`explore` — read-only search with read-only bash/i);
		expect(joined).toMatch(/`context: "fork"` is a permissive self-fork that preserves the caller transcript/i);
		expect(joined).not.toMatch(/≤3 files|explore@fast|worker@medium|Delegation-first/i);
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
