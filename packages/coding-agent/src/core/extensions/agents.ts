import { getKeybindings, truncateToWidth } from "@valkyriweb/pi-tui";
import {
	formatAgentRunDetailView,
	shouldZoomAgentRunRow,
} from "../../modes/interactive/components/agent-runs-selector.ts";
import { keyHint, rawKeyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { AGENTS_ENGINE_SERVICE_ID, type AgentEngine, getContextAgentEngine } from "../agents/engine.ts";
import { formatAgentDurationMs, listAgentRecentRuns } from "../agents/status.ts";
import { findTaskAdapter, listTasks, subscribeTasks } from "../tasks/registry.ts";
import { formatTaskFooterStatus, formatTaskStatus, taskIsWorking, taskNeedsInput } from "../tasks/status.ts";
import type { TaskSnapshot } from "../tasks/types.ts";
import {
	createAgentToolDefinition,
	createTaskToolDefinition,
	createUppercaseAgentToolDefinition,
} from "../tools/agent.ts";
import { getExtensionProcessService } from "./extension-api-fork.ts";
import { addAction, load } from "./extension-hooks.ts";
import type {
	ExtensionAPI,
	ExtensionFooterRenderCtx,
	ExtensionMainPaneComponent,
	ExtensionMainPaneFactory,
} from "./types.ts";

const AGENTS_PANE_ID = "agents-status";

function footerNeedsAttention(): boolean {
	return listTasks().some(taskNeedsInput);
}

/**
 * Color the footer pill by state (agents-ux-parity color/attention ask):
 * loud `warning` when something needs attention or an agent failed/
 * interrupted, quiet `dim` while merely running. Previously every state
 * rendered identically (plain, or accent-only-when-selected), so "agents
 * are active" never read distinctly from "an agent needs you".
 */
function renderFooterText(ctx: ExtensionFooterRenderCtx): string {
	const text = formatTaskFooterStatus();
	if (ctx.selected) return ctx.theme.fg("accent", text);
	return ctx.theme.fg(footerNeedsAttention() ? "warning" : "dim", text);
}

function getAgentEngine(pi: ExtensionAPI): AgentEngine | undefined {
	return (
		getContextAgentEngine() ??
		getExtensionProcessService<AgentEngine>(AGENTS_ENGINE_SERVICE_ID) ??
		pi.harness.use<AgentEngine>(AGENTS_ENGINE_SERVICE_ID)
	);
}

/**
 * Registers the native `agent`/`Agent`/`Task` tool schemas. Split out from
 * the UI wiring (`hookAgentsUI`) as its own load action so a profile that
 * overrides these tool schemas with its own native aliases (to avoid
 * duplicate/conflicting tool definitions under the same name) can remove
 * *only* this action and keep the interactive footer pill + main pane
 * intact. Before this split both concerns lived in one "agents" load
 * action, so any consumer that needed to swap the tool schemas had no way
 * to do so without also silently deleting the entire interactive surface —
 * that's exactly what happened downstream (a profile removing "agents" to
 * de-duplicate tool schemas also removed the agents-status footer pill and
 * pane with no equivalent replacement, leaving Down/Enter/Escape on that
 * pill dead).
 */
export function hookAgentsTools(pi: ExtensionAPI): void {
	const options = {
		getEngine: () => getAgentEngine(pi),
		getParentModel: () => getAgentEngine(pi)?.snapshot().model,
		getParentThinkingLevel: () => getAgentEngine(pi)?.snapshot().thinkingLevel ?? "off",
	};
	pi.registerTool(createAgentToolDefinition("", options));
	pi.registerTool(createUppercaseAgentToolDefinition("", options));
	pi.registerTool(createTaskToolDefinition("", options));
}

/**
 * Registers the interactive agents-status main pane and its footer pill.
 * Split out from `hookAgentsTools` (see its docstring) so this UI can be
 * kept registered independently of which tool schemas provide the
 * underlying `agent`/`Agent`/`Task` capabilities.
 */
export function hookAgentsUI(pi: ExtensionAPI): void {
	pi.registerMainPane(AGENTS_PANE_ID, createAgentsPaneFactory(pi));

	pi.registerFooter(AGENTS_PANE_ID, {
		render: (ctx) => renderFooterText(ctx),
		onActivate: () => pi.showMainPane(AGENTS_PANE_ID),
	});
}

/** Combined registration (tools + UI), kept for callers that want the full
 * default surface in one call. The default load actions register the two
 * halves separately (see bottom of file) so they can be removed independently. */
export function hookAgents(pi: ExtensionAPI): void {
	hookAgentsTools(pi);
	hookAgentsUI(pi);
}

const MAX_COMPLETED_PANE_ROWS = 6;

interface PaneTaskGroups {
	needsInput: TaskSnapshot[];
	working: TaskSnapshot[];
	completed: TaskSnapshot[];
}

function byNewestStart(a: TaskSnapshot, b: TaskSnapshot): number {
	return b.startedAt - a.startedAt;
}

/**
 * Regroups tasks into the three sections the pane renders, needs-input
 * sorted first within its own section and ahead of Working/Completed —
 * mirrors the footer's "attention wins" priority. Completed is bounded to
 * `MAX_COMPLETED_PANE_ROWS` so a long session's history doesn't push the
 * live sections off-screen. "idle" tasks (parked persistent forks) land in
 * Working — they're alive and awaiting their next turn, not finished.
 */
function groupPaneTasks(tasks: TaskSnapshot[]): PaneTaskGroups {
	const needsInput: TaskSnapshot[] = [];
	const working: TaskSnapshot[] = [];
	const completed: TaskSnapshot[] = [];
	for (const task of [...tasks].sort(byNewestStart)) {
		if (taskNeedsInput(task)) needsInput.push(task);
		else if (taskIsWorking(task)) working.push(task);
		else completed.push(task);
	}
	return { needsInput, working, completed: completed.slice(0, MAX_COMPLETED_PANE_ROWS) };
}

function flattenPaneGroups(groups: PaneTaskGroups): TaskSnapshot[] {
	return [...groups.needsInput, ...groups.working, ...groups.completed];
}

/**
 * Compact per-task label for the pane list: the caller's exact `label`
 * (`ForkAgentOptions.description` for extension-launched forks) when set,
 * else the adapter's generic `description` preview. Deliberately never the
 * raw task id or a `[type]` tag — those stay in the fallback detail view.
 */
function paneRowLabel(task: TaskSnapshot): string {
	return task.label ?? task.description;
}

function paneRowStatusText(task: TaskSnapshot): string {
	if (taskNeedsInput(task)) return theme.fg("warning", "needs input");
	switch (task.status) {
		case "running":
			return theme.fg("accent", "working");
		case "idle":
			return theme.fg("muted", "idle");
		case "completed":
			return theme.fg("success", "done");
		case "failed":
			return theme.fg("error", "failed");
		case "cancelled":
		case "killed":
			return theme.fg("muted", task.status);
		default:
			return theme.fg("muted", task.status);
	}
}

function paneRowElapsed(task: TaskSnapshot): string {
	return formatAgentDurationMs(Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt));
}

/** Compact row: status + label + elapsed only — no task id, no `[type]` tag (agents-footer-parity). */
function formatPaneRow(task: TaskSnapshot, selected: boolean): string {
	const prefix = selected ? theme.fg("accent", "→ ") : "  ";
	const label = paneRowLabel(task);
	const labelText = selected ? theme.fg("accent", label) : theme.fg("text", label);
	return `${prefix}${paneRowStatusText(task)} ${labelText} ${theme.fg("muted", paneRowElapsed(task))}`;
}

// The detail view (Enter on a row with no zoom target) is the deliberate
// fallback surface that DOES show internal ids/session paths/tool calls —
// only the compact rows above stay id/type-free.
function formatPaneDetail(task: TaskSnapshot | undefined): string {
	if (!task) return theme.fg("muted", "No background runtime tasks");
	if (task.type === "local_agent") {
		const run = listAgentRecentRuns().find((candidate) => candidate.id === task.id);
		if (run) return formatAgentRunDetailView(run);
	}
	return formatTaskStatus([task], task.id);
}

class AgentsPane implements ExtensionMainPaneComponent {
	private readonly tui: { requestRender(): void };
	private readonly theme: any;
	private readonly requestHide: () => void;
	private readonly pi: ExtensionAPI;
	private readonly unsubscribe: () => void;
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private selectedIndex = 0;
	private showDetail = false;

	constructor(tui: { requestRender(): void }, theme: any, requestHide: () => void, pi: ExtensionAPI) {
		this.tui = tui;
		this.theme = theme;
		this.requestHide = requestHide;
		this.pi = pi;
		this.unsubscribe = subscribeTasks(() => {
			this.refreshTickTimer();
			this.tui.requestRender();
		});
		this.refreshTickTimer();
	}

	dispose(): void {
		this.unsubscribe();
		this.clearTickTimer();
	}

	// Repaint once a second while any run is in progress so the elapsed seconds
	// counter advances; idle otherwise so we are not holding a live interval.
	private refreshTickTimer(): void {
		if (listTasks().some((task) => task.status === "running")) {
			if (this.tickTimer) return;
			this.tickTimer = setInterval(() => this.tui.requestRender(), 1000);
			this.tickTimer.unref?.();
			return;
		}
		this.clearTickTimer();
	}

	private clearTickTimer(): void {
		if (!this.tickTimer) return;
		clearInterval(this.tickTimer);
		this.tickTimer = undefined;
	}

	private sortedTasks(): TaskSnapshot[] {
		return flattenPaneGroups(groupPaneTasks(listTasks()));
	}

	private selectedTask(): TaskSnapshot | undefined {
		const tasks = this.sortedTasks();
		if (tasks.length === 0) return undefined;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, tasks.length - 1));
		return tasks[this.selectedIndex];
	}

	onEscape(): boolean {
		if (this.showDetail) {
			this.showDetail = false;
			this.tui.requestRender();
			return true;
		}
		this.requestHide();
		return true;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel") || data === "\u001b") {
			this.onEscape();
			return;
		}
		if (this.showDetail) return;
		const tasks = this.sortedTasks();
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(Math.max(0, tasks.length - 1), this.selectedIndex + 1);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const task = this.selectedTask();
			if (!task) return;
			// Regression fix (agents-ux-parity footer round): a running background
			// local_agent row should zoom straight into its live transcript, the
			// same behavior `/agents runs` already gets from
			// `handleAgentRunSelectorAction` — not the static status-text detail
			// this pane previously always showed on Enter regardless of task
			// state. `hasMainPane` makes this a safe, generic fallback: when no
			// extension has registered the "zoom" pane (e.g. a lean profile
			// without `pi-agent-ui` loaded), fall through to the static detail
			// view exactly as before.
			if (task.type === "local_agent") {
				const run = listAgentRecentRuns().find((candidate) => candidate.id === task.id);
				if (run && shouldZoomAgentRunRow(run) && this.pi.hasMainPane?.("zoom")) {
					this.pi.showMainPane("zoom", { taskId: run.id, sessionConfig: { cwd: this.pi.cwd } });
					return;
				}
			}
			this.showDetail = true;
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "app.agents.dismiss")) {
			const task = this.selectedTask();
			if (!task || !taskNeedsInput(task) || task.status !== "failed") return;
			const adapter = findTaskAdapter(task.id);
			void adapter?.acknowledge?.(task.id).then(() => this.tui.requestRender());
			return;
		}
		if (data === "x") {
			const task = this.selectedTask();
			if (!task) return;
			const adapter = findTaskAdapter(task.id);
			void (adapter?.kill?.(task.id) ?? adapter?.requestShutdown?.(task.id))?.then(() => this.tui.requestRender());
		}
	}

	render(width: number): string[] {
		const tasks = this.sortedTasks();
		const selected = this.selectedTask();
		const lines: string[] = [this.theme.fg("accent", this.theme.bold("Agents"))];
		if (this.showDetail) {
			lines.push("", ...formatPaneDetail(selected).split("\n"));
			lines.push("", rawKeyHint("esc", "back"));
		} else if (tasks.length === 0) {
			lines.push("", this.theme.fg("muted", "No agents or background tasks yet."));
		} else {
			const groups = groupPaneTasks(listTasks());
			let rowIndex = 0;
			const pushSection = (heading: string, sectionTasks: TaskSnapshot[]) => {
				if (sectionTasks.length === 0) return;
				lines.push("", this.theme.fg("muted", this.theme.bold(heading)));
				for (const task of sectionTasks) {
					lines.push(formatPaneRow(task, rowIndex === this.selectedIndex));
					rowIndex += 1;
				}
			};
			pushSection("Needs input", groups.needsInput);
			pushSection("Working", groups.working);
			pushSection("Completed", groups.completed);
			lines.push(
				"",
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "open") +
					"  " +
					rawKeyHint("x", "stop") +
					"  " +
					keyHint("app.agents.dismiss", "dismiss failed") +
					"  " +
					keyHint("tui.select.cancel", "close"),
			);
		}
		return lines.slice(0, 28).map((line) => truncateToWidth(line, width, this.theme.fg("dim", "…")));
	}
}

function createAgentsPaneFactory(pi: ExtensionAPI): ExtensionMainPaneFactory {
	return (tui, theme, api) => new AgentsPane(tui, theme, api.requestHide, pi);
}

addAction(load, "agentsTools", hookAgentsTools);
addAction(load, "agentsUI", hookAgentsUI);
