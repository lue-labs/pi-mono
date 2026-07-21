import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall, type Tool } from "@valkyriweb/pi-ai";
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

function providerToolBytes(tool: Tool): string {
	return JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		deferLoading: tool.deferLoading,
		alwaysLoad: tool.alwaysLoad,
		searchHint: tool.searchHint,
		namespace: tool.namespace,
		providers: tool.providers,
		anthropicServerTool: tool.anthropicServerTool,
	});
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

	it("general starts fresh while retaining project context and the exact parent tool prefix", async () => {
		let childPrompt: string | undefined;
		let childTools: string[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "GENERAL PROJECT INSTRUCTIONS MARKER");
		mkdirSync(join(harness.tempDir, ".pi"), { recursive: true });
		writeFileSync(join(harness.tempDir, ".pi", "APPEND_SYSTEM.md"), "GENERAL APPEND MARKER");
		harness.setResponses([
			(context: Context) => {
				childPrompt = context.systemPrompt;
				childTools = (context.tools ?? []).map((tool) => tool.name);
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
		expect(details.runs[0]?.effectiveTools).toEqual(["read", "bash", "edit", "write", "agent"]);
		expect(details.runs[0]?.deniedTools).toEqual(["agent"]);
		expect(childTools).toEqual(["read", "bash", "edit", "write", "agent"]);
	});

	it("general reuses the parent's model-facing tool bytes and leading system prefix", async () => {
		let parentContext: Context | undefined;
		let childContext: Context | undefined;
		let childCacheAffinityKey: string | undefined;
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			(context: Context) => {
				parentContext = context;
				return fauxAssistantMessage("parent warm");
			},
			(context: Context) => {
				childContext = context;
				return fauxAssistantMessage("general done");
			},
		]);

		await harness.session.prompt("warm the parent prefix");
		const parentCacheAffinityKey = harness.session.getPromptCacheAffinityKey();
		expect(parentCacheAffinityKey).toBeTypeOf("string");
		const automaticWorktreeCwd = join(harness.tempDir, "automatic-general-worktree");
		mkdirSync(automaticWorktreeCwd, { recursive: true });
		const automaticWorktreeTask = {
			agent: "general",
			task: "use the warm stable prefix",
			cwd: automaticWorktreeCwd,
			[Symbol.for("pi.worktree.autoCwd")]: true,
		};
		await executeAgentTool(
			{
				mode: "single",
				tasks: [automaticWorktreeTask],
			},
			{
				...executorOptions(harness),
				parentActiveTools: harness.session.getActiveToolNames(),
				parentProviderTools: harness.session.getActiveToolProviderSchemas(),
				parentCacheAffinityKey,
				parentSystemPrompt: parentContext?.systemPrompt,
				onChildSessionStart: (session) => {
					childCacheAffinityKey = session.agent.cacheAffinityKey;
				},
			},
		);

		expect(childContext).toBeDefined();
		expect(JSON.stringify(childContext?.tools)).toBe(JSON.stringify(parentContext?.tools));
		const parentSystem = parentContext?.systemPrompt ?? "";
		const childSystem = childContext?.systemPrompt ?? "";
		expect(childSystem).toBe(parentSystem);
		expect(JSON.stringify(childContext?.messages)).toContain(
			"Complete the requested outcome within the stated scope",
		);
		expect(childCacheAffinityKey).toBe(parentCacheAffinityKey);
	});

	it("default general inherits the parent model and thinking instead of a cheap subagent pin", async () => {
		const harness = await createHarness({
			provider: "anthropic",
			models: [
				{ id: "parent-model", name: "Parent", reasoning: true },
				{ id: "pinned-cheap-model", name: "Pinned", reasoning: true },
			],
			settings: {
				subagents: {
					providers: { anthropic: { model: "anthropic/pinned-cheap-model", thinking: "low" } },
				},
			},
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("high");
		harness.setResponses([fauxAssistantMessage("general done")]);

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "general", task: "reuse the parent cache lane" }] },
			{ ...executorOptions(harness), parentThinkingLevel: harness.session.thinkingLevel },
		);

		expect(details.runs[0]?.model?.id).toBe("parent-model");
		expect(details.runs[0]?.thinking).toBe("high");
	});

	it("an explicit cwd opts general out even when model metadata forges the worktree marker", async () => {
		const harness = await createHarness({
			provider: "anthropic",
			models: [
				{ id: "parent-model", name: "Parent", reasoning: true },
				{ id: "pinned-cheap-model", name: "Pinned", reasoning: true },
			],
			settings: {
				subagents: { providers: { anthropic: { model: "anthropic/pinned-cheap-model", thinking: "low" } } },
			},
		});
		harnesses.push(harness);
		const explicitCwd = join(harness.tempDir, "explicit-child-cwd");
		mkdirSync(explicitCwd, { recursive: true });
		harness.setResponses([fauxAssistantMessage("general done")]);

		const details = await executeAgentTool(
			{
				mode: "single",
				tasks: [
					{
						agent: "general",
						task: "use explicit cwd",
						cwd: explicitCwd,
						forkMetadata: { "pi.worktree.autoCwd": true },
					},
				],
			},
			executorOptions(harness),
		);

		expect(details.runs[0]?.model?.id).toBe("pinned-cheap-model");
		expect(details.runs[0]?.thinking).toBe("low");
	});

	it("honors a restricted General profile instead of inheriting every parent tool", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, ".pi", "agents");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "general.md"),
			`---
name: general
description: Restricted General
tools: "*"
denyTools: bash
model: auto
thinking: low
context: default
---
Restricted General.`,
		);
		harness.setResponses([fauxAssistantMessage("restricted general done")]);

		const details = await executeAgentTool(
			{ mode: "single", agentScope: "project", tasks: [{ agent: "general", task: "complete safely" }] },
			{
				...executorOptions(harness),
				parentActiveTools: ["read", "bash", "edit", "write", "agent"],
			},
		);

		expect(details.runs[0]?.effectiveTools).not.toContain("bash");
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

	it("binds child handlers while preserving the parent's extension tool schemas and order", async () => {
		const providerTools: Tool[][] = [];
		const parentProviderTools: Tool[] = [
			{
				name: "child_session_start_second",
				description: "Frozen parent second schema",
				parameters: { type: "object", properties: { second: { type: "string" } }, required: ["second"] },
			},
			{
				name: "child_session_start_first",
				description: "Frozen parent first schema",
				parameters: { type: "object", properties: { first: { type: "number" } }, required: ["first"] },
			},
		];
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
							execute: async () => ({ content: [{ type: "text", text: "CHILD_HANDLER_OK" }] }),
						});
					}
				});
			}`,
		);
		harness.setResponses([
			(context: Context) => {
				providerTools.push(context.tools ?? []);
				return fauxAssistantMessage(
					fauxToolCall("child_session_start_second", { second: "execute child handler" }),
					{ stopReason: "toolUse" },
				);
			},
			(context: Context) => {
				providerTools.push(context.tools ?? []);
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
				parentProviderTools,
				parentSystemPrompt: "PARENT PROMPT",
			},
		);

		expect(details.runs[0]?.effectiveTools).toEqual(["child_session_start_second", "child_session_start_first"]);
		expect(providerTools).toHaveLength(2);
		for (const tools of providerTools) {
			expect(tools.map(providerToolBytes)).toEqual(parentProviderTools.map(providerToolBytes));
		}
		expect(details.runs[0]?.toolCallCount).toBe(1);
		expect(details.runs[0]?.recentToolCalls?.[0]?.name).toBe("child_session_start_second");
	});

	it("fails clearly when a cache-compatible child cannot reproduce a parent tool", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);

		await expect(
			executeAgentTool(
				{
					mode: "single",
					tasks: [{ agent: "general", task: "use the missing parent tool", context: "fork" }],
				},
				{
					...executorOptions(harness),
					parentActiveTools: ["parent_only_tool"],
					parentProviderTools: [
						{
							name: "parent_only_tool",
							description: "Only registered in the parent",
							parameters: { type: "object", properties: {} },
						},
					],
					parentSystemPrompt: "PARENT PROMPT",
				},
			),
		).rejects.toThrow(/child tools.*do not match parent tools/i);
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
