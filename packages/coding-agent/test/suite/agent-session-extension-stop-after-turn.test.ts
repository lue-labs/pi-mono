import type { AgentTool } from "@lue-labs/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@lue-labs/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function createTool(name: string, terminate = false): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: `${name} ok` }],
			details: { name },
			terminate,
		}),
	};
}

describe("AgentSession extension stop after turn", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("lets extensions park a mixed terminating tool batch after turn_end", async () => {
		const harness = await createHarness({
			tools: [createTool("background_work"), createTool("goal_wait", true)],
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event, ctx) => {
						if (event.toolResults.some((result) => result.toolName === "goal_wait")) {
							ctx.requestStopAfterTurn("goal_wait parked the active goal");
						}
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("background_work", {}), fauxToolCall("goal_wait", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("this follow-up turn must not run"),
		]);

		await harness.session.prompt("start background work then wait");

		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
		]);
		expect(harness.eventsOfType("turn_end")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
	});

	it("lets a tool's execute() park the run via requestStopAfterTurn, mid-turn", async () => {
		// pi-goal's goal_wait tool is registered via pi.registerTool() and calls
		// ctx.requestStopAfterTurn() directly from inside its own execute(), not
		// from a turn_end handler. Mirror that registration path here (ctx is only
		// injected as execute()'s 5th argument for extension-registered tools).
		//
		// Force the compaction/agent_end-phase race documented at
		// agent-session-concurrent.test.ts:307: AgentSession.isStreaming can be
		// false while a run is still genuinely in flight and a tool is executing
		// mid-turn. requestStopAfterTurn() must still latch in that window.
		let harnessRef: Harness | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "goal_wait",
						label: "goal_wait",
						description: "goal_wait test tool",
						parameters: Type.Object({}),
						async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
							(harnessRef?.session.agent.state as { isStreaming: boolean }).isStreaming = false;
							ctx.requestStopAfterTurn("goal_wait parked the active goal");
							return {
								content: [{ type: "text", text: "goal_wait ok" }],
								details: {},
							};
						},
					});
				},
			],
		});
		harnessRef = harness;
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("goal_wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("this follow-up turn must not run"),
		]);

		await harness.session.prompt("wait on the goal");

		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
	});
});
