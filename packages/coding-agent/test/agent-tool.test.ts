import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeAgentOutput } from "../src/core/agents/output.ts";
import {
	attachAgentRecentRunController,
	clearAgentRecentRunsForTests,
	startAgentRecentRun,
	updateAgentRecentRunProgress,
} from "../src/core/agents/status.ts";
import type { AgentToolDetails } from "../src/core/agents/types.ts";
import {
	createAgentToolDefinition,
	normalizeAgentToolAliases,
	normalizeAgentToolMode,
} from "../src/core/tools/agent.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import { theme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-tool-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent tool", () => {
	test("schema mode validation requires exactly one mode", () => {
		expect(() => normalizeAgentToolMode({ agent: "scout", task: "find files" })).not.toThrow();
		expect(() => normalizeAgentToolMode({ tasks: [{ agent: "scout", task: "a" }] })).not.toThrow();
		expect(() => normalizeAgentToolMode({ chain: [{ agent: "scout", task: "a" }] })).not.toThrow();
		expect(() => normalizeAgentToolMode({})).toThrow("exactly one mode");
		expect(() =>
			normalizeAgentToolMode({ agent: "scout", task: "a", tasks: [{ agent: "scout", task: "b" }] }),
		).toThrow("exactly one mode");
	});

	test("single-agent mode preserves maxOutputTokens", () => {
		const result = normalizeAgentToolMode({
			agent: "scout",
			task: "summarize",
			maxOutputTokens: 1200,
		});
		expect(result.tasks[0].maxOutputTokens).toBe(1200);
	});

	test("Claude-style single-agent aliases normalize to Pi fields", () => {
		const normalized = normalizeAgentToolAliases({
			subagent_type: "Explore",
			prompt: "find config",
			run_in_background: true,
		} as Parameters<typeof normalizeAgentToolAliases>[0]);
		expect(normalized).toMatchObject({ agent: "Explore", task: "find config", background: true });
		expect(normalizeAgentToolMode(normalized)).toMatchObject({
			mode: "single",
			tasks: [expect.objectContaining({ agent: "Explore", task: "find config" })],
		});
	});

	test("Claude-style aliases normalize inside tasks and chains", () => {
		expect(
			normalizeAgentToolMode({
				tasks: [{ subagent_type: "explore", prompt: "map routing", description: "routing" }],
			}),
		).toMatchObject({
			mode: "parallel",
			tasks: [expect.objectContaining({ agent: "explore", task: "map routing", description: "routing" })],
		});
		expect(
			normalizeAgentToolMode({
				chain: [{ subagent_type: "plan", prompt: "Use {previous}" }],
			}),
		).toMatchObject({
			mode: "chain",
			tasks: [expect.objectContaining({ agent: "plan", task: "Use {previous}" })],
		});
	});

	test("task-array entries require a prompt and subagent type after alias normalization", () => {
		expect(() => normalizeAgentToolMode({ tasks: [{ subagent_type: "explore" }] })).toThrow(
			"require subagent_type and prompt",
		);
		expect(() => normalizeAgentToolMode({ chain: [{ prompt: "map" }] })).toThrow("require subagent_type and prompt");
	});

	test("Claude-style aliases reject conflicts clearly", () => {
		expect(() =>
			normalizeAgentToolAliases({ agent: "explore", subagent_type: "plan", task: "find" } as Parameters<
				typeof normalizeAgentToolAliases
			>[0]),
		).toThrow("agent and subagent_type differ");
		expect(() =>
			normalizeAgentToolAliases({ agent: "explore", task: "find", prompt: "plan" } as Parameters<
				typeof normalizeAgentToolAliases
			>[0]),
		).toThrow("task and prompt differ");
		expect(() =>
			normalizeAgentToolAliases({
				agent: "explore",
				task: "find",
				background: true,
				run_in_background: false,
			} as Parameters<typeof normalizeAgentToolAliases>[0]),
		).toThrow("background and run_in_background differ");
	});

	test("future Claude fields reject instead of being silently ignored", () => {
		expect(() =>
			normalizeAgentToolAliases({ agent: "explore", task: "find", worktree: "/tmp" } as Parameters<
				typeof normalizeAgentToolAliases
			>[0]),
		).toThrow("worktree is not supported yet");
	});

	test("all-tool registry includes agent, Agent, and Task with Claude-style fields", () => {
		const tools = createAllToolDefinitions(process.cwd());
		expect(Object.keys(tools)).toEqual(expect.arrayContaining(["agent", "Agent", "Task"]));
		expect(tools.Agent.name).toBe("Agent");
		expect(tools.Task.name).toBe("Task");
		for (const tool of [tools.agent, tools.Agent, tools.Task]) {
			const properties = tool.parameters.properties;
			expect(properties).toHaveProperty("prompt");
			expect(properties).toHaveProperty("subagent_type");
			expect(properties).toHaveProperty("run_in_background");
			const taskItem = (
				properties.tasks as { items: { properties: Record<string, { description?: string }>; required?: string[] } }
			).items;
			// tasks[]/chain[] items use a bare (description-stripped) taskSchema — same fields, same
			// types, no per-field prose. Full descriptions live on the single-mode top-level fields
			// only (see agent-schema-dedupe Option D).
			expect(taskItem.properties.subagent_type).not.toHaveProperty("description");
			expect(taskItem.properties.prompt).not.toHaveProperty("description");
			expect(properties.subagent_type as { description?: string }).toHaveProperty("description");
			expect((properties.prompt as { description?: string }).description).toMatch(/preferred/);
			expect(taskItem.required ?? []).not.toContain("agent");
			expect(taskItem.required ?? []).not.toContain("task");
		}
	});

	test("output/outputMode writes parent-owned file", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "reports"), { recursive: true });
		const result = await writeAgentOutput({
			cwd,
			output: "reports/scout.md",
			outputMode: "file",
			content: "final report",
		});
		expect(result.displayText).toContain("Saved Agent output");
		expect(result.rawContent).toBe("final report");
		expect(result.outputPath).toBe(join(cwd, "reports", "scout.md"));
		expect(await readFile(result.outputPath ?? "", "utf-8")).toBe("final report");
	});

	test("tool guidelines allow parallel independent tasks without prescribing separate calls", () => {
		const guidelines = createAgentToolDefinition(process.cwd()).promptGuidelines?.join("\n") ?? "";
		expect(guidelines).toContain("Run independent tasks in parallel");
		expect(guidelines).toContain("use `chain` only when later work depends on earlier results");
		expect(guidelines).not.toMatch(/multiple `?agent`? tool-use blocks/);
	});

	test("tool schemas preserve the Claude-style Agent shape and guidance requires outcome contracts", () => {
		const tools = createAllToolDefinitions(process.cwd());
		for (const tool of [tools.agent, tools.Agent, tools.Task]) {
			expect(tool.parameters.properties).toHaveProperty("subagent_type");
			expect(tool.parameters.properties).toHaveProperty("prompt");
			expect(tool.description).toContain("Agent task");
			expect(tool.description.length).toBeLessThan(150);
		}
		const guidelines = createAgentToolDefinition(process.cwd()).promptGuidelines?.join("\n") ?? "";
		expect(guidelines).toContain("Write an outcome contract");
		expect(guidelines).toContain("expected report");
		expect(guidelines).toContain("self-verification evidence");
	});

	test("collapsed render shows per-agent work activity", () => {
		const tool = createAgentToolDefinition(process.cwd());
		const details: AgentToolDetails = {
			mode: "parallel",
			status: "completed",
			runs: [
				{
					agent: "explore",
					source: "builtin",
					task: "Find render code",
					status: "completed",
					context: {
						mode: "slim",
						includeTranscript: false,
						includeProjectContext: false,
						includeSkills: false,
						includeAppendSystemPrompt: false,
					},
					effectiveTools: ["grep"],
					deniedTools: ["agent"],
					durationMs: 1200,
					toolCallCount: 1,
					messageCount: 3,
					recentToolCalls: [{ name: "grep", argsPreview: "AgentProgressLine", startedAt: 1 }],
					recentOutputSnippets: [],
					warnings: [
						"Warning: explore running on frontier model clawrouter/claude-fable-5-200k for fast alias — add a fast-tier mapping for this provider or pass an explicit cheap model",
					],
					loadedSkills: [],
					invokedSkills: { count: 0, names: [] },
				},
			],
		};
		const result = { content: [{ type: "text" as const, text: "agent parallel: completed" }], details };
		const renderResult = tool.renderResult;
		expect(renderResult).toBeDefined();
		if (!renderResult) return;
		const context = {} as unknown as Parameters<typeof renderResult>[3];
		const component = renderResult(result, { expanded: false, isPartial: false }, theme, context);
		const text = component.render(120).join("\n");
		expect(text).toContain("└─");
		expect(text).toContain("explore");
		expect(text).toContain("⎿  grep: AgentProgressLine");
		expect(text).toContain("Warning: explore running on frontier model clawrouter/claude-fable-5-200k");
	});

	test("project agent confirmation cannot be bypassed by tool arguments", async () => {
		const tool = createAgentToolDefinition(process.cwd(), {
			parentServices: {} as NonNullable<Parameters<typeof createAgentToolDefinition>[1]>["parentServices"],
			getParentActiveTools: () => [],
			getParentSessionManager: () => {
				throw new Error("should not reach execution");
			},
		});
		const modelSuppliedParams = {
			agent: "scout",
			task: "find files",
			agentScope: "project",
			confirmProjectAgents: false,
		} as unknown as Parameters<typeof tool.execute>[1];
		await expect(
			tool.execute("tool-1", modelSuppliedParams, undefined, undefined, {
				hasUI: false,
			} as Parameters<typeof tool.execute>[4]),
		).rejects.toThrow("Project agents require interactive confirmation");
	});

	test("action=inject interrupts a running run then resumes with the message", async () => {
		clearAgentRecentRunsForTests();
		const dir = await makeTempDir();
		const sessionPath = join(dir, "child-session.jsonl");
		await writeFile(sessionPath, "{}\n");
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [
				{
					agent: "scout",
					source: "builtin",
					task: "Map files",
					status: "running",
					context: {
						mode: "default",
						includeTranscript: false,
						includeProjectContext: true,
						includeSkills: true,
						includeAppendSystemPrompt: true,
					},
					effectiveTools: [],
					deniedTools: [],
					durationMs: 1,
					toolCallCount: 0,
					messageCount: 0,
					recentToolCalls: [],
					recentOutputSnippets: [],
					loadedSkills: [],
					invokedSkills: { count: 0, names: [] },
					sessionPath,
				},
			],
		});
		const interrupt = vi.fn();
		const resume = vi.fn();
		attachAgentRecentRunController(run.id, { interrupt, resume });

		const tool = createAgentToolDefinition(process.cwd());
		const result = await tool.execute(
			"tool-inject",
			{ action: "inject", runId: run.id, message: "check config.ts" } as Parameters<typeof tool.execute>[1],
			undefined,
			undefined,
			{ hasUI: false } as Parameters<typeof tool.execute>[4],
		);

		expect(interrupt).toHaveBeenCalledOnce();
		expect(resume).toHaveBeenCalledWith("check config.ts");
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain(`Resumed ${run.id}`);
		expect(result.details?.runId).toBe(run.id);
		clearAgentRecentRunsForTests();
	});

	test("action=inject without message rejects", async () => {
		clearAgentRecentRunsForTests();
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map" }], { background: true });
		const tool = createAgentToolDefinition(process.cwd());
		await expect(
			tool.execute(
				"tool-inject",
				{ action: "inject", runId: run.id } as Parameters<typeof tool.execute>[1],
				undefined,
				undefined,
				{ hasUI: false } as Parameters<typeof tool.execute>[4],
			),
		).rejects.toThrow("requires message");
		clearAgentRecentRunsForTests();
	});

	test("execute fails clearly when runtime child services are not wired", async () => {
		const tool = createAgentToolDefinition(process.cwd());
		await expect(
			tool.execute("tool-1", { agent: "scout", task: "find files" }, undefined, undefined, {
				hasUI: false,
			} as Parameters<typeof tool.execute>[4]),
		).rejects.toThrow("agent tool is unavailable");
	});

	// removed: `deferred tool search prefers Claude-compatible agent aliases`
	// createDeferredToolSearchTool moved to the pi-deferred-tools v2 extension (my-pi#1076).
});
