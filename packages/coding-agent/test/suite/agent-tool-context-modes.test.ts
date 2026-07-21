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
			modelRuntime: harness.session.modelRuntime,
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

	it("explore and plan omit project instructions, skills, and append-system context by default", async () => {
		const childPrompts: Array<string | undefined> = [];
		const harness = await createHarness();
		harnesses.push(harness);
		mkdirSync(join(harness.tempDir, ".pi", "skills", "project-marker"), { recursive: true });
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "PROJECT INSTRUCTIONS MARKER");
		writeFileSync(join(harness.tempDir, ".pi", "APPEND_SYSTEM.md"), "PROJECT APPEND MARKER");
		writeFileSync(
			join(harness.tempDir, ".pi", "skills", "project-marker", "SKILL.md"),
			"---\nname: project-marker\ndescription: PROJECT SKILL MARKER\n---\n\n# Project marker\n",
		);
		harness.setResponses([
			(context: Context) => {
				childPrompts.push(context.systemPrompt);
				return fauxAssistantMessage("explore done");
			},
			(context: Context) => {
				childPrompts.push(context.systemPrompt);
				return fauxAssistantMessage("plan done");
			},
		]);

		await executeAgentTool(
			{
				mode: "parallel",
				tasks: [
					{ agent: "explore", task: "locate the seam" },
					{ agent: "plan", task: "plan the change" },
				],
				concurrency: 1,
			},
			executorOptions(harness),
		);

		expect(childPrompts).toHaveLength(2);
		for (const prompt of childPrompts) {
			expect(prompt).not.toContain("PROJECT INSTRUCTIONS MARKER");
			expect(prompt).not.toContain("PROJECT APPEND MARKER");
			expect(prompt).not.toContain("PROJECT SKILL MARKER");
		}
	});

	it("general starts fresh while retaining project and append-system context", async () => {
		let childPrompt: string | undefined;
		const harness = await createHarness();
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "GENERAL PROJECT INSTRUCTIONS MARKER");
		mkdirSync(join(harness.tempDir, ".pi"), { recursive: true });
		writeFileSync(join(harness.tempDir, ".pi", "APPEND_SYSTEM.md"), "GENERAL APPEND MARKER");
		harness.setResponses([
			(context: Context) => {
				childPrompt = context.systemPrompt;
				return fauxAssistantMessage("general done");
			},
		]);

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "general", task: "complete the scoped change" }] },
			executorOptions(harness),
		);

		expect(details.runs[0]?.context).toMatchObject({
			mode: "default",
			includeTranscript: false,
			includeProjectContext: true,
			includeSkills: true,
			includeAppendSystemPrompt: true,
		});
		expect(childPrompt).toContain("GENERAL PROJECT INSTRUCTIONS MARKER");
		expect(childPrompt).toContain("GENERAL APPEND MARKER");
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

	it("binds session-start extension tools before a restricted fork sends its provider request", async () => {
		const providerTools: string[][] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		const extensionsDir = join(harness.tempDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "child-session-start-tool.ts"),
			`export default function (pi) {
				pi.on("session_start", () => {
					for (const name of ["child_session_start_first", "child_session_start_second"]) {
						pi.registerTool({
							name,
							label: name,
							description: "Available after session start",
							parameters: { type: "object", properties: {} },
							execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
						});
					}
				});
			}`,
		);
		harness.setResponses([
			(context: Context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage("child done");
			},
		]);

		const details = await executeAgentTool(
			{
				mode: "single",
				tasks: [{ agent: "general", task: "use the child extension", context: "fork" }],
			},
			{
				...executorOptions(harness),
				parentActiveTools: ["child_session_start_second", "child_session_start_first"],
				parentSystemPrompt: "PARENT PROMPT",
			},
		);

		expect(details.runs[0]?.effectiveTools).toEqual(["child_session_start_second", "child_session_start_first"]);
		expect(providerTools).toEqual([["child_session_start_second", "child_session_start_first"]]);
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
