import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
	clearAgentRecentRunsForTests,
	markAgentRecentRunNeedsAttention,
	startAgentRecentRun,
} from "../src/core/agents/status.ts";
import { hookAgents, hookAgentsTools, hookAgentsUI } from "../src/core/extensions/agents.ts";
import { addAction, getActions, load, removeAction } from "../src/core/extensions/extension-hooks.ts";
import type { ExtensionFooterSpec, ExtensionMainPaneFactory } from "../src/core/extensions/types.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createFakePi(options?: { hasMainPane?: (id: string) => boolean; cwd?: string }) {
	const tools: string[] = [];
	const footers = new Map<string, ExtensionFooterSpec>();
	const panes = new Map<string, ExtensionMainPaneFactory>();
	const showMainPane = vi.fn();
	const hasMainPane = vi.fn(options?.hasMainPane ?? (() => false));
	return {
		pi: {
			cwd: options?.cwd ?? "/repo",
			harness: { use: () => undefined },
			registerTool(tool: { name: string }) {
				tools.push(tool.name);
			},
			registerMainPane(id: string, factory: ExtensionMainPaneFactory) {
				panes.set(id, factory);
			},
			showMainPane,
			hasMainPane,
			registerFooter(id: string, spec: ExtensionFooterSpec) {
				footers.set(id, spec);
			},
		},
		tools,
		footers,
		panes,
		showMainPane,
		hasMainPane,
	};
}

describe("agents UI", () => {
	beforeAll(() => initTheme(undefined, false));
	beforeEach(() => clearAgentRecentRunsForTests());

	test("registers an activatable background agent status footer", () => {
		const fake = createFakePi();
		hookAgents(fake.pi as never);

		expect(fake.tools).toEqual(["agent", "Agent", "Task"]);
		expect(fake.panes.has("agents-status")).toBe(true);

		const footer = fake.footers.get("agents-status");
		expect(footer).toBeDefined();
		expect(footer?.visible?.()).toBe(false);

		startAgentRecentRun("single", [{ agent: "explore", task: "Map files" }], { background: true });

		expect(footer?.visible?.()).toBe(true);
		expect(
			footer?.render({
				width: 120,
				theme: { fg: (_color: string, value: string) => value } as never,
				selected: true,
			}),
		).toContain("Background: 1 running");

		footer?.onActivate({ close: vi.fn() });
		expect(fake.showMainPane).toHaveBeenCalledWith("agents-status");
	});

	// Regression: the footer pill's render() previously ignored the `selected`
	// arg entirely (`render: () => formatTaskFooterStatus() ?? ""`), so
	// Down/pill-focus never produced any visible highlight for this pill even
	// though the pill-nav state machine correctly tracked and passed selection
	// through. Assert the rendered text actually differs between selected and
	// unselected using a theme stub that makes styling observable.
	test("styles the footer pill differently when selected vs unselected", () => {
		const fake = createFakePi();
		hookAgents(fake.pi as never);
		startAgentRecentRun("single", [{ agent: "explore", task: "Map files" }], { background: true });

		const footer = fake.footers.get("agents-status");
		expect(footer).toBeDefined();

		const theme = { fg: (color: string, value: string) => `[${color}]${value}[/${color}]` } as never;
		const unselected = footer?.render({ width: 120, theme, selected: false });
		const selected = footer?.render({ width: 120, theme, selected: true });

		expect(selected).not.toEqual(unselected);
		expect(selected).toContain("[accent]");
	});

	test("registers a separate observer footer that does not trip the Background pill", () => {
		const fake = createFakePi();
		hookAgents(fake.pi as never);
		const backgroundFooter = fake.footers.get("agents-status");
		const observerFooter = fake.footers.get("observer-status");
		expect(backgroundFooter).toBeDefined();
		expect(observerFooter).toBeDefined();

		const observer = startAgentRecentRun(
			"single",
			[{ agent: "general", task: "You are now armed as a background observer." }],
			{ background: true, kind: "observer" },
		);

		expect(backgroundFooter?.visible?.()).toBe(false);
		expect(observerFooter?.visible?.()).toBe(true);
		expect(
			observerFooter?.render({
				width: 120,
				theme: { fg: (_color: string, value: string) => value } as never,
				selected: false,
			}),
		).toContain(`Observer: 1 armed · ${observer.id}`);
	});

	// Regression: agents.ts used to bundle tool-schema registration and the
	// interactive footer pill/pane into a single "agents" load action. A
	// downstream consumer that needs to override the native agent/Agent/Task
	// tool schemas (to avoid duplicate/conflicting definitions) had to remove
	// the *entire* action to do so, silently deleting the footer pill and
	// main pane with it and leaving Down/Enter/Escape on that pill dead —
	// the observed post-landing defect. Splitting tool registration
	// ("agentsTools") from UI registration ("agentsUI") lets a consumer drop
	// only the tool schemas while the interactive surface stays intact.
	test("UI registration survives a consumer removing only the agents tool-schema action", () => {
		expect(getActions(load).map((action) => action.id)).toEqual(expect.arrayContaining(["agentsTools", "agentsUI"]));

		// Simulate a profile overriding native tool schemas the way
		// my-pi's native-tool-overrides extension does: remove only the
		// tool-registering action, leave the UI action alone.
		removeAction(load, "agentsTools");
		try {
			const remaining = getActions(load).map((action) => action.id);
			expect(remaining).not.toContain("agentsTools");
			expect(remaining).toContain("agentsUI");

			const fake = createFakePi();
			hookAgentsUI(fake.pi as never);
			expect(fake.panes.has("agents-status")).toBe(true);
			expect(fake.footers.has("agents-status")).toBe(true);
			expect(fake.tools).toEqual([]);

			// The tool-schema half is independently callable too, so a consumer
			// swapping schemas doesn't need core's registration at all.
			hookAgentsTools(fake.pi as never);
			expect(fake.tools).toEqual(["agent", "Agent", "Task"]);
		} finally {
			// Restore global hook-registry state for other tests in this process.
			addAction(load, "agentsTools", hookAgentsTools);
		}
	});

	test("Enter zooms into the live transcript for a running background agent row when the zoom pane is registered", () => {
		const fake = createFakePi({ hasMainPane: () => true, cwd: "/work/proj" });
		hookAgents(fake.pi as never);
		const run = startAgentRecentRun("single", [{ agent: "explore", task: "Map files" }], { background: true });

		const factory = fake.panes.get("agents-status");
		const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
		const pane = factory!({ requestRender: vi.fn() } as never, theme as never, { requestHide: vi.fn() } as never);

		pane.handleInput?.("\r");

		expect(fake.hasMainPane).toHaveBeenCalledWith("zoom");
		expect(fake.showMainPane).toHaveBeenCalledWith("zoom", { taskId: run.id, sessionConfig: { cwd: "/work/proj" } });
	});

	test("Enter falls back to static detail when no extension has registered the zoom pane", () => {
		const fake = createFakePi({ hasMainPane: () => false });
		hookAgents(fake.pi as never);
		startAgentRecentRun("single", [{ agent: "explore", task: "Map files" }], { background: true });

		const factory = fake.panes.get("agents-status");
		const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
		const pane = factory!({ requestRender: vi.fn() } as never, theme as never, { requestHide: vi.fn() } as never);

		pane.handleInput?.("\r");

		expect(fake.showMainPane).not.toHaveBeenCalledWith("zoom", expect.anything());
		expect(pane.render(120).join("\n")).toContain("single");
	});

	test("footer pill uses a distinct color for needs-attention vs plain running", () => {
		const fake = createFakePi();
		hookAgents(fake.pi as never);
		const run = startAgentRecentRun("single", [{ agent: "explore", task: "Map files" }], { background: true });

		const theme = { fg: (color: string, value: string) => `[${color}]${value}[/${color}]`, bold: (v: string) => v };
		const footer = fake.footers.get("agents-status");

		const running = footer?.render({ width: 120, theme: theme as never, selected: false });
		expect(running).toContain("[dim]");

		markAgentRecentRunNeedsAttention(run, "Should I proceed?");
		const attention = footer?.render({ width: 120, theme: theme as never, selected: false });
		expect(attention).toContain("[warning]");
		expect(attention).not.toContain("[dim]");
	});

	test("pane ticks a live elapsed counter while a run is in progress and stops on dispose", () => {
		vi.useFakeTimers();
		try {
			const fake = createFakePi();
			hookAgents(fake.pi as never);
			const factory = fake.panes.get("agents-status");
			expect(factory).toBeDefined();

			startAgentRecentRun("single", [{ agent: "explore", task: "Map files" }], { background: true });

			const requestRender = vi.fn();
			const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
			const pane = factory!({ requestRender } as never, theme as never, { requestHide: vi.fn() } as never);

			// Running run -> a 1s repaint ticker advances the elapsed counter.
			vi.advanceTimersByTime(3000);
			expect(requestRender).toHaveBeenCalled();
			expect(pane.render(120).join("\n")).toContain("3s");

			// Disposing releases the interval so no further repaints fire.
			expect(pane.dispose).toBeDefined();
			pane.dispose?.();
			requestRender.mockClear();
			vi.advanceTimersByTime(5000);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
