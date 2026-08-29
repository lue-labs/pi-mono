import { Container, getKeybindings, Spacer, Text } from "@lue-labs/pi-tui";
import {
	type AgentRecentRun,
	agentRunUiStatus,
	formatAgentDurationMs,
	formatAgentRunModel,
} from "../../../core/agents/status.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export type AgentRunsSelectorAction = "detail" | "interrupt" | "cancel" | "resume";

/**
 * View-level grace for settled runs (CC 2.1.232 parity): Claude Code's task
 * registry retains terminal tasks; its background-tasks dialog hides completed
 * local agents once the 30s eviction grace (`PANEL_GRACE_MS`/`kye = 30000`)
 * passes. The 2.5s timer in CC is only an ephemeral completion border-flash
 * nudge, not registry deletion. Pi mirrors the split: the durable registry
 * (`recentRuns`, bounded at 25) keeps terminal runs; only this view ages them
 * out.
 */
export const AGENT_RUN_SETTLED_VIEW_GRACE_MS = 30_000;

/**
 * Filter + order the runs view (pure; CC 2.1.232 background-tasks-dialog
 * parity):
 *
 * - Ordering: running rows first, then newest-first by `startedAt` — CC sorts
 *   `status === "running"` to the top, remainder by start time descending.
 * - Initial-load filtering: `completed` and `cancelled` rows older than the
 *   30s grace are hidden from the view (their registry rows survive for
 *   `/agents status`). `failed` and `interrupted` rows never age out: they
 *   carry actionable state (error text, resume/cancel) that CC's evicted
 *   states do not need but Pi's operator verbs do.
 */
export function selectAgentRunRows(runs: AgentRecentRun[], nowMs = Date.now()): AgentRecentRun[] {
	const visible = runs.filter((run) => {
		if (run.status !== "completed" && run.status !== "cancelled") return true;
		const endedAtMs = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
		if (Number.isNaN(endedAtMs)) return true;
		return nowMs - endedAtMs < AGENT_RUN_SETTLED_VIEW_GRACE_MS;
	});
	return visible.sort((a, b) => {
		const aRunning = a.status === "running";
		const bRunning = b.status === "running";
		if (aRunning !== bRunning) return aRunning ? -1 : 1;
		return Date.parse(b.startedAt) - Date.parse(a.startedAt);
	});
}

export interface AgentRunResumePrompt {
	title: string;
	placeholder: string;
}

export function getAgentRunResumePrompt(run: AgentRecentRun): AgentRunResumePrompt {
	return {
		title: `Resume ${run.id}`,
		placeholder: "Steering message (Enter empty to resume without one)",
	};
}

export function normalizeAgentRunResumePrompt(prompt: string): string | undefined {
	const trimmed = prompt.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

// Reads the run's UI status (persistent single-background forks parked at
// "interrupted" read as "idle" — see `agentRunUiStatus`), so a launcher-fed
// background agent waiting for its next turn never masquerades as needing
// the user's attention the way an ordinary interrupted run does.
function agentRunStatusText(run: AgentRecentRun): string {
	const status = agentRunUiStatus(run);
	switch (status) {
		case "completed":
			return theme.fg("success", status);
		case "failed":
		case "cancelled":
			return theme.fg("error", status);
		case "interrupted":
			return theme.fg("warning", status);
		case "idle":
			return theme.fg("muted", status);
		default:
			return theme.fg("accent", status);
	}
}

function agentRunDuration(run: AgentRecentRun): string {
	if (run.durationMs !== undefined) return formatAgentDurationMs(run.durationMs);
	return formatAgentDurationMs(Math.max(0, Date.now() - Date.parse(run.startedAt)));
}

/**
 * Count of child runs that have left the running state — the "done" half of the
 * fan-out `done/total` indicator (CC 2.1.161).
 */
function countSettledChildren(run: AgentRecentRun): number {
	return run.runs.filter((child) => child.status !== "running").length;
}

/**
 * True when the row is a running background agent — Enter should zoom straight
 * into its live transcript instead of showing the static status detail
 * (agents-ux-parity Slice B, row 3: row-scoped zoom entry). Pure so it's
 * unit-testable without the `InteractiveMode` harness.
 */
export function shouldZoomAgentRunRow(run: AgentRecentRun): boolean {
	if (run.execution !== "background") return false;
	if (run.status === "running") return true;
	// A parked persistent fork has no live in-process controller to attach a
	// "live" transcript to, but its child session is still on disk — zoom into
	// that instead of falling back to the static detail view, as long as we
	// actually have a session to reconnect. Real interrupted runs (persistent
	// or not) stay on the static detail view: they need explicit
	// resume/interrupt/cancel action, not a passive zoom.
	if (run.parked && run.status === "interrupted") {
		return run.sessionRefs.some((ref) => Boolean(ref.sessionPath));
	}
	return false;
}

/** Compact list row for the agent-runs selector. Pure (depends only on `run`). */
export function formatAgentRunRow(run: AgentRecentRun, selected: boolean): string {
	const prefix = selected ? `${theme.fg("accent", "→ ")}` : "  ";
	const id = selected ? theme.fg("accent", run.id) : theme.fg("text", run.id);
	const execution = run.execution === "background" ? "bg" : "fg";
	const resumable = run.resumable ? theme.fg("warning", " resumable") : "";
	const attention = run.needsAttention
		? theme.fg("warning", ` needs attention: ${run.attentionMessage || "check run"}`)
		: "";
	const nesting = run.depth > 0 ? theme.fg("muted", ` ↳L${run.depth}`) : "";
	// Total is the requested task count (`tasks`), not observed `runs`: children still
	// queued (parallel beyond the concurrency limit, or later chain steps) have no
	// `runs[]` entry yet, so `runs.length` understates the total mid-flight.
	const fanout = run.tasks.length > 1 ? theme.fg("muted", ` [${countSettledChildren(run)}/${run.tasks.length}]`) : "";
	const models = Array.from(
		new Set(run.runs.map(formatAgentRunModel).filter((model): model is string => Boolean(model))),
	);
	const modelText = models.length > 0 ? theme.fg("muted", ` · ${models.join(",")}`) : "";
	return `${prefix}${id}${nesting} ${execution} ${agentRunStatusText(run)}${resumable}${attention}${fanout} ${theme.fg("muted", run.agents.join(", "))}${modelText}`;
}

/**
 * Detail panel for the selected run, including an inline transcript of each
 * child's recent tool calls *with their results* and live status — so a
 * subagent's progress is visible without leaving the runs view (CC 2.1.178).
 * Pure (depends only on `run`).
 */
export function formatAgentRunDetailView(run: AgentRecentRun | undefined): string {
	if (!run) return theme.fg("muted", "No native agent runs yet");
	const lines = [
		`${theme.fg("accent", run.id)} ${run.mode} ${run.execution} ${agentRunUiStatus(run)} ${agentRunDuration(run)}`,
		`agents: ${run.agents.join(", ") || "n/a"}`,
	];
	if (run.depth > 0) lines.push(`nested: depth ${run.depth}${run.parentRunId ? ` (parent ${run.parentRunId})` : ""}`);
	if (run.resumable) lines.push(`resumable: yes (${keyHint("app.agents.resume", "resume")})`);
	if (run.needsAttention) lines.push(`needs attention: ${run.attentionMessage ?? "check run"}`);
	if (run.sessionRefs.length > 0) {
		lines.push(
			`sessions: ${run.sessionRefs
				.map((ref) => ref.sessionId ?? ref.sessionPath)
				.filter(Boolean)
				.join(", ")}`,
		);
	}
	if (run.outputPaths.length > 0) lines.push(`outputs: ${run.outputPaths.join(", ")}`);
	if (run.error) lines.push(`error: ${run.error}`);
	for (const child of run.runs) {
		const tools = child.recentToolCalls.slice(-6);
		const model = formatAgentRunModel(child);
		if (tools.length === 0 && !model) continue;
		lines.push(theme.fg("muted", `↳ ${child.agent} (${child.status})${model ? ` · ${model}` : ""}`));
		for (const tool of tools) {
			const args = tool.argsPreview ? ` ${tool.argsPreview}` : "";
			const err = tool.isError ? theme.fg("error", " (error)") : "";
			lines.push(`  • ${tool.name}${args}${err}`);
			if (tool.resultPreview) lines.push(theme.fg("muted", `    → ${tool.resultPreview}`));
		}
	}
	return lines.join("\n");
}

export class AgentRunsSelectorComponent extends Container {
	private readonly getRuns: () => AgentRecentRun[];
	private readonly onAction: (action: AgentRunsSelectorAction, run: AgentRecentRun) => void;
	private readonly onCancel: () => void;
	private selectedIndex = 0;
	private displayedRuns: AgentRecentRun[] = [];
	private readonly listContainer = new Container();
	private readonly detailText = new Text("", 1, 0);

	constructor(
		getRuns: () => AgentRecentRun[],
		onAction: (action: AgentRunsSelectorAction, run: AgentRecentRun) => void,
		onCancel: () => void,
	) {
		super();
		this.getRuns = getRuns;
		this.onAction = onAction;
		this.onCancel = onCancel;
		this.rebuild();
	}

	private selectedRun(): AgentRecentRun | undefined {
		return this.displayedRuns[this.selectedIndex];
	}

	private formatRunRow(run: AgentRecentRun, selected: boolean): string {
		return formatAgentRunRow(run, selected);
	}

	private formatDetail(run: AgentRecentRun | undefined): string {
		return formatAgentRunDetailView(run);
	}

	private rebuild(): void {
		this.clear();
		this.listContainer.clear();
		const runs = selectAgentRunRows(this.getRuns());
		this.displayedRuns = runs;
		if (runs.length === 0) {
			this.selectedIndex = 0;
			this.listContainer.addChild(new Text(theme.fg("muted", "No native agent runs yet"), 1, 0));
		} else {
			this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, runs.length - 1));
			for (const [index, run] of runs.entries()) {
				this.listContainer.addChild(new Text(this.formatRunRow(run, index === this.selectedIndex), 1, 0));
			}
		}
		this.detailText.setText(this.formatDetail(this.selectedRun()));

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Agent Runs")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.detailText);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "details") +
					"  " +
					keyHint("app.agents.interrupt", "interrupt") +
					"  " +
					keyHint("app.agents.cancel", "cancel") +
					"  " +
					keyHint("app.agents.resume", "resume") +
					"  " +
					keyHint("tui.select.cancel", "close"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	handleInput(keyData: string): void {
		const runs = this.displayedRuns;
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.rebuild();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(Math.max(0, runs.length - 1), this.selectedIndex + 1);
			this.rebuild();
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		const selected = this.selectedRun();
		if (!selected) return;
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.onAction("detail", selected);
			return;
		}
		if (kb.matches(keyData, "app.agents.interrupt")) {
			this.onAction("interrupt", selected);
			return;
		}
		if (kb.matches(keyData, "app.agents.cancel")) {
			this.onAction("cancel", selected);
			return;
		}
		if (kb.matches(keyData, "app.agents.resume")) {
			this.onAction("resume", selected);
		}
	}
}
