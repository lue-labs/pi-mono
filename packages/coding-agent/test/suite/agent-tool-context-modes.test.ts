import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentSystemAppend } from "../../src/core/agents/context.ts";
import { getBuiltinAgentDefinitions } from "../../src/core/agents/definitions.ts";
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

describe("agent tool suite: context modes", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("stable-profile agents use byte-stable agent prompt only", async () => {
		const childPrompts: Array<string | undefined> = [];
		const harness = await createHarness();
		harnesses.push(harness);
		mkdirSync(join(harness.tempDir, ".pi"), { recursive: true });
		writeFileSync(join(harness.tempDir, ".pi", "APPEND_SYSTEM.md"), "PROJECT APPEND");
		harness.setResponses([
			(context: Context) => {
				childPrompts.push(context.systemPrompt);
				return fauxAssistantMessage("decompose done");
			},
		]);

		await executeAgentTool(
			{
				mode: "single",
				tasks: [{ agent: "decompose", task: "split this broad task" }],
			},
			executorOptions(harness),
		);

		const decompose = getBuiltinAgentDefinitions().find((agent) => agent.id === "decompose");
		expect(decompose).toBeDefined();
		expect(childPrompts).toEqual([buildAgentSystemAppend(decompose!)]);
		expect(childPrompts[0]).not.toContain("PROJECT APPEND");
		expect(childPrompts[0]).not.toContain(harness.tempDir);
		expect(childPrompts[0]).not.toContain("Current date:");
		expect(childPrompts[0]).not.toMatch(/\b(child agent|subagent|parent agent|invoker)\b/i);
	});

	it("renders different child system prompts for slim and none", async () => {
		const childPrompts: Array<string | undefined> = [];
		const harness = await createHarness();
		harnesses.push(harness);
		mkdirSync(join(harness.tempDir, ".pi"), { recursive: true });
		writeFileSync(join(harness.tempDir, ".pi", "APPEND_SYSTEM.md"), "PROJECT APPEND");
		harness.setResponses([
			(context: Context) => {
				childPrompts.push(context.systemPrompt);
				return fauxAssistantMessage("slim done");
			},
			(context: Context) => {
				childPrompts.push(context.systemPrompt);
				return fauxAssistantMessage("none done");
			},
		]);

		await executeAgentTool(
			{
				mode: "parallel",
				tasks: [
					{ agent: "explore", task: "slim child", context: "slim" },
					{ agent: "explore", task: "none child", context: "none" },
				],
				concurrency: 1,
			},
			executorOptions(harness),
		);

		expect(childPrompts).toHaveLength(2);
		expect(childPrompts[0]).toContain("PROJECT APPEND");
		expect(childPrompts[1]).not.toContain("PROJECT APPEND");
		expect(childPrompts[0]).not.toBe(childPrompts[1]);
	});

	it("keeps fork role and tool semantics when frozen parent system bytes are unavailable", async () => {
		let childTaskPrompt = "";
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			(context: Context) => {
				childTaskPrompt = getMessageText(context.messages.at(-1));
				return fauxAssistantMessage("reviewer fork done");
			},
		]);

		const details = await executeAgentTool(
			{
				mode: "single",
				tasks: [{ agent: "reviewer", task: "review this", context: "fork" }],
			},
			executorOptions(harness),
		);

		expect(childTaskPrompt).toContain("## Selected Agent role: reviewer");
		expect(childTaskPrompt).toContain("## Task from the calling agent\n\nreview this");
		expect(details.runs[0]?.effectiveTools).toEqual(["read", "bash", "edit", "write", "agent"]);
		expect(details.runs[0]?.warnings).toEqual([
			expect.stringMatching(/context:"fork".*does not apply.*reviewer.*ordinary tool allow\/deny list/i),
		]);
	});

	it("treats an explicit fork tool restriction as a canonical parent-tool subset", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("restricted fork done")]);

		const details = await executeAgentTool(
			{
				mode: "single",
				tasks: [{ agent: "general", task: "use the restricted tools", context: "fork", tools: ["Agent", "Read"] }],
			},
			{ ...executorOptions(harness), parentSystemPrompt: "PARENT PROMPT" },
		);

		// The explicit restriction intentionally opts out of exact parent-prefix
		// cache reuse, but keeps the parent's aliases and stable ordering.
		expect(details.runs[0]?.effectiveTools).toEqual(["read", "agent"]);
	});
});
