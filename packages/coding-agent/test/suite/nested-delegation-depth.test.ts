import { type Context, fauxAssistantMessage, fauxText, fauxToolCall } from "@valkyriweb/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { executeAgentTool } from "../../src/core/agents/executor.ts";
import {
	clearAgentRecentRunsForTests,
	formatAgentStatus,
	listAgentRecentRuns,
	resumeAgentRecentRun,
	waitForAgentRecentRun,
} from "../../src/core/agents/status.ts";
import { deleteExtensionProcessServiceForTests } from "../../src/core/extensions/loader.ts";
import { AGENTS_ENGINE_SERVICE_ID, type AgentEngine, type ExtensionAPI } from "../../src/index.ts";
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
		deleteExtensionProcessServiceForTests(AGENTS_ENGINE_SERVICE_ID);
	});

	function parentServices(harness: Harness, depth: number) {
		return {
			parentServices: {
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				authStorage: harness.authStorage,
				settingsManager: harness.settingsManager,
				modelRegistry: harness.session.modelRegistry,
				modelRuntime: harness.session.modelRuntime,
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
		const seen: Context[] = [];
		// Depth-first consumption of the shared faux queue:
		//   [0] depth-1 child delegates -> spawns a depth-2 grandchild
		//   [1] depth-2 grandchild stops (plain text, no further delegation)
		//   [2] depth-1 child resumes after the grandchild returns, then stops
		harness.setResponses([
			(context) => {
				seen.push(context);
				return delegateOnce();
			},
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
		// The depth-1 task genuinely had `agent` available (nesting enabled below cap).
		expect(details.runs[0]?.effectiveTools).toContain("agent");
		expect(JSON.stringify(seen[0]?.messages)).toContain("`agent` tool is available in this task");
		expect(JSON.stringify(seen[0]?.messages)).toContain("4 more nested level(s)");
		// ...and the agents view marks the nested delegation so it is visible in use.
		expect(formatAgentStatus()).toContain("\u21b3L1");
	});

	it("a leaf profile below the depth cap receives an unavailable reminder", async () => {
		const harness = await createHarness({ settings: { subagents: { maxDelegationDepth: 5 } } });
		harnesses.push(harness);
		const seen: Context[] = [];
		harness.setResponses([
			(context) => {
				seen.push(context);
				return fauxAssistantMessage("read-only result");
			},
		]);

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "explore", task: "inspect only" }] },
			parentServices(harness, 0),
		);

		expect(details.runs[0]?.effectiveTools).not.toContain("agent");
		expect(JSON.stringify(seen[0]?.messages)).toContain("`agent` tool is not available in this task");
		expect(JSON.stringify(seen[0]?.messages)).not.toContain("more nested level(s)");
	});

	it("a fork profile keeps the Agent schema but cannot delegate when the profile denies Agent", async () => {
		let processEngineRunCalled = false;
		const processEngine: AgentEngine = {
			snapshot() {
				throw new Error("snapshot is not expected");
			},
			async run() {
				processEngineRunCalled = true;
				return { mode: "single", status: "completed", runs: [], background: false };
			},
			async control() {
				return undefined;
			},
			async fork() {
				throw new Error("fork is not expected");
			},
		};
		const installProcessEngine = (pi: ExtensionAPI) => {
			pi.harness.provide(AGENTS_ENGINE_SERVICE_ID, processEngine, { scope: "process", replace: true });
		};
		const harness = await createHarness({
			settings: { subagents: { maxDelegationDepth: 5 } },
			extensionFactories: [installProcessEngine],
		});
		harnesses.push(harness);
		const seen: Context[] = [];
		let taskSession: AgentSession | undefined;
		harness.setResponses([
			(context) => {
				seen.push(context);
				return delegateOnce();
			},
			fauxAssistantMessage("handled unavailable Agent"),
		]);

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "worker", task: "stay in scope" }] },
			{
				...parentServices(harness, 0),
				parentSystemPrompt: "PARENT PROMPT",
				onChildSessionStart: (session) => {
					taskSession = session;
				},
			},
		);

		// Fork mode retains the caller's schema for cache identity, but the worker
		// profile denies Agent and therefore receives no execution engine.
		expect(details.runs[0]?.effectiveTools).toContain("agent");
		expect(JSON.stringify(seen[0]?.messages)).toContain("`agent` tool is not available in this task");
		expect((taskSession as unknown as { _agentToolServices?: unknown })?._agentToolServices).toBeUndefined();
		expect(details.runs[0]?.recentToolCalls.find((tool) => tool.name === "agent")?.isError).toBe(true);
		expect(processEngineRunCalled).toBe(false);
		expect(listAgentRecentRuns().filter((run) => run.depth > 0)).toHaveLength(0);
	});

	it("preserves a restricted fork while refreshing a lowered depth cap on resume", async () => {
		const harness = await createHarness({ settings: { subagents: { maxDelegationDepth: 5 } } });
		harnesses.push(harness);
		let resumedSession: AgentSession | undefined;
		let resumeContext = "";
		let resumeSystemPrompt = "";
		let resumeTools: string[] = [];
		harness.setResponses([fauxAssistantMessage("initial turn complete")]);

		const initial = await executeAgentTool(
			{
				mode: "single",
				background: true,
				persistent: true,
				tasks: [
					{
						agent: "general",
						task: "stay in scope across turns",
						context: "fork",
						tools: ["Agent", "Read"],
					},
				],
			},
			{
				...parentServices(harness, 0),
				parentSystemPrompt: "PARENT PROMPT",
				onChildSessionStart: (session) => {
					resumedSession = session;
				},
			},
		);
		expect(initial.runId).toBeTruthy();
		await waitForAgentRecentRun(initial.runId!);

		harness.settingsManager.applyOverrides({ subagents: { maxDelegationDepth: 0 } });
		harness.appendResponses([
			(context) => {
				resumeContext = JSON.stringify(context.messages.at(-1));
				resumeSystemPrompt = context.systemPrompt ?? "";
				resumeTools = context.tools?.map((tool) => tool.name) ?? [];
				return fauxAssistantMessage("finished after resume");
			},
		]);
		expect((await resumeAgentRecentRun(initial.runId!, "finish with the new cap")).ok).toBe(true);
		await waitForAgentRecentRun(initial.runId!);

		expect(resumeContext).toContain("## Course correction from the calling agent");
		expect(resumeContext).toMatch(/`agent` tool is not available/i);
		expect(resumeSystemPrompt).toBe("PARENT PROMPT");
		expect(resumeTools).toEqual(["read", "agent"]);
		expect((resumedSession as unknown as { _agentToolServices?: unknown })?._agentToolServices).toBeUndefined();
	});

	it("refreshes a resumed task to available when the depth cap is raised", async () => {
		const harness = await createHarness({ settings: { subagents: { maxDelegationDepth: 0 } } });
		harnesses.push(harness);
		let resumedSession: AgentSession | undefined;
		let resumeContext = "";
		harness.setResponses([fauxAssistantMessage("initial turn complete")]);

		const initial = await executeAgentTool(
			{
				mode: "single",
				background: true,
				persistent: true,
				tasks: [{ agent: "general", task: "stay in scope across turns", context: "fork" }],
			},
			{
				...parentServices(harness, 0),
				parentSystemPrompt: "PARENT PROMPT",
				onChildSessionStart: (session) => {
					resumedSession = session;
				},
			},
		);
		expect(initial.runId).toBeTruthy();
		await waitForAgentRecentRun(initial.runId!);

		harness.settingsManager.applyOverrides({ subagents: { maxDelegationDepth: 5 } });
		harness.appendResponses([
			(context) => {
				resumeContext = JSON.stringify(context.messages.at(-1));
				return fauxAssistantMessage("finished after resume");
			},
		]);
		expect((await resumeAgentRecentRun(initial.runId!, "finish with the new cap")).ok).toBe(true);
		await waitForAgentRecentRun(initial.runId!);

		expect(resumeContext).toContain("## Course correction from the calling agent");
		expect(resumeContext).toMatch(/`agent` tool is available/i);
		expect((resumedSession as unknown as { _agentToolServices?: unknown })?._agentToolServices).toBeDefined();
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

		// A real child session was created at depth 5 (callerDepth 4 + 1). The
		// Agent schema remains in the exact parent tool prefix for cache identity,
		// while its execution engine stays unbound so the leaf cannot nest again.
		expect(details.runs[0]?.sessionId).toBeTruthy();
		expect(details.runs[0]?.deniedTools).toContain("agent");
		expect(seen[0]?.tools?.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "agent"]);
		expect(JSON.stringify(seen[0]?.messages)).toContain("`agent` tool is not available in this task");
	});
});
