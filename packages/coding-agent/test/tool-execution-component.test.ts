import { join, resolve } from "node:path";
import { Text, type TUI, visibleWidth } from "@valkyriweb/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { getReadmePath } from "../src/config.ts";
import {
	clearAgentRecentRunsForTests,
	startAgentRecentRun,
	updateAgentRecentRunProgress,
} from "../src/core/agents/status.ts";
import type { AgentRunDetails, AgentToolDetails } from "../src/core/agents/types.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createAgentToolDefinition } from "../src/core/tools/agent.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolExecutionGroupComponent } from "../src/modes/interactive/components/tool-execution-group.ts";
import { ToolPanel } from "../src/modes/interactive/components/tool-panel.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders default-shell tools in a compact padded panel", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-panel",
			{},
			{},
			{
				...createBaseToolDefinition(),
				renderCall: () => new Text("call", 0, 0),
				renderResult: () => new Text("result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		let lines = component.render(40);
		expect(lines.slice(1)).toEqual(lines.slice(1).map((line) => theme.bg("toolPendingBg", stripAnsi(line))));

		component.updateResult({ content: [], details: {}, isError: false }, false);
		lines = component.render(40);
		expect(stripAnsi(lines.join("\n"))).toBe(`\n  call${" ".repeat(34)}\n  result${" ".repeat(32)}`);
		expect(lines.slice(1)).toEqual(lines.slice(1).map((line) => theme.bg("toolSuccessBg", stripAnsi(line))));
	});

	test("renders failed default-shell tools with the error background", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-panel-error",
			{},
			{},
			{
				...createBaseToolDefinition(),
				renderCall: () => new Text("call", 0, 0),
				renderResult: () => new Text("failed", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: {}, isError: true }, false);

		const lines = component.render(40).slice(1);
		expect(lines).toEqual(lines.map((line) => theme.bg("toolErrorBg", stripAnsi(line))));
	});

	test("renders unknown tools through the default panel fallback", () => {
		const component = new ToolExecutionComponent(
			"removed_tool",
			"tool-panel-fallback",
			{ path: "notes.txt" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "unavailable" }], details: {}, isError: true }, false);

		const lines = component.render(40).slice(1);
		const errorBackgroundPrefix = theme.bg("toolErrorBg", "x").split("x")[0];
		expect(stripAnsi(lines.join("\n"))).toContain("removed_tool");
		expect(stripAnsi(lines.join("\n"))).toContain("unavailable");
		expect(lines.every((line) => line.startsWith(errorBackgroundPrefix))).toBe(true);
	});

	test("reuses composed panel lines until content or state changes", () => {
		let background = "pending";
		const child = new Text("call", 0, 0);
		const panel = new ToolPanel((text) => `${background}:${text}`);
		panel.addChild(child);

		const pending = panel.render(40);
		expect(panel.render(40)).toBe(pending);
		child.setText("updated");
		const updated = panel.render(40);
		expect(updated).not.toBe(pending);
		expect(updated.join("\n")).toContain("updated");
		background = "success";
		const completed = panel.render(40);
		expect(completed).not.toBe(updated);
		expect(panel.render(40)).toBe(completed);
	});

	test("preserves the panel background after truncation adds a full reset", () => {
		const backgroundPrefix = "\x1b[48;2;1;2;3m";
		const panel = new ToolPanel((text) => `${backgroundPrefix}${text}\x1b[49m`);
		panel.addChild({
			render: () => [theme.fg("accent", "abcdef")],
			invalidate: () => {},
		});

		const line = panel.render(5)[0];
		expect(visibleWidth(line)).toBe(5);
		expect(line.split(backgroundPrefix)).toHaveLength(3);
	});

	test("preserves the panel background after a child background reset", () => {
		const backgroundPrefix = "\x1b[48;2;1;2;3m";
		const panel = new ToolPanel((text) => `${backgroundPrefix}${text}\x1b[49m`);
		panel.addChild({
			render: () => [theme.bg("selectedBg", "abc")],
			invalidate: () => {},
		});

		const line = panel.render(20)[0];
		expect(visibleWidth(line)).toBe(20);
		expect(line.split(backgroundPrefix)).toHaveLength(3);
	});

	test("keeps the panel background under content that resets its own styling mid-line", () => {
		const backgroundPrefix = "\x1b[48;2;1;2;3m";
		const panel = new ToolPanel((text) => `${backgroundPrefix}${text}\x1b[49m`);
		panel.addChild({
			render: () => ["before\x1b[0mafter"],
			invalidate: () => {},
		});

		const line = panel.render(20)[0];
		expect(visibleWidth(line)).toBe(20);
		expect(line).toContain(`\x1b[0m${backgroundPrefix}`);
	});

	test("truncates ANSI and wide-character lines to the panel width", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-panel-width",
			{},
			{},
			{
				...createBaseToolDefinition(),
				renderCall: () => new Text(theme.fg("accent", "界界界界界界"), 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);

		for (const line of component.render(12).slice(1)) expect(visibleWidth(line)).toBe(12);
		for (const width of [1, 2, 3, 4]) {
			for (const line of component.render(width).slice(1)) expect(visibleWidth(line)).toBe(width);
		}
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("groups local tools in source order while their completions arrive out of order", () => {
		const first = new ToolExecutionComponent(
			"first_tool",
			"first",
			{},
			{},
			{
				...createBaseToolDefinition("first_tool"),
				renderCall: () => new Text("first call", 0, 0),
				renderResult: (_result, options) => new Text(options.expanded ? "first expanded" : "first compact", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		const second = new ToolExecutionComponent(
			"second_tool",
			"second",
			{},
			{},
			{
				...createBaseToolDefinition("second_tool"),
				renderCall: () => new Text("second call", 0, 0),
				renderResult: () => new Text("second result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		const group = new ToolExecutionGroupComponent();
		group.setSourceOrder(["first", "second"]);
		group.addTool(second);
		group.addTool(first);

		second.markExecutionStarted();
		second.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		first.markExecutionStarted();
		first.updateResult({ content: [{ type: "text", text: "partial" }], details: {}, isError: false }, true);

		const compact = stripAnsi(group.render(120).join("\n"));
		expect(compact).toContain("Parallel · 2 tools · 1 running · 1 done");
		expect(compact.indexOf("first call")).toBeLessThan(compact.indexOf("second call"));
		expect(compact).toContain("first compact");

		group.setExpanded(true);
		expect(stripAnsi(group.render(120).join("\n"))).toContain("first expanded");
	});

	test("does not render a parallel header when every grouped tool is hidden", () => {
		const group = new ToolExecutionGroupComponent();
		for (const id of ["hidden-1", "hidden-2"]) {
			group.addTool(
				new ToolExecutionComponent(
					"hidden_tool",
					id,
					{},
					{},
					{ ...createBaseToolDefinition("hidden_tool"), renderShell: "hidden" },
					createFakeTui(),
					process.cwd(),
				),
			);
		}
		expect(group.render(120)).toEqual([]);
	});

	test("hidden render shell suppresses tool output blocks", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition("hidden_tool"),
			renderShell: "hidden",
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"hidden_tool",
			"tool-hidden-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		expect(component.render(120)).toEqual([]);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		expect(component.render(120)).toEqual([]);
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("agent renderer displays single and expanded results", () => {
		const component = new ToolExecutionComponent(
			"agent",
			"tool-agent-1",
			{ agent: "explore", task: "Find files" },
			{},
			createAgentToolDefinition(process.cwd(), {
				getParentModel: () => ({ provider: "claude-bridge", id: "claude-opus-4-8" }) as any,
				getParentThinkingLevel: () => "high",
			}),
			createFakeTui(),
			process.cwd(),
		);
		let rendered = stripAnsi(component.render(120).join("\n"));
		// Tool label is capitalized in the TUI ("Agent") while the underlying tool id stays lowercase.
		expect(rendered).toContain("Preparing delegation");
		expect(rendered).toContain("Find files · explore");
		expect(rendered).toContain("inherits claude-bridge/claude-opus-4-8");
		expect(rendered).toContain("thinking high");

		component.updateResult(
			{
				content: [{ type: "text", text: "agent single: completed\n1. explore: completed" }],
				details: { mode: "single", status: "completed", runs: [] },
				isError: false,
			},
			false,
		);
		rendered = stripAnsi(component.render(120).join("\n"));
		// Renderer drives display from structured `details`, not the message content.
		expect(rendered).toContain("Delegated 1 agent");
		expect(rendered).not.toContain("agent single: completed");
	});

	test("renders Agent lifecycle and control-action headlines", () => {
		const definition = createAgentToolDefinition(process.cwd());
		const args = { agent: "explore", task: "Map renderer" };
		const render = (overrides: Record<string, unknown> = {}) =>
			stripAnsi(
				definition
					.renderCall?.(args, theme, {
						args,
						toolCallId: "agent-render-state",
						invalidate: () => {},
						lastComponent: undefined,
						state: {},
						cwd: process.cwd(),
						executionStarted: false,
						argsComplete: false,
						isPartial: true,
						expanded: false,
						showImages: false,
						isError: false,
						...overrides,
					})
					.render(120)
					.join("\n") ?? "",
			);

		expect(render()).toContain("Preparing delegation");
		expect(render({ executionStarted: true, argsComplete: true })).toContain("Delegating 1 agent");
		expect(render({ executionStarted: true, argsComplete: true, isPartial: false, isError: true })).toContain(
			"Delegation failed",
		);
		const control = definition.renderCall?.({ action: "status", runId: "agent-7" }, theme, {
			args: { action: "status", runId: "agent-7" },
			toolCallId: "agent-control",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		});
		expect(stripAnsi(control?.render(120).join("\n") ?? "")).toContain("Agent status complete · agent-7");
	});

	test("does not surface validation errors while Agent arguments are still streaming", () => {
		const definition = createAgentToolDefinition(process.cwd());
		// Half-streamed parallel call: the trailing task has no prompt yet.
		const partialArgs = {
			background: true,
			tasks: [
				{ subagent_type: "explore", description: "Disk usage snapshot", prompt: "inventory disk" },
				{ subagent_type: "explore", description: "Git repos inventory" },
			],
		};
		const renderPartial = (argsComplete: boolean) =>
			stripAnsi(
				definition
					.renderCall?.(partialArgs, theme, {
						args: partialArgs,
						toolCallId: "agent-partial-args",
						invalidate: () => {},
						lastComponent: undefined,
						state: {},
						cwd: process.cwd(),
						executionStarted: false,
						argsComplete,
						isPartial: true,
						expanded: false,
						showImages: false,
						isError: false,
					})
					.render(120)
					.join("\n") ?? "",
			);

		const streaming = renderPartial(false);
		expect(streaming).not.toContain("require subagent_type and prompt");
		expect(streaming).toContain("preparing delegation");
		// Once arguments are complete the same shape is a genuine caller error.
		expect(renderPartial(true)).toContain("require subagent_type and prompt");
	});

	test("keeps parallel Agent rows in source order while routing resolved run metadata", () => {
		const definition = createAgentToolDefinition(process.cwd());
		const args = {
			tasks: [
				{ agent: "explore", task: "First task", description: "First child" },
				{ agent: "reviewer", task: "Second task", description: "Second child" },
			],
		};
		const run = (
			agent: string,
			task: string,
			description: string,
			provider: string,
			id: string,
		): AgentRunDetails => ({
			agent,
			source: "builtin",
			task,
			description,
			status: "running",
			context: {
				mode: "default",
				includeTranscript: false,
				includeProjectContext: true,
				includeSkills: true,
				includeAppendSystemPrompt: true,
			},
			model: { provider, id },
			thinking: "high",
			effectiveTools: [],
			deniedTools: [],
			durationMs: 100,
			toolCallCount: 1,
			messageCount: 1,
			currentToolName: "read",
			currentToolArgsPreview: task,
			recentToolCalls: [],
			recentOutputSnippets: [],
			loadedSkills: [],
			invokedSkills: { count: 0, names: [] },
		});
		const details: AgentToolDetails = {
			mode: "parallel",
			status: "running",
			// Registry snapshots may arrive in completion/update order; presentation must not.
			runs: [
				run("reviewer", "Second task", "Second child", "openai", "gpt-5.6"),
				run("explore", "First task", "First child", "anthropic", "claude-opus-4-8"),
			],
		};
		const component = definition.renderCall?.(args, theme, {
			args,
			toolCallId: "parallel-source-order",
			invalidate: () => {},
			lastComponent: undefined,
			state: { details },
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: true,
			expanded: false,
			showImages: false,
			isError: false,
		});
		const rendered = stripAnsi(component?.render(180).join("\n") ?? "");
		expect(rendered.indexOf("First child")).toBeLessThan(rendered.indexOf("Second child"));
		expect(rendered).toContain("First child · explore");
		expect(rendered).toContain("anthropic/claude-opus-4-8 · thinking high");
		expect(rendered).toContain("Second child · reviewer");
		expect(rendered).toContain("openai/gpt-5.6 · thinking high");
	});

	test("distinguishes parked Agent runs from real interruptions", () => {
		const definition = createAgentToolDefinition(process.cwd());
		const args = { agent: "general", task: "Persistent helper", description: "Persistent helper" };
		const run = {
			agent: "general",
			source: "builtin" as const,
			task: "Persistent helper",
			description: "Persistent helper",
			status: "interrupted" as const,
			context: {
				mode: "default" as const,
				includeTranscript: false,
				includeProjectContext: true,
				includeSkills: true,
				includeAppendSystemPrompt: true,
			},
			model: { provider: "clawrouter", id: "gpt-5.6" },
			thinking: "high" as const,
			effectiveTools: [],
			deniedTools: [],
			durationMs: 100,
			toolCallCount: 0,
			messageCount: 1,
			recentToolCalls: [],
			recentOutputSnippets: [],
			loadedSkills: [],
			invokedSkills: { count: 0, names: [] },
		};
		const render = (parked: boolean) =>
			stripAnsi(
				definition
					.renderCall?.(args, theme, {
						args,
						toolCallId: `parked-${parked}`,
						invalidate: () => {},
						lastComponent: undefined,
						state: { details: { mode: "single", status: "interrupted", runs: [run], parked } },
						cwd: process.cwd(),
						executionStarted: true,
						argsComplete: true,
						isPartial: false,
						expanded: false,
						showImages: false,
						isError: false,
					})
					?.render(160)
					.join("\n") ?? "",
			);
		expect(render(true)).toContain("Delegated 1 agent");
		expect(render(true)).toContain("Idle");
		expect(render(false)).toContain("Delegation failed");
		expect(render(false)).toContain("Interrupted");
	});

	test("keeps a settled background Agent row live from the recent-run registry", async () => {
		clearAgentRecentRunsForTests();
		const requestRender = vi.fn();
		const ui = { requestRender } as unknown as TUI;
		const run = startAgentRecentRun("parallel", [{ agent: "explore", task: "Map renderer" }], { background: true });
		const running = {
			mode: "parallel" as const,
			status: "running" as const,
			runs: [
				{
					agent: "explore",
					source: "builtin" as const,
					task: "Map renderer",
					description: "Map Agent renderer",
					status: "running" as const,
					context: {
						mode: "default" as const,
						includeTranscript: false,
						includeProjectContext: true,
						includeSkills: true,
						includeAppendSystemPrompt: true,
					},
					model: { provider: "clawrouter", id: "claude-sonnet" },
					thinking: "high" as const,
					effectiveTools: [],
					deniedTools: [],
					durationMs: 1200,
					toolCallCount: 1,
					messageCount: 1,
					currentToolName: "grep",
					currentToolArgsPreview: "Agent renderer",
					recentToolCalls: [],
					recentOutputSnippets: [],
					loadedSkills: [],
					invokedSkills: { count: 0, names: [] },
				},
			],
		};
		updateAgentRecentRunProgress(run, running);
		const args = {
			tasks: [{ agent: "explore", task: "Map renderer", description: "Map Agent renderer" }],
			background: true,
		};
		const definition = createAgentToolDefinition(process.cwd());
		const direct = definition.renderCall?.(args, theme, {
			args,
			toolCallId: "direct",
			invalidate: () => {},
			lastComponent: undefined,
			state: { runId: run.id, details: { ...running, runId: run.id, background: true } },
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		});
		expect(stripAnsi(direct?.render(140).join("\n") ?? "")).toContain("Delegating 1 agent");
		const component = new ToolExecutionComponent(
			"agent",
			"tool-agent-background",
			args,
			{},
			definition,
			ui,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult(
			{
				content: [{ type: "text", text: "started" }],
				details: { ...running, runId: run.id, background: true },
				isError: false,
			},
			false,
		);
		await Promise.resolve();

		let rendered = stripAnsi(component.render(140).join("\n"));
		expect(rendered).toContain("Delegating 1 agent");
		expect(rendered).toContain("Map Agent renderer · explore");
		expect(rendered).toContain("clawrouter/claude-sonnet · thinking high");
		expect(rendered).toContain("grep: Agent renderer");

		const detachedRequestRender = vi.fn();
		const detached = new ToolExecutionComponent(
			"agent",
			"tool-agent-detached",
			args,
			{},
			definition,
			{ requestRender: detachedRequestRender } as unknown as TUI,
			process.cwd(),
		);
		detached.markExecutionStarted();
		detached.setArgsComplete();
		detached.updateResult(
			{ content: [], details: { ...running, runId: run.id, background: true }, isError: false },
			false,
		);
		detachedRequestRender.mockClear();
		detached.dispose();
		await Promise.resolve();
		expect(detachedRequestRender).not.toHaveBeenCalled();
		updateAgentRecentRunProgress(run, {
			...running,
			runs: [{ ...running.runs[0], currentToolName: "read", currentToolArgsPreview: "next.ts" }],
		});
		expect(detachedRequestRender).not.toHaveBeenCalled();

		updateAgentRecentRunProgress(run, {
			...running,
			status: "completed",
			runs: [
				{
					...running.runs[0],
					status: "completed",
					currentToolName: undefined,
					durationMs: 2200,
					toolCallCount: 2,
					finalOutput: "hidden until expanded",
				},
			],
		});
		expect(requestRender).toHaveBeenCalled();
		rendered = stripAnsi(component.render(140).join("\n"));
		expect(rendered).toContain("Delegated 1 agent");
		expect(rendered.match(/Done · 2 tool uses · 2s/g)).toHaveLength(1);
		expect(rendered).not.toContain("hidden until expanded");

		component.setExpanded(true);
		expect(stripAnsi(component.render(140).join("\n"))).toContain("hidden until expanded");
		clearAgentRecentRunsForTests();
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n[^\S\n]*\[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bRead\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("Read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("does not syntax-highlight read errors based on the requested file path", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-error-highlighting",
			{ path: "config.exs", offset: 120, limit: 130 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const error = "Offset 120 is beyond end of file (96 lines total)";
		component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true }, false);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		// Fork uses PascalCase tool labels (commit dbf43ea8); upstream uses lowercase.
		expect(collapsed).toContain("Read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "Read resource .pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "AGENTS.override.md",
			path: join(process.cwd(), ".pi", "AGENTS.override.md"),
			content: "Hidden override instructions",
			compact: "Read resource .pi/AGENTS.override.md",
			hidden: "Hidden override instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `Read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "Read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(200).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(200).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "Read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}
});
