import { describe, expect, test } from "vitest";
import { getBuiltinAgentDefinitions } from "../src/core/agents/definitions.ts";
import { resolveEffectiveTools } from "../src/core/agents/executor.ts";

const generalPurpose = getBuiltinAgentDefinitions().find((agent) => agent.id === "general");
// `explore` is a read-only agent that intentionally retains guarded read-only `bash`;
// `plan` is a read-only agent that denies bash outright. The fork removed `scout`
// because it overlapped `explore`.
const explore = getBuiltinAgentDefinitions().find((agent) => agent.id === "explore");
const plan = getBuiltinAgentDefinitions().find((agent) => agent.id === "plan");

describe("agent tool permissions", () => {
	test("child cannot gain inactive parent tools", () => {
		expect(() =>
			resolveEffectiveTools({
				parentActiveTools: ["agent", "read"],
				agent: generalPurpose ?? getBuiltinAgentDefinitions()[0],
				requestedTools: ["read", "bash"],
			}),
		).toThrow("Requested inactive tool(s): bash");
	});

	test("recursive agent is hard-denied", () => {
		const result = resolveEffectiveTools({
			parentActiveTools: ["agent", "read"],
			agent: generalPurpose ?? getBuiltinAgentDefinitions()[0],
			requestedTools: ["agent", "read"],
		});
		expect(result.effectiveTools).toEqual(["read"]);
		expect(result.deniedTools).toEqual(["agent"]);
	});

	test("bash-denying read-only agents do not receive bash even if parent has it", () => {
		const result = resolveEffectiveTools({
			parentActiveTools: ["agent", "read", "bash", "grep", "Glob", "ls"],
			agent: plan ?? getBuiltinAgentDefinitions()[0],
		});
		expect(result.effectiveTools).not.toContain("bash");
		expect(result.effectiveTools).toContain("read");
	});

	test("explore retains guarded read-only bash even though it is a read-only agent", () => {
		const result = resolveEffectiveTools({
			parentActiveTools: ["agent", "read", "bash", "grep", "Glob", "ls"],
			agent: explore ?? getBuiltinAgentDefinitions()[0],
		});
		expect(result.effectiveTools).toContain("bash");
		expect(result.effectiveTools).toEqual(["read", "bash", "grep", "Glob", "ls"]);
	});

	test("bash brings bash_output and bash_kill along when parent has them", () => {
		// Job-control trio: granting `bash` without the read/stop pair leaves
		// run_in_background:true bgIds dangling and surfaces "Tool bash_output not found".
		const result = resolveEffectiveTools({
			parentActiveTools: ["agent", "read", "bash", "bash_output", "bash_kill", "write"],
			agent: generalPurpose ?? getBuiltinAgentDefinitions()[0],
			requestedTools: ["bash", "write"],
		});
		expect(result.effectiveTools).toContain("bash");
		expect(result.effectiveTools).toContain("bash_output");
		expect(result.effectiveTools).toContain("bash_kill");
	});

	test("bash trio bundling respects denyTools", () => {
		// If an agent explicitly denies bash_output, bundling must not override.
		const agent = {
			...(generalPurpose ?? getBuiltinAgentDefinitions()[0]),
			denyTools: ["agent", "bash_output"],
		};
		const result = resolveEffectiveTools({
			parentActiveTools: ["agent", "bash", "bash_output", "bash_kill"],
			agent,
			requestedTools: ["bash", "bash_output", "bash_kill"],
		});
		expect(result.effectiveTools).toContain("bash");
		expect(result.effectiveTools).toContain("bash_kill");
		expect(result.effectiveTools).not.toContain("bash_output");
		expect(result.deniedTools).toContain("bash_output");
	});

	test("bash trio bundling does not synthesise tools the parent lacks", () => {
		// Defensive: never grant a child a tool the parent itself doesn't have active.
		const result = resolveEffectiveTools({
			parentActiveTools: ["agent", "bash"],
			agent: generalPurpose ?? getBuiltinAgentDefinitions()[0],
			requestedTools: ["bash"],
		});
		expect(result.effectiveTools).toEqual(["bash"]);
	});
});
