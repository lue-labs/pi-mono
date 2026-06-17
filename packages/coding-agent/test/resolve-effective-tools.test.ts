import { describe, expect, it } from "vitest";
import { canDelegateAtDepth, getMaxDelegationDepth, resolveEffectiveTools } from "../src/core/agents/executor.ts";
import type { AgentDefinition } from "../src/core/agents/types.ts";

function agent(partial: Partial<AgentDefinition>): AgentDefinition {
	return {
		id: "test",
		description: "",
		prompt: "",
		source: "builtin",
		...partial,
	} as AgentDefinition;
}

// Built-in agent definitions declare lowercase core tool names (read/grep/bash).
// A profile may register the same capabilities under aliased names — e.g. Luke's
// native-tool-overrides exposes Read/Grep/Bash and deferred Find/Ls. Resolution
// must match by capability, not exact string, or every built-in agent runs with
// ZERO tools and the model emits tool calls as literal text (0 tool uses).
describe("resolveEffectiveTools capability matching", () => {
	const capitalizedParent = [
		"Read",
		"Bash",
		"Edit",
		"Write",
		"Agent",
		"Grep",
		"Find",
		"Ls",
		"BashOutput",
		"KillShell",
	];

	it("resolves a lowercase allow-list against capitalized active aliases", () => {
		const { effectiveTools } = resolveEffectiveTools({
			parentActiveTools: capitalizedParent,
			agent: agent({ tools: ["read", "grep", "find", "ls", "bash"], denyTools: ["agent", "edit", "write"] }),
		});
		expect(effectiveTools).toEqual(expect.arrayContaining(["Read", "Grep", "Find", "Ls", "Bash"]));
		expect(effectiveTools).not.toContain("Edit");
		expect(effectiveTools).not.toContain("Write");
		expect(effectiveTools).not.toContain("Agent");
	});

	it("bundles bash job-control companions under their aliased names", () => {
		const { effectiveTools } = resolveEffectiveTools({
			parentActiveTools: capitalizedParent,
			agent: agent({ tools: ["read", "bash"] }),
		});
		expect(effectiveTools).toContain("Bash");
		expect(effectiveTools).toContain("BashOutput");
		expect(effectiveTools).toContain("KillShell");
	});

	it("excludes bash for a read-only agent", () => {
		const { effectiveTools } = resolveEffectiveTools({
			parentActiveTools: capitalizedParent,
			agent: agent({ tools: ["read", "grep", "find", "ls"], denyTools: ["edit", "write", "bash", "agent"] }),
		});
		expect(effectiveTools).toEqual(expect.arrayContaining(["Read", "Grep", "Find", "Ls"]));
		expect(effectiveTools).not.toContain("Bash");
	});

	it("matches case-insensitively against capitalized registry names", () => {
		const { effectiveTools } = resolveEffectiveTools({
			parentActiveTools: ["Read", "Grep", "Find"],
			agent: agent({ tools: ["read", "grep", "find"] }),
		});
		expect(effectiveTools).toEqual(expect.arrayContaining(["Read", "Grep", "Find"]));
	});

	it("denies the agent tool by default even with a wildcard allow-list", () => {
		const { effectiveTools } = resolveEffectiveTools({
			parentActiveTools: capitalizedParent,
			agent: agent({ tools: "*" }),
		});
		expect(effectiveTools).not.toContain("Agent");
		expect(effectiveTools).toContain("Read");
	});

	it("includes the agent tool when nested delegation is allowed", () => {
		const { effectiveTools } = resolveEffectiveTools({
			parentActiveTools: capitalizedParent,
			agent: agent({ tools: "*" }),
			allowAgentDelegation: true,
		});
		expect(effectiveTools).toContain("Agent");
	});

	it("still honours an explicit per-agent agent denial even when delegation is allowed", () => {
		const { effectiveTools } = resolveEffectiveTools({
			parentActiveTools: capitalizedParent,
			agent: agent({ tools: "*", denyTools: ["agent"] }),
			allowAgentDelegation: true,
		});
		expect(effectiveTools).not.toContain("Agent");
	});
});

describe("nested-delegation depth gate", () => {
	it("always allows the top-level session (depth 0) regardless of cap", () => {
		expect(canDelegateAtDepth(0, 0)).toBe(true);
		expect(canDelegateAtDepth(0, 5)).toBe(true);
	});

	it("denies any nesting when the cap is 0 (upstream default)", () => {
		expect(canDelegateAtDepth(1, 0)).toBe(false);
		expect(canDelegateAtDepth(2, 0)).toBe(false);
	});

	it("allows nested children strictly below the cap", () => {
		expect(canDelegateAtDepth(1, 5)).toBe(true);
		expect(canDelegateAtDepth(4, 5)).toBe(true);
		expect(canDelegateAtDepth(5, 5)).toBe(false);
		expect(canDelegateAtDepth(6, 5)).toBe(false);
	});

	const mgr = (maxDelegationDepth: unknown) =>
		({ getSubagentSettings: () => ({ maxDelegationDepth }) }) as unknown as Parameters<
			typeof getMaxDelegationDepth
		>[0];

	it("defaults to 0 for missing/invalid/non-positive config", () => {
		expect(getMaxDelegationDepth(mgr(undefined))).toBe(0);
		expect(getMaxDelegationDepth(mgr(0))).toBe(0);
		expect(getMaxDelegationDepth(mgr(-3))).toBe(0);
		expect(getMaxDelegationDepth(mgr("5"))).toBe(0);
		expect(getMaxDelegationDepth(mgr(Number.NaN))).toBe(0);
	});

	it("reads and clamps a positive cap", () => {
		expect(getMaxDelegationDepth(mgr(5))).toBe(5);
		expect(getMaxDelegationDepth(mgr(3.9))).toBe(3);
		expect(getMaxDelegationDepth(mgr(999))).toBe(16);
	});
});
