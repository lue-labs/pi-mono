import { getKeybindings, truncateToWidth } from "@valkyriweb/pi-tui";
import {
	formatAgentRunDetailView,
	formatAgentRunRow,
	shouldZoomAgentRunRow,
} from "../../modes/interactive/components/agent-runs-selector.ts";
import { keyHint, rawKeyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { AGENTS_ENGINE_SERVICE_ID, type AgentEngine } from "../agents/engine.ts";
import { listAgentRecentRuns } from "../agents/status.ts";
import { findTaskAdapter, listTasks, subscribeTasks } from "../tasks/registry.ts";
import { formatTaskFooterStatus, formatTaskStatus } from "../tasks/status.ts";
import type { TaskSnapshot } from "../tasks/types.ts";
import {
	createAgentToolDefinition,
	createTaskToolDefinition,
	createUppercaseAgentToolDefinition,
} from "../tools/agent.ts";
import { addAction, load } from "./extension-hooks.ts";
import type {
	ExtensionAPI,
	ExtensionFooterRenderCtx,
	ExtensionMainPaneComponent,
	ExtensionMainPaneFactory,
} from "./types.ts";

const AGENTS_PANE_ID = "agents-status";

function footerNeedsAttention(): boolean {
	return listTasks().some((task) => {
		if (task.status === "interrupted" || task.status === "failed") return true;
		if (task.status !== "running" || task.type !== "local_agent") return false;
		return listAgentRecentRuns().find((run) => run.id === task.id)?.needsAttention ?? false;
	});
}

/**
 * Color the footer pill by state (agents-ux-parity color/attention ask):
 * loud `warning` when something needs attention or an agent failed/
 * interrupted, quiet `dim` while merely running. Previously every state
 * rendered identically (plain, or accent-only-when-selected), so "agents
 * are active" never read distinctly from "an agent needs you".
 */
function renderFooterText(ctx: ExtensionFooterRenderCtx): string {
	const text = formatTaskFooterStatus() ?? "";
	if (!text) return text;
	if (ctx.selected) return ctx.theme.fg("accent", text);
	return ctx.theme.fg(footerNeedsAttention() ? "warning" : "dim", text);
}

function getAgentEngine(pi: ExtensionAPI): AgentEngine | undefined {
	return pi.harness.use<AgentEngine>(AGENTS_ENGINE_SERVICE_ID);
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

	// Background-runtime status pill (agents + bash jobs). Reactive visibility:
	// the pill appears only while runtime tasks need attention.
	pi.registerFooter(AGENTS_PANE_ID, {
		render: (ctx) => renderFooterText(ctx),
		visible: () => formatTaskFooterStatus() !== undefined,
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

// Sort running/interrupted/failed tasks first (newest of those), then the
// rest newest-first — keeps the row a user is most likely to act on at the
// top without reshuffling completed history underneath it every tick.
function isPaneRelevant(task: TaskSnapshot): boolean {
	return task.status === "running" || task.status === "interrupted" || task.status === "failed";
}

function sortPaneTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
	return [...tasks].sort((a, b) => {
		const relevance = Number(isPaneRelevant(b)) - Number(isPaneRelevant(a));
		return relevance || b.startedAt - a.startedAt;
	});
}

/** Render a single row, reusing `agent-runs-selector.ts`'s formatter for native
 * agent runs (same row shape as `/agents runs`) and a compact fallback for
 * other task types (e.g. background bash jobs) that formatter doesn't cover. */
function formatPaneRow(task: TaskSnapshot, selected: boolean): string {
	if (task.type === "local_agent") {
		const run = listAgentRecentRuns().find((candidate) => candidate.id === task.id);
		if (run) return formatAgentRunRow(run, selected);
	}
	const prefix = selected ? `${theme.fg("accent", "→ ")}` : "  ";
	const id = selected ? theme.fg("accent", task.id) : theme.fg("text", task.id);
	const resumable = task.resumable ? theme.fg("warning", " resumable") : "";
	const error = task.error ? theme.fg("error", ` error: ${task.error}`) : "";
	return `${prefix}${id} [${task.type}] ${task.status}${resumable} ${task.description}${error}`;
}

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
		return sortPaneTasks(listTasks());
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
		const lines: string[] = [this.theme.fg("accent", this.theme.bold("Background task status"))];
		if (this.showDetail) {
			lines.push("", ...formatPaneDetail(selected).split("\n"));
			lines.push("", rawKeyHint("esc", "back"));
		} else if (tasks.length === 0) {
			lines.push("", this.theme.fg("muted", "No background runtime tasks."));
		} else {
			lines.push("");
			for (const [index, task] of tasks.entries()) lines.push(formatPaneRow(task, index === this.selectedIndex));
			lines.push(
				"",
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "details") +
					"  " +
					rawKeyHint("x", "stop") +
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
