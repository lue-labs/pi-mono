import { type Context, fauxAssistantMessage, fauxText, fauxToolCall } from "@valkyriweb/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../../src/core/agents/executor.ts";
import { clearAgentRecentRunsForTests, formatAgentStatus, listAgentRecentRuns } from "../../src/core/agents/status.ts";
import { createHarness, type Harness } from "./harness.ts";

// End-to-end smoke for nested sub-agent delegation: real child AgentSessions are
// spawned through a faux model, so this exercises the depth threading, the
// per-depth `agent`-tool gate, and the agents-view rendering together — the
// pieces the pure unit tests cover only in isolation.
describe("agent tool suite: nested delegation depth", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => clearAgentRecentRunsForTests());
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function parentServices(harness: Harness, depth: number) {
		return {
			parentServices: {
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				authStorage: harness.authStorage,
				settingsManager: harness.settingsManager,
				modelRegistry: harness.session.modelRegistry,
				depth,
			},
			parentActiveTools: ["read", "bash", "edit", "write", "agent"],
			parentSessionManager: harness.sessionManager,
			parentModel: harness.getModel(),
			parentThinkingLevel: "off" as const,
		};
	}

	// One assistant turn that delegates a single sub-task to a `general` child.
	const delegateOnce = () =>
		fauxAssistantMessage(
			[fauxText("delegating deeper"), fauxToolCall("agent", { agent: "general", task: "go deeper" })],
			{
				stopReason: "toolUse",
			},
		);

	it("nests real child sessions and surfaces the nesting in the agents view (cap 5)", async () => {
		const harness = await createHarness({ settings: { subagents: { maxDelegationDepth: 5 } } });
		harnesses.push(harness);
		// Depth-first consumption of the shared faux queue:
		//   [0] depth-1 child delegates -> spawns a depth-2 grandchild
		//   [1] depth-2 grandchild stops (plain text, no further delegation)
		//   [2] depth-1 child resumes after the grandchild returns, then stops
		harness.setResponses([
			delegateOnce(),
			fauxAssistantMessage("leaf reached"),
			fauxAssistantMessage("depth-1 done"),
		]);

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "general", task: "level 1" }] },
			parentServices(harness, 0),
		);

		// Two delegation runs were recorded: the depth-0 invocation and the depth-1
		// child's own (nested) delegation. Real recursion actually chained.
		const depths = listAgentRecentRuns()
			.map((run) => run.depth)
			.sort();
		expect(depths).toContain(0);
		expect(depths).toContain(1);
		// The depth-1 child genuinely had `agent` available (nesting enabled below cap).
		expect(details.runs[0]?.effectiveTools).toContain("agent");
		// ...and the agents view marks the nested delegation so it is visible in use.
		expect(formatAgentStatus()).toContain("\u21b3L1");
	});

	it("a depth-4 caller spawns a real depth-5 leaf that cannot delegate further", async () => {
		const harness = await createHarness({ settings: { subagents: { maxDelegationDepth: 5 } } });
		harnesses.push(harness);
		const seen: Context[] = [];
		harness.setResponses([
			(context) => {
				seen.push(context);
				return fauxAssistantMessage("depth-5 leaf");
			},
		]);

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "general", task: "deepest" }] },
			parentServices(harness, 4),
		);

		// A real child session was created at depth 5 (callerDepth 4 + 1); because
		// canDelegateAtDepth(5, 5) === false it is denied `agent` and cannot nest on.
		expect(details.runs[0]?.sessionId).toBeTruthy();
		expect(details.runs[0]?.deniedTools).toContain("agent");
		expect(seen[0]?.tools?.map((tool) => tool.name)).not.toContain("agent");
	});
});
