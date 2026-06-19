import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	clearAgentRecentRunsForTests,
	finishAgentRecentRun,
	startAgentRecentRun,
} from "../src/core/agents/status.ts";
import { hookBackgroundTasksUi } from "../src/core/extensions/background-tasks-ui.ts";
import type { ExtensionFooterSpec, ExtensionMainPaneFactory } from "../src/core/extensions/types.ts";
import { killAllBashBgJobs, spawnBashBackground } from "../src/core/tools/bash.ts";

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function createFakePi() {
	const tools: string[] = [];
	const footers = new Map<string, ExtensionFooterSpec>();
	const panes = new Set<string>();
	const paneFactories = new Map<string, ExtensionMainPaneFactory>();
	const showMainPane = vi.fn();
	const commands = new Map<string, unknown>();
	const theme = {
		fg: (_color: string, value: string) => value,
		bold: (value: string) => value,
	};
	return {
		pi: {
			registerTool(tool: { name: string }) {
				tools.push(tool.name);
			},
			registerMainPane(id: string, factory: ExtensionMainPaneFactory) {
				panes.add(id);
				paneFactories.set(id, factory);
			},
			showMainPane,
			registerFooter(id: string, spec: ExtensionFooterSpec) {
				footers.set(id, spec);
			},
			registerCommand(name: string, command: unknown) {
				commands.set(name, command);
			},
		},
		tools,
		footers,
		panes,
		paneFactories,
		commands,
		showMainPane,
		theme,
	};
}

describe("background tasks UI", () => {
	let bashTempDir = "";

	beforeEach(() => {
		killAllBashBgJobs();
		clearAgentRecentRunsForTests();
		bashTempDir = mkdtempSync(join(tmpdir(), "bg-tasks-ui-"));
	});

	afterEach(() => {
		killAllBashBgJobs();
		clearAgentRecentRunsForTests();
		vi.useRealTimers();
		if (bashTempDir) rmSync(bashTempDir, { recursive: true, force: true });
	});

	test("registers runtime background list, /tasks, and an activatable dynamic footer", () => {
		const fake = createFakePi();
		hookBackgroundTasksUi(fake.pi as never);

		expect(fake.tools).toEqual(["TaskStop", "TaskBackgroundList"]);
		expect(fake.panes.has("background-tasks")).toBe(true);
		expect(fake.commands.has("tasks")).toBe(true);

		const footer = fake.footers.get("background-tasks");
		expect(footer).toBeDefined();
		expect(footer?.visible?.()).toBe(false);

		startAgentRecentRun("single", [{ agent: "explore", task: "Foreground task" }]);
		expect(footer?.visible?.()).toBe(false);

		spawnBashBackground("sleep 30", bashTempDir);
		startAgentRecentRun("single", [{ agent: "explore", task: "Map task state" }], { background: true });

		expect(footer?.visible?.()).toBe(true);
		const rendered = stripAnsi(footer!.render({ width: 80, theme: fake.theme as never, selected: true }));
		expect(rendered).toContain("1 agent");
		expect(rendered).toContain("1 sh");
		expect(rendered).toContain("enter tasks");

		footer?.onActivate?.({ close: vi.fn() });
		expect(fake.showMainPane).toHaveBeenCalledWith("background-tasks");
	});

	test("main pane ignores foreground agent runs", () => {
		vi.useFakeTimers();
		const fake = createFakePi();
		hookBackgroundTasksUi(fake.pi as never);
		startAgentRecentRun("single", [{ agent: "explore", task: "Foreground task" }]);

		const footer = fake.footers.get("background-tasks");
		expect(footer?.visible?.()).toBe(false);
		const factory = fake.paneFactories.get("background-tasks");
		expect(factory).toBeDefined();
		const requestRender = vi.fn();
		const component = factory!(
			{ requestRender } as never,
			fake.theme as never,
			{ payload: undefined, requestHide: vi.fn() },
		);

		expect(component.render(120).join("\n")).toContain("No background tasks.");
		vi.advanceTimersByTime(3000);
		expect(requestRender).not.toHaveBeenCalled();
		component.dispose?.();
	});

	test("main pane repaints and displays updated elapsed time once per second while an agent task is active", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const fake = createFakePi();
		hookBackgroundTasksUi(fake.pi as never);
		startAgentRecentRun("single", [{ agent: "explore", task: "Map task state" }], { background: true });

		const factory = fake.paneFactories.get("background-tasks");
		expect(factory).toBeDefined();
		const requestRender = vi.fn();
		const component = factory!(
			{ requestRender } as never,
			fake.theme as never,
			{ payload: undefined, requestHide: vi.fn() },
		);

		expect(component.render(120).join("\n")).toContain("running 0s explore: Map task state");
		expect(requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(999);
		expect(requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(3000);
		expect(requestRender).toHaveBeenCalledTimes(4);
		expect(component.render(120).join("\n")).toContain("running 4s explore: Map task state");

		component.dispose?.();
		vi.advanceTimersByTime(1000);
		expect(requestRender).toHaveBeenCalledTimes(4);
	});

	test("main pane starts the repaint ticker for bash-only tasks", () => {
		vi.useFakeTimers();
		const fake = createFakePi();
		hookBackgroundTasksUi(fake.pi as never);
		spawnBashBackground("sleep 30", bashTempDir);

		const factory = fake.paneFactories.get("background-tasks");
		expect(factory).toBeDefined();
		const requestRender = vi.fn();
		const component = factory!(
			{ requestRender } as never,
			fake.theme as never,
			{ payload: undefined, requestHide: vi.fn() },
		);

		expect(component.render(120).join("\n")).toContain("[sh] running");
		vi.advanceTimersByTime(1000);
		expect(requestRender).toHaveBeenCalledTimes(1);
		component.dispose?.();
	});

	test("main pane stops repainting when the last active task naturally completes", () => {
		vi.useFakeTimers();
		const fake = createFakePi();
		hookBackgroundTasksUi(fake.pi as never);
		const run = startAgentRecentRun("single", [{ agent: "explore", task: "Map task state" }], { background: true });

		const factory = fake.paneFactories.get("background-tasks");
		expect(factory).toBeDefined();
		const requestRender = vi.fn();
		const component = factory!(
			{ requestRender } as never,
			fake.theme as never,
			{ payload: undefined, requestHide: vi.fn() },
		);

		vi.advanceTimersByTime(1000);
		expect(requestRender).toHaveBeenCalledTimes(1);
		finishAgentRecentRun(run, { mode: "single", status: "completed", runs: [] });
		expect(requestRender).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(3000);
		expect(requestRender).toHaveBeenCalledTimes(2);

		component.dispose?.();
	});

	test("main pane keeps interrupted agents visible without running the live repaint ticker", () => {
		vi.useFakeTimers();
		const fake = createFakePi();
		hookBackgroundTasksUi(fake.pi as never);
		const run = startAgentRecentRun("single", [{ agent: "explore", task: "Map task state" }], { background: true });

		const factory = fake.paneFactories.get("background-tasks");
		expect(factory).toBeDefined();
		const requestRender = vi.fn();
		const component = factory!(
			{ requestRender } as never,
			fake.theme as never,
			{ payload: undefined, requestHide: vi.fn() },
		);

		finishAgentRecentRun(run, { mode: "single", status: "interrupted", runs: [] });
		expect(component.render(120).join("\n")).toContain("interrupted 0s explore: Map task state");
		expect(requestRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(3000);
		expect(requestRender).toHaveBeenCalledTimes(1);

		component.dispose?.();
	});
});
