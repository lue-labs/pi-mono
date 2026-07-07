import { type Context, fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../../src/core/agents/executor.ts";
import {
	cancelAgentRecentRun,
	clearAgentRecentRunsForTests,
	findAgentRecentRun,
	waitForAgentRecentRun,
} from "../../src/core/agents/status.ts";
import type { AgentBackgroundCompletion } from "../../src/core/agents/types.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("agent tool suite: single", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		clearAgentRecentRunsForTests();
	});

	it("runs a child session with parent-bounded tools and recursive agent denial", async () => {
		const seenChildContexts: Context[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				seenChildContexts.push(context);
				return fauxAssistantMessage("child complete");
			},
		]);

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "general", task: "Report child tools" }] },
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
			},
		);

		expect(seenChildContexts).toHaveLength(1);
		expect(details.runs[0]?.effectiveTools.sort()).toEqual(["bash", "edit", "read", "write"]);
		expect(details.runs[0]?.deniedTools).toContain("agent");
		expect(details.runs[0]?.sessionId).toBeTruthy();
		expect(details.runs[0]?.sessionPath).toContain(".jsonl");
		expect(details.runs[0]?.messageCount).toBeGreaterThan(0);
		expect(details.runs[0]?.usage?.totalTokens).toBeGreaterThanOrEqual(0);
		expect(seenChildContexts[0]?.tools?.map((tool) => tool.name)).not.toContain("agent");
	});

	it("marks background forks with observer pairing metadata as observer runs", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("observer idle")]);

		const details = await executeAgentTool(
			{
				mode: "single",
				background: true,
				tasks: [{ agent: "general", task: "Observe quietly", forkMetadata: { pairingId: "pairing-1" } }],
			},
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: ["read"],
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel(),
				parentThinkingLevel: "off",
			},
		);

		expect(details.runId).toBeTruthy();
		const run = findAgentRecentRun(details.runId!);
		expect(run?.kind).toBe("observer");
		await cancelAgentRecentRun(details.runId!);
	});

	it("surfaces child provider rate-limit retries in Agent progress", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit from clawrouter" }),
			fauxAssistantMessage("child complete"),
		]);
		const progressSnippets: string[] = [];

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "reviewer", task: "Review the diff" }] },
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: ["read", "grep"],
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel(),
				parentThinkingLevel: "off",
				onProgress: (progress) => {
					const snippets = progress.runs[0]?.recentOutputSnippets ?? [];
					const latest = snippets[snippets.length - 1];
					if (latest) progressSnippets.push(latest);
				},
			},
		);

		expect(details.status).toBe("completed");
		expect(progressSnippets).toEqual(
			expect.arrayContaining([expect.stringContaining("Rate limited/overloaded; auto-retry 1/2")]),
		);
		expect(progressSnippets.some((snippet) => snippet.includes("429 rate limit from clawrouter"))).toBe(true);
	});

	it("auto-backgrounds foreground child runs when provider retry starts", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit from clawrouter" }),
			fauxAssistantMessage("child complete after retry"),
		]);
		const completions: AgentBackgroundCompletion[] = [];

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "reviewer", task: "Review the diff" }] },
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: ["read", "grep"],
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel(),
				parentThinkingLevel: "off",
				onBackgroundTerminal: (notification) => completions.push(notification),
			},
		);

		expect(details.status).toBe("running");
		expect(details.background).toBe(true);
		expect(details.runId).toBeTruthy();
		expect(details.message).toContain("auto-backgrounded after child provider retry/backoff");
		expect(details.message).toContain("429 rate limit from clawrouter");
		const running = findAgentRecentRun(details.runId!);
		expect(running?.execution).toBe("background");
		expect(running?.runs[0]?.recentOutputSnippets).toEqual(
			expect.arrayContaining([expect.stringContaining("Rate limited/overloaded; auto-retry 1/2")]),
		);

		const finalRun = await waitForAgentRecentRun(details.runId!);
		expect(finalRun.status).toBe("completed");
		expect(completions).toHaveLength(1);
		expect(completions[0]?.runId).toBe(details.runId);
		expect(completions[0]?.result).toBe("child complete after retry");
	});

	it("keeps auto-backgrounded provider-retry runs controllable", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10_000 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit from clawrouter" }),
			fauxAssistantMessage("should not be reached"),
		]);

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "reviewer", task: "Review the diff" }] },
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: ["read", "grep"],
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel(),
				parentThinkingLevel: "off",
				onBackgroundTerminal: () => {},
			},
		);

		expect(details.status).toBe("running");
		expect(details.background).toBe(true);
		const cancelled = await cancelAgentRecentRun(details.runId!);
		expect(cancelled.ok).toBe(true);
		expect(cancelled.run?.status).toBe("cancelled");
		expect(cancelled.run?.execution).toBe("background");
	});
});
