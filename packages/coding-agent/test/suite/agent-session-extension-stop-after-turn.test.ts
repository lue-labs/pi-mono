import type { AgentTool } from "@valkyriweb/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@valkyriweb/pi-ai";
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
});
