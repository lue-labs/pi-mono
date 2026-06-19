import { truncateToWidth } from "@valkyriweb/pi-tui";
import { findTaskAdapter, listTasks, subscribeTasks } from "../tasks/index.ts";
import { isTerminalTaskStatus, type TaskSnapshot } from "../tasks/types.ts";
import { createTaskBackgroundListTool, createTaskStopTool } from "../tools/background-tasks.ts";
import { addAction, load } from "./extension-hooks.ts";
import type { ExtensionAPI, ExtensionMainPaneComponent, ExtensionMainPaneFactory } from "./types.ts";

const PANE_ID = "background-tasks";

function isBackgroundRuntimeTask(task: TaskSnapshot): boolean {
	return task.type !== "local_agent" || task.execution === "background";
}

function backgroundTasks(): TaskSnapshot[] {
	return listTasks().filter(isBackgroundRuntimeTask);
}

function activeTasks(): TaskSnapshot[] {
	return backgroundTasks().filter((task) => !isTerminalTaskStatus(task.status));
}

function liveRepaintTasks(): TaskSnapshot[] {
	return activeTasks().filter((task) => task.status === "running" || task.status === "idle");
}

function countByType(tasks: TaskSnapshot[]): { agents: number; shells: number; monitors: number; total: number } {
	let agents = 0;
	let shells = 0;
	let monitors = 0;
	for (const task of tasks) {
		if (task.type === "local_agent") agents += 1;
		else if (task.type === "local_bash") shells += 1;
		else if (task.type === "monitor") monitors += 1;
	}
	return { agents, shells, monitors, total: tasks.length };
}

function footerText(theme: any, selected: boolean): string {
	const counts = countByType(activeTasks());
	const parts = [];
	if (counts.agents > 0) parts.push(`${counts.agents} agent${counts.agents === 1 ? "" : "s"}`);
	if (counts.shells > 0) parts.push(`${counts.shells} sh`);
	if (counts.monitors > 0) parts.push(`${counts.monitors} mon`);
	if (parts.length === 0) return "";
	const marker = selected ? "▶ " : "● ";
	return theme.fg(selected ? "accent" : "dim", `${marker}${parts.join(" · ")} · enter tasks`);
}

function taskKind(task: TaskSnapshot): string {
	if (task.type === "local_agent") return "agent";
	if (task.type === "local_bash") return "sh";
	return task.type;
}

class BackgroundTasksPane implements ExtensionMainPaneComponent {
	private selected = 0;
	private detail: string | undefined;
	private loading = false;
	private unsubscribe: (() => void) | undefined;
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private readonly tui: { requestRender(): void };
	private readonly theme: any;
	private readonly requestHide: () => void;

	constructor(tui: { requestRender(): void }, theme: any, requestHide: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.requestHide = requestHide;
		this.unsubscribe = subscribeTasks(() => {
			this.clampSelection();
			this.refreshTickTimer();
			this.tui.requestRender();
		});
		this.refreshTickTimer();
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.clearTickTimer();
	}

	onEscape(): boolean {
		this.requestHide();
		return true;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "\u001b[A") {
			this.selected = Math.max(0, this.selected - 1);
			this.detail = undefined;
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[B") {
			this.selected = Math.min(Math.max(0, this.rows().length - 1), this.selected + 1);
			this.detail = undefined;
			this.tui.requestRender();
			return;
		}
		if (data === "\r" || data === "\n") {
			void this.loadSelectedOutput();
			return;
		}
		if (data === "x" || data === "X") {
			void this.killSelected();
			return;
		}
		if (data === "\u001b") this.requestHide();
	}

	render(width: number): string[] {
		const tasks = this.rows();
		const counts = countByType(activeTasks());
		const lines = [
			this.theme.fg("accent", this.theme.bold("Background tasks")),
			this.theme.fg("dim", `${counts.agents} agent(s) · ${counts.shells} shell(s) · ${counts.monitors} monitor(s)`),
			this.theme.fg("dim", "↑↓ select · enter output · x stop · esc close"),
			"",
		];
		if (tasks.length === 0) {
			lines.push(this.theme.fg("muted", "No background tasks."));
		} else {
			tasks.forEach((task, index) => {
				const selected = index === this.selected;
				const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
				const elapsed = Math.max(0, ((task.endedAt ?? Date.now()) - task.startedAt) / 1000).toFixed(0);
				const status = selected ? this.theme.fg("accent", task.status) : this.theme.fg("muted", task.status);
				lines.push(
					`${prefix}${task.id} ${this.theme.fg("dim", `[${taskKind(task)}]`)} ${status} ${this.theme.fg("dim", `${elapsed}s`)} ${task.description}`,
				);
			});
		}
		if (this.loading) lines.push("", this.theme.fg("dim", "Loading output…"));
		if (this.detail)
			lines.push(
				"",
				...this.detail
					.split("\n")
					.slice(0, 18)
					.map((line) => this.theme.fg("muted", line)),
			);
		return lines.map((line) => truncateToWidth(line, width, this.theme.fg("dim", "…")));
	}

	private refreshTickTimer(): void {
		if (liveRepaintTasks().length > 0) {
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

	private rows(): TaskSnapshot[] {
		return backgroundTasks().sort((a, b) => {
			const activeDelta = Number(isTerminalTaskStatus(a.status)) - Number(isTerminalTaskStatus(b.status));
			return activeDelta || b.startedAt - a.startedAt;
		});
	}

	private clampSelection(): void {
		this.selected = Math.min(Math.max(0, this.rows().length - 1), this.selected);
	}

	private selectedTask(): TaskSnapshot | undefined {
		return this.rows()[this.selected];
	}

	private async loadSelectedOutput(): Promise<void> {
		const task = this.selectedTask();
		if (!task) return;
		const adapter = findTaskAdapter(task.id);
		if (!adapter?.output) {
			this.detail = `${task.id} has no readable output.`;
			this.tui.requestRender();
			return;
		}
		this.loading = true;
		this.tui.requestRender();
		try {
			const output = await adapter.output(task.id, { mode: "tail", maxLines: 80 });
			this.detail = output?.text ?? `${task.id} has no output yet.`;
		} catch (error) {
			this.detail = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.tui.requestRender();
		}
	}

	private async killSelected(): Promise<void> {
		const task = this.selectedTask();
		if (!task) return;
		const adapter = findTaskAdapter(task.id);
		if (!adapter?.kill) {
			this.detail = `${task.id} is not stoppable.`;
			this.tui.requestRender();
			return;
		}
		const result = await adapter.kill(task.id);
		this.detail = result.message;
		this.tui.requestRender();
	}
}

const paneFactory: ExtensionMainPaneFactory = (tui, theme, api) => new BackgroundTasksPane(tui, theme, api.requestHide);

export function hookBackgroundTasksUi(pi: ExtensionAPI): void {
	pi.registerTool(createTaskStopTool());
	pi.registerTool(createTaskBackgroundListTool());

	pi.registerMainPane(PANE_ID, paneFactory);
	pi.registerFooter(PANE_ID, {
		order: -10,
		visible: () => activeTasks().length > 0,
		render: ({ theme, selected }) => footerText(theme, selected),
		onActivate: () => pi.showMainPane(PANE_ID),
	});

	pi.registerCommand("tasks", {
		description: "Open background tasks panel (agents and shell jobs)",
		handler: async () => pi.showMainPane(PANE_ID),
	});
}

addAction(load, "backgroundTasksUi", hookBackgroundTasksUi);
