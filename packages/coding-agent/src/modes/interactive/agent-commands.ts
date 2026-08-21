/**
 * Fork-owned `/agents` command family for interactive mode (fork delta reforge).
 *
 * Implements `/agents` (selector, runs, status, interrupt/cancel/resume,
 * doctor, chains, run/parallel/run-chain prompt seeding) and `/agents-doctor`
 * against a narrow {@link AgentCommandsHost} seam so `interactive-mode.ts`
 * keeps a minimal fork delta.
 *
 * Extracted verbatim from `InteractiveMode` private methods; only the
 * `this.*` receiver was renamed to `host.*`. Behavior must not change here
 * without updating `~/Projects/personal/my-pi/docs/pi-fork-patch-inventory.md`.
 */
import type { Component } from "@lue-labs/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { findAgentChain, loadAgentChainRegistry } from "../../core/agents/chains.ts";
import { buildAgentDoctorReport } from "../../core/agents/doctor.ts";
import { loadAgentRegistry } from "../../core/agents/registry.ts";
import {
	type AgentRecentRun,
	cancelAgentRecentRun,
	formatAgentStatus,
	interruptAgentRecentRun,
	listAgentRecentRuns,
	resumeAgentRecentRun,
} from "../../core/agents/status.ts";
import type { AgentDefinition } from "../../core/agents/types.ts";
import {
	type AgentRunsSelectorAction,
	AgentRunsSelectorComponent,
	getAgentRunResumePrompt,
	normalizeAgentRunResumePrompt,
	shouldZoomAgentRunRow,
} from "./components/agent-runs-selector.ts";
import { AgentsSelectorComponent } from "./components/agents-selector.ts";

/**
 * Narrow seam onto InteractiveMode for the `/agents` command family.
 *
 * `session` is a snapshot taken when the host adapter is built (once per
 * command invocation). Current code only reads it before any await; if you
 * add a `session` read after an await, re-take it from a fresh host instead
 * so a mid-command session swap is not observed stale.
 */
export interface AgentCommandsHost {
	readonly session: AgentSession;
	getCwd(): string;
	showStatus(message: string): void;
	/** Seed the editor with `text` and focus it. */
	setEditorText(text: string): void;
	requestRender(): void;
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showExtensionMainPane(id: string, payload: unknown): void;
	showExtensionInput(title: string, placeholder?: string): Promise<string | undefined>;
}

export async function runAgentsCommand(host: AgentCommandsHost, args?: string): Promise<void> {
	const registry = await loadAgentRegistry({ cwd: host.getCwd(), agentScope: "user" });
	if (!args) {
		showAgentsSelector(host, registry.agents);
		return;
	}
	if (args === "runs") {
		showAgentRunsSelector(host);
		return;
	}
	if (args === "status" || args.startsWith("status ")) {
		const detailId = args.startsWith("status ") ? args.slice(7).trim() : undefined;
		host.showStatus(formatAgentStatus(undefined, detailId));
		return;
	}
	if (args.startsWith("interrupt ")) {
		const runId = args.slice(10).trim();
		const result = await interruptAgentRecentRun(runId);
		host.showStatus(`${result.message}\n\n${formatAgentStatus(undefined, runId)}`);
		return;
	}
	if (args.startsWith("cancel ")) {
		const runId = args.slice(7).trim();
		const result = await cancelAgentRecentRun(runId);
		host.showStatus(`${result.message}\n\n${formatAgentStatus(undefined, runId)}`);
		return;
	}
	if (args.startsWith("resume ")) {
		const [runId, prompt] = args.slice(7).split(/\s+--\s+/, 2);
		const result = await resumeAgentRecentRun(runId.trim(), prompt?.trim());
		host.showStatus(`${result.message}\n\n${formatAgentStatus(undefined, runId.trim())}`);
		return;
	}
	if (args === "doctor") {
		await runAgentsDoctorCommand(host);
		return;
	}
	if (args === "list-chains") {
		const chains = await loadAgentChainRegistry(host.getCwd());
		host.showStatus(
			chains.chains.length > 0
				? chains.chains.map((chain) => `${chain.name} [${chain.source}]`).join(", ")
				: "No saved chains found",
		);
		return;
	}
	if (args.startsWith("run ")) {
		const [agentId, task = ""] = args.slice(4).split(/\s+--\s+/, 2);
		host.setEditorText(`Use the native agent tool to run ${agentId} with this task: ${task}`);
		return;
	}
	if (args.startsWith("parallel ")) {
		const [agentsRaw, task = ""] = args.slice(9).split(/\s+--\s+/, 2);
		const agents = agentsRaw
			.split(",")
			.map((agent) => agent.trim())
			.filter(Boolean);
		host.setEditorText(
			`Use the native agent tool parallel mode for these agents: ${agents.join(", ")}. Task for each: ${task}`,
		);
		return;
	}
	if (args.startsWith("run-chain ")) {
		const [chainName, task = ""] = args.slice(10).split(/\s+--\s+/, 2);
		const chains = await loadAgentChainRegistry(host.getCwd());
		const chain = findAgentChain(chains, chainName);
		if (!chain) {
			host.showStatus(`Unknown chain: ${chainName}`);
			return;
		}
		const chainInput = JSON.stringify({
			chain: chain.chain,
			context: chain.context,
			model: chain.model,
			tools: chain.tools,
			thinking: chain.thinking,
			outputMode: chain.outputMode,
		});
		host.setEditorText(
			`Use the native agent tool chain mode to run saved chain ${chain.name}${task ? ` for this task: ${task}` : ""}. Chain input: ${chainInput}`,
		);
		return;
	}
	const agent = registry.agents.find((candidate) => candidate.id === args);
	if (!agent) {
		host.showStatus(`Unknown agent or /agents subcommand: ${args}`);
		return;
	}
	const tools = Array.isArray(agent.tools) ? agent.tools.join(", ") : (agent.tools ?? "*");
	host.showStatus(
		`${agent.id} [${agent.source}] — ${agent.description} | context: ${agent.defaultContext ?? "default"} | tools: ${tools}`,
	);
}

export async function runAgentsDoctorCommand(host: AgentCommandsHost): Promise<void> {
	const activeTools = host.session.getActiveToolNames();
	const report = await buildAgentDoctorReport({
		cwd: host.getCwd(),
		activeTools,
		modelRegistry: host.session.modelRegistry,
		parentModel: host.session.model,
		parentThinkingLevel: host.session.thinkingLevel,
		runtimeServicesAvailable: activeTools.includes("agent"),
	});
	host.showStatus(report);
}

function showAgentsSelector(host: AgentCommandsHost, agents: AgentDefinition[]): void {
	host.showSelector((done) => {
		const selector = new AgentsSelectorComponent(
			agents,
			(agent) => {
				done();
				host.setEditorText(`Use the ${agent.id} agent to: `);
			},
			() => {
				done();
			},
		);
		return { component: selector, focus: selector };
	});
}

function showAgentRunsSelector(host: AgentCommandsHost): void {
	host.showSelector((done) => {
		const selector = new AgentRunsSelectorComponent(
			() => listAgentRecentRuns(),
			(action, run) => {
				void handleAgentRunSelectorAction(host, action, run, selector, done);
			},
			() => {
				done();
			},
		);
		return { component: selector, focus: selector };
	});
}

/**
 * Row-scoped zoom entry (agents-ux-parity Slice B, row 3): pressing Enter on
 * a *running background* row jumps straight into that row's live transcript
 * via the already-registered `pi-agent-ui` "zoom" main pane, instead of only
 * ever showing a text status summary. Falls back to the pre-existing status
 * detail for non-running rows or when no extension has registered the
 * "zoom" pane (e.g. a lean profile without `pi-agent-ui` loaded) — this is a
 * generic, already-public core seam (`getRegisteredMainPane`/`showMainPane`
 * by string id), not a new coupling to a specific extension.
 */
async function handleAgentRunSelectorAction(
	host: AgentCommandsHost,
	action: AgentRunsSelectorAction,
	run: AgentRecentRun,
	selector: AgentRunsSelectorComponent,
	done: () => void,
): Promise<void> {
	if (action === "detail") {
		const canZoom =
			shouldZoomAgentRunRow(run) && host.session.extensionRunner.getRegisteredMainPane("zoom") !== undefined;
		if (canZoom) {
			done();
			host.showExtensionMainPane("zoom", {
				taskId: run.id,
				sessionConfig: { cwd: host.getCwd() },
			});
			return;
		}
		host.showStatus(formatAgentStatus(undefined, run.id));
		return;
	}
	if (action === "resume") {
		const prompt = getAgentRunResumePrompt(run);
		done();
		const message = await host.showExtensionInput(prompt.title, prompt.placeholder);
		if (message === undefined) return;
		const result = await resumeAgentRecentRun(run.id, normalizeAgentRunResumePrompt(message));
		host.showStatus(`${result.message}\n\n${formatAgentStatus(undefined, run.id)}`);
		host.requestRender();
		return;
	}

	const result = action === "interrupt" ? await interruptAgentRecentRun(run.id) : await cancelAgentRecentRun(run.id);
	selector.invalidate();
	host.showStatus(`${result.message}\n\n${formatAgentStatus(undefined, run.id)}`);
	host.requestRender();
}
