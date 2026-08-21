import { fauxAssistantMessage } from "@lue-labs/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../../../src/core/agents/executor.ts";
import { resumeAgentRecentRun, waitForAgentRecentRun } from "../../../src/core/agents/status.ts";
import type { AgentBackgroundCompletion } from "../../../src/core/agents/types.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("background agent lifecycle notification", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reports an intentional persistent park as idle, not interrupted", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("persistent child ready"),
			() => fauxAssistantMessage("persistent child ready again"),
		]);

		const completions: AgentBackgroundCompletion[] = [];
		const details = await executeAgentTool(
			{
				mode: "single",
				background: true,
				persistent: true,
				tasks: [{ agent: "general", task: "observe and wait" }],
			},
			{
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
				parentThinkingLevel: "off",
				onBackgroundTerminal: (notification) => completions.push(notification),
			},
		);

		const finalRun = await waitForAgentRecentRun(details.runId as string);
		expect(finalRun).toMatchObject({ status: "interrupted", parked: true });
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		expect(completions).toHaveLength(1);
		expect(completions[0]).toMatchObject({ status: "idle", parked: true });
		expect(completions[0]?.summary).toContain("is idle");
		expect(completions[0]?.summary).not.toContain("interrupted");

		const resumed = await resumeAgentRecentRun(details.runId as string, "process another turn");
		expect(resumed.ok).toBe(true);
		const secondPark = await waitForAgentRecentRun(details.runId as string);
		expect(secondPark).toMatchObject({ status: "interrupted", parked: true });
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		expect(completions).toHaveLength(2);
		expect(completions[1]).toMatchObject({ status: "idle", parked: true });
		expect(completions[1]?.result).toBe("persistent child ready again");
	});

	it("fires onBackgroundTerminal exactly once with runId + status when a background run completes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([() => fauxAssistantMessage("background child done")]);

		const completions: AgentBackgroundCompletion[] = [];

		const details = await executeAgentTool(
			{ mode: "single", background: true, tasks: [{ agent: "general", task: "report and exit" }] },
			{
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
				parentThinkingLevel: "off",
				onBackgroundTerminal: (notification) => completions.push(notification),
			},
		);

		expect(details.background).toBe(true);
		expect(details.status).toBe("running");
		expect(details.runId).toBeDefined();

		// Wait for the background run to reach a terminal status.
		const finalRun = await waitForAgentRecentRun(details.runId as string);
		expect(["completed", "failed", "cancelled", "interrupted"]).toContain(finalRun.status);

		// Terminal listener fires synchronously from the lifecycle update; one tick
		// is enough for the promise.finally() in launch() to have run.
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		expect(completions).toHaveLength(1);
		const note = completions[0]!;
		expect(note.runId).toBe(details.runId);
		expect(note.status).toBe(finalRun.status);
		expect(note.agents).toEqual(["general"]);
		expect(note.summary).toMatch(/Background agent agent-/);
		// Result preview should carry the child's final assistant text on success.
		if (note.status === "completed") {
			expect(note.result).toBe("background child done");
		}
	});
});
