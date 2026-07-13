import { describe, expect, it } from "vitest";
import { type AgentEngine, runWithAgentEngineResolver } from "../../../src/core/agents/engine.ts";
import type { AgentToolExecutionInput } from "../../../src/core/agents/executor.ts";
import { createUppercaseAgentToolDefinition } from "../../../src/core/tools/agent.ts";

describe("#283 custom Agent alias engine resolution", () => {
	it("uses the calling session engine when the alias has no runtime service", async () => {
		let receivedInput: AgentToolExecutionInput | undefined;
		// This fake is the session engine seam; the real child executor is outside this resolution regression.
		const sessionEngine: AgentEngine = {
			async run(input) {
				receivedInput = input;
				return { mode: "single", status: "completed", runs: [] };
			},
			async control() {
				return undefined;
			},
			async fork() {
				throw new Error("not used");
			},
			snapshot() {
				throw new Error("not used");
			},
		};
		const tool = createUppercaseAgentToolDefinition(process.cwd(), {
			// Mirrors a third-party alias whose runtime-service lookup returns no engine.
			getEngine: () => undefined,
		});

		const result = await runWithAgentEngineResolver(
			() => sessionEngine,
			() =>
				tool.execute(
					"agent-call",
					{ subagent_type: "explore", prompt: "Map the execution path" },
					undefined,
					undefined,
					{ hasUI: false } as Parameters<typeof tool.execute>[4],
				),
		);

		expect(receivedInput).toMatchObject({
			mode: "single",
			tasks: [{ agent: "explore", task: "Map the execution path" }],
		});
		expect(result.details).toMatchObject({ mode: "single", status: "completed" });
	});
});
