import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@lue-labs/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { executeAgentTool } from "../../../src/core/agents/executor.ts";
import {
	clearAgentRecentRunsForTests,
	resumeAgentRecentRun,
	waitForAgentRecentRun,
} from "../../../src/core/agents/status.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for valkyriweb/my-pi#916: a background Agent dispatch routes the
// child session to task.cwd, but resuming a parked persistent background run
// (resumeSingleBackgroundRun) rebuilds the child's tool-bound services from
// the raw parent cwd instead of re-applying resolveChildCwd(task.cwd, parentCwd).
// The child's bash tool then defaults to the parent's cwd on resume, even
// though the original dispatch routed it elsewhere.
describe("agent tool suite: background resume keeps routed task.cwd (#916)", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		clearAgentRecentRunsForTests();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the child bash tool cwd at task.cwd across a background resume", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const routedCwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-916-routed-")));
		tempDirs.push(routedCwd);

		let latestChildSession: AgentSession | undefined;

		// Turn 1: park (persistent + background single run parks after each turn).
		harness.setResponses([fauxAssistantMessage("turn one done")]);

		const initial = await executeAgentTool(
			{
				mode: "single",
				background: true,
				persistent: true,
				tasks: [{ agent: "general", task: "Report cwd across turns", cwd: routedCwd }],
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
				onChildSessionStart: (session) => {
					latestChildSession = session;
				},
			},
		);

		expect(initial.runId).toBeTruthy();
		const runId = initial.runId!;
		await waitForAgentRecentRun(runId);

		// Turn 2 (resume): the child runs `bash pwd` — assert it still resolves
		// against routedCwd, not harness.tempDir (the parent cwd).
		harness.appendResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done checking cwd"),
		]);

		const resumeResult = await resumeAgentRecentRun(runId, "Run `pwd` and report it");
		expect(resumeResult.ok).toBe(true);
		await waitForAgentRecentRun(runId);

		expect(latestChildSession).toBeTruthy();
		const toolResultText = latestChildSession!.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
			.join("\n");

		expect(toolResultText).toContain(routedCwd);
		expect(toolResultText).not.toContain(harness.tempDir);
	});
});
