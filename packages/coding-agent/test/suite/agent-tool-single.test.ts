import { type Context, fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../../src/core/agents/executor.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("agent tool suite: single", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
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
});
