import { describe, expect, it } from "vitest";
import {
	type AgentExecutorOptions,
	type AgentToolExecutionInput,
	canDelegateAtDepth,
	executeAgentTool,
	getMaxDelegationDepth,
	resolveEffectiveTools,
} from "../src/core/agents/executor.ts";
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

// Built-in agent definitions declare canonical core tool names (read/grep/Glob/bash).
// A profile may register the same capabilities under aliased names — e.g. Luke's
// native-tool-overrides exposes Read/Grep/Bash and deferred Glob. Resolution
// must match by capability, not exact string, or every built-in agent runs with
// ZERO tools and the model emits tool calls as literal text (0 tool uses).
describe("resolveEffectiveTools capability matching", () => {
	const capitalizedParent = ["Read", "Bash", "Edit", "Write", "Agent", "Grep", "Glob", "BashOutput", "KillShell"];

	it("resolves a lowercase allow-list against capitalized active aliases", () => {
		const { effectiveTools } = resolveEffectiveTools({
			parentActiveTools: capitalizedParent,
			agent: agent({ tools: ["read", "grep", "Glob", "bash"], denyTools: ["agent", "edit", "write"] }),
		});
		expect(effectiveTools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Bash"]));
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
			agent: agent({ tools: ["read", "grep", "Glob"], denyTools: ["edit", "write", "bash", "agent"] }),
		});
		expect(effectiveTools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
		expect(effectiveTools).not.toContain("Bash");
	});

	it("matches case-insensitively against capitalized registry names", () => {
		const { effectiveTools } = resolveEffectiveTools({
			parentActiveTools: ["Read", "Grep", "Glob"],
			agent: agent({ tools: ["read", "grep", "glob"] }),
		});
		expect(effectiveTools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
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

// The `canDelegateAtDepth` truth table above guards the pure predicate. This block
// guards the *runtime* gate in `executeAgentTool`, which is the ONLY boundary that
// covers fork-mode children: a fork child inherits the parent's full tool list
// (including the `agent` schema), bypassing `resolveEffectiveTools`. Without this
// gate a fork child at/over the cap could recurse unbounded. The gate throws before
// any child session is created, so it is deterministic with a minimal fixture.
describe("executeAgentTool runtime nesting gate (fork-mode coverage)", () => {
	const options = (callerDepth: number, cap: number): AgentExecutorOptions =>
		({
			parentServices: {
				cwd: "/tmp",
				agentDir: "/tmp",
				authStorage: {},
				settingsManager: { getSubagentSettings: () => ({ maxDelegationDepth: cap }) },
				modelRegistry: {},
				depth: callerDepth,
			},
			parentActiveTools: [],
			parentSessionManager: {},
			parentModel: undefined,
			parentThinkingLevel: "medium",
		}) as unknown as AgentExecutorOptions;
	const input = {
		mode: "single",
		tasks: [{ agent: "echo", task: "noop" }],
		background: false,
	} as unknown as AgentToolExecutionInput;

	it("throws for a fork child at the cap (depth 5, cap 5)", async () => {
		await expect(executeAgentTool(input, options(5, 5))).rejects.toThrow(/not permitted at depth 5/);
	});

	it("throws for a fork child past the cap (depth 6, cap 5)", async () => {
		await expect(executeAgentTool(input, options(6, 5))).rejects.toThrow(/not permitted at depth 6/);
	});

	it("throws for any nesting when the cap is the default 0 (depth 1, cap 0)", async () => {
		await expect(executeAgentTool(input, options(1, 0))).rejects.toThrow(/not permitted at depth 1/);
	});

	// Depth 0 (top level) is always allowed by the short-circuit; that branch is
	// covered side-effect-free by the `canDelegateAtDepth(0, 0) === true` truth-table
	// test above, so we do not drive a real run here.
});
