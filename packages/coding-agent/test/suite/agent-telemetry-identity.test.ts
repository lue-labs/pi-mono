import type { AgentTool } from "@valkyriweb/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@valkyriweb/pi-ai";
import type { ExtensionAPI } from "@valkyriweb/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// A no-op tool the faux model can call so we can observe the emitted
// tool_call / tool_result events and the agent identity stamped on them.
const pingTool: AgentTool = {
	name: "ping",
	label: "Ping",
	description: "no-op",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
};

type CapturedIdentity = { toolName: string; agentId?: string; parentAgentId?: string };

describe("agent telemetry identity: agentId / parentAgentId on emitted tool events", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// Runs a single `ping` tool call through a session configured with the given
	// run identity, capturing the identity fields off the emitted events. This is
	// the exact path AgentSession uses for child sub-agent sessions; the executor
	// supplies `agentRunIdentity` from the run/parent-run ids.
	async function runOnePing(agentRunIdentity?: {
		runId?: string;
		parentRunId?: string;
	}): Promise<{ calls: CapturedIdentity[]; results: CapturedIdentity[] }> {
		const calls: CapturedIdentity[] = [];
		const results: CapturedIdentity[] = [];
		const harness = await createHarness({
			tools: [pingTool],
			agentRunIdentity,
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("tool_call", (event) => {
						calls.push({ toolName: event.toolName, agentId: event.agentId, parentAgentId: event.parentAgentId });
					});
					pi.on("tool_result", (event) => {
						results.push({
							toolName: event.toolName,
							agentId: event.agentId,
							parentAgentId: event.parentAgentId,
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ping", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return { calls, results };
	}

	it("stamps a sub-agent's run identity onto emitted tool_call and tool_result events", async () => {
		const { calls, results } = await runOnePing({ runId: "run-child", parentRunId: "run-parent" });

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ toolName: "ping", agentId: "run-child", parentAgentId: "run-parent" });
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual({ toolName: "ping", agentId: "run-child", parentAgentId: "run-parent" });
	});

	it("leaves agentId / parentAgentId undefined for the top-level session (not an agent run)", async () => {
		const { calls, results } = await runOnePing(undefined);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.agentId).toBeUndefined();
		expect(calls[0]?.parentAgentId).toBeUndefined();
		expect(results[0]?.agentId).toBeUndefined();
		expect(results[0]?.parentAgentId).toBeUndefined();
	});

	it("carries the run id but a null parent for a top-level child (parent has no run id)", async () => {
		const { calls, results } = await runOnePing({ runId: "run-root-child" });

		expect(calls[0]?.agentId).toBe("run-root-child");
		expect(calls[0]?.parentAgentId).toBeUndefined();
		expect(results[0]?.agentId).toBe("run-root-child");
		expect(results[0]?.parentAgentId).toBeUndefined();
	});
});
