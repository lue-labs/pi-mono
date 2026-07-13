import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../../src/core/agents/executor.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function executorOptions(harness: Harness) {
	return {
		parentServices: {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
		},
		parentActiveTools: ["read", "bash", "edit", "write", "agent"],
		parentSessionManager: harness.sessionManager,
		parentModel: harness.getModel(),
		parentThinkingLevel: "off" as const,
	};
}

describe("agent tool suite: parallel and chain", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("substitutes raw previous output when an earlier chain step writes file-only output", async () => {
		const childPrompts: string[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			(context: Context) => {
				childPrompts.push(getMessageText(context.messages.at(-1)));
				return fauxAssistantMessage("raw child content");
			},
			(context: Context) => {
				childPrompts.push(getMessageText(context.messages.at(-1)));
				return fauxAssistantMessage("second child complete");
			},
		]);

		const details = await executeAgentTool(
			{
				mode: "chain",
				tasks: [
					{ agent: "general", task: "step one", output: "reports/one.md", outputMode: "file" },
					{ agent: "general", task: "step two uses {previous}" },
				],
			},
			executorOptions(harness),
		);

		expect(details.runs.map((run) => run.memberId)).toEqual([`${details.runId}:1`, `${details.runId}:2`]);
		expect(childPrompts[1]).toContain("step two uses raw child content");
		expect(childPrompts[1]).not.toContain("Saved Agent output");
		expect(await readFile(join(harness.tempDir, "reports", "one.md"), "utf-8")).toBe("raw child content");
	});

	it("runs tasks[] through real child sessions", async () => {
		let childRuns = 0;
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			() => {
				childRuns += 1;
				return fauxAssistantMessage(`child ${childRuns}`);
			},
			() => {
				childRuns += 1;
				return fauxAssistantMessage(`child ${childRuns}`);
			},
		]);

		const details = await executeAgentTool(
			{
				mode: "parallel",
				tasks: [
					{ agent: "explore", task: "first" },
					{ agent: "explore", task: "second" },
				],
				concurrency: 2,
			},
			executorOptions(harness),
		);

		expect(childRuns).toBe(2);
		expect(details.runs.map((run) => run.memberId)).toEqual([`${details.runId}:1`, `${details.runId}:2`]);
		expect(details.runs.map((run) => run.task)).toEqual(["first", "second"]);
	});
});
