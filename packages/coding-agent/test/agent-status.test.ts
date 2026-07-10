import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	agentRunUiStatus,
	attachAgentRecentRunController,
	attachAgentRecentRunTerminalListener,
	cancelAgentRecentRun,
	clearAgentRecentRunsForTests,
	failAgentRecentRun,
	finishAgentRecentRun,
	formatAgentDurationMs,
	formatAgentFooterStatus,
	formatAgentStatus,
	formatAgentTokenCount,
	interruptAgentRecentRun,
	listAgentRecentRuns,
	markAgentRecentRunNeedsAttention,
	restartAgentRecentRun,
	resumeAgentRecentRun,
	startAgentRecentRun,
	subscribeAgentRecentRuns,
	updateAgentRecentRunProgress,
} from "../src/core/agents/status.ts";
import type { AgentRunDetails } from "../src/core/agents/types.ts";

let tempDir = "";
let childSessionPath = "";

function makeRunDetails(status: AgentRunDetails["status"] = "completed"): AgentRunDetails {
	return {
		agent: "scout",
		source: "builtin",
		task: "Map files",
		status,
		context: {
			mode: "default",
			includeTranscript: false,
			includeProjectContext: true,
			includeSkills: true,
			includeAppendSystemPrompt: true,
		},
		effectiveTools: ["read"],
		deniedTools: ["agent"],
		durationMs: 1,
		toolCallCount: 0,
		messageCount: 1,
		recentToolCalls: [],
		recentOutputSnippets: [],
		loadedSkills: [],
		invokedSkills: { count: 0, names: [] },
		sessionId: "child-session",
		sessionPath: childSessionPath,
		outputPath: status === "completed" ? "reports/scout.md" : undefined,
	};
}

function makeRunDetailsWithTools(toolNames: string[], status: AgentRunDetails["status"] = "running"): AgentRunDetails {
	return {
		...makeRunDetails(status),
		toolCallCount: toolNames.length,
		recentToolCalls: toolNames.map((name, index) => ({
			name,
			argsPreview: `arg-${index}`,
			startedAt: 1,
			endedAt: 2,
			resultPreview: `${name} result ${index}`,
		})),
	};
}

describe("native agent status", () => {
	beforeEach(() => {
		clearAgentRecentRunsForTests();
		tempDir = mkdtempSync(join(tmpdir(), "agent-status-"));
		childSessionPath = join(tempDir, "child-session.jsonl");
		writeFileSync(
			childSessionPath,
			`${JSON.stringify({ type: "session", version: 1, id: "child-session", timestamp: new Date().toISOString(), cwd: tempDir })}\n`,
		);
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	test("tracks recent completed foreground runs", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }]);
		finishAgentRecentRun(run, {
			mode: "single",
			status: "completed",
			runs: [makeRunDetails()],
		});

		expect(listAgentRecentRuns()[0]).toMatchObject({
			mode: "single",
			execution: "foreground",
			status: "completed",
			agents: ["scout"],
			outputPaths: ["reports/scout.md"],
		});
		expect(formatAgentStatus()).toContain("agent-1 single foreground completed");
		expect(formatAgentStatus()).not.toContain("unsupported");
		expect(formatAgentStatus(undefined, "agent-1")).toContain("session:");
	});

	test("keeps parked persistent runs when bounded history evicts terminal runs", () => {
		const observer = startAgentRecentRun("single", [{ agent: "general", task: "Observe" }], {
			background: true,
			persistent: true,
			label: "Observer",
		});
		updateAgentRecentRunProgress(observer, {
			mode: "single",
			status: "interrupted",
			parked: true,
			runs: [makeRunDetails("interrupted")],
		});
		expect(observer).toMatchObject({ status: "interrupted", persistent: true, parked: true });
		expect(formatAgentStatus()).toContain("agent-1 single background idle");
		expect(formatAgentStatus(undefined, observer.id)).toContain("agent-1 single background idle");
		expect(formatAgentFooterStatus()).toContain("1 idle");
		expect(formatAgentStatus()).not.toContain("agent-1 single background interrupted");

		// Fill the 25-row recent-run bound with truly terminal history. Starting
		// the last run must evict an old completed row, never the still-live
		// persistent observer merely parked as implementation status interrupted.
		for (let index = 0; index < 25; index++) {
			const run = startAgentRecentRun("single", [{ agent: "scout", task: `Task ${index}` }]);
			finishAgentRecentRun(run, {
				mode: "single",
				status: "completed",
				runs: [makeRunDetails()],
			});
		}

		const retained = listAgentRecentRuns();
		expect(retained.some((run) => run.id === observer.id)).toBe(true);
		expect(retained).toHaveLength(25);
	});

	test("prunes an over-cap run when it becomes terminal after 25 parked runs", () => {
		const parkedIds = new Set<string>();
		for (let index = 0; index < 25; index++) {
			const parked = startAgentRecentRun("single", [{ agent: "general", task: `Observe ${index}` }], {
				background: true,
				persistent: true,
				label: `Observer ${index}`,
			});
			updateAgentRecentRunProgress(parked, {
				mode: "single",
				status: "interrupted",
				parked: true,
				runs: [makeRunDetails("interrupted")],
			});
			parkedIds.add(parked.id);
		}

		const overflow = startAgentRecentRun("single", [{ agent: "scout", task: "One more" }]);
		expect(listAgentRecentRuns()).toHaveLength(26);
		let observedOverflowStatus: string | undefined;
		const unsubscribe = subscribeAgentRecentRuns(() => {
			observedOverflowStatus = listAgentRecentRuns().find((run) => run.id === overflow.id)?.status;
		});
		finishAgentRecentRun(overflow, {
			mode: "single",
			status: "completed",
			runs: [makeRunDetails()],
		});
		unsubscribe();

		expect(observedOverflowStatus).toBe("completed");
		const retained = listAgentRecentRuns();
		expect(retained).toHaveLength(25);
		expect(retained.every((run) => parkedIds.has(run.id))).toBe(true);
	});

	test("skips notifying subscribers when a progress tick has no user-visible content change", () => {
		// Regression: every background-agent progress tick used to force
		// notifyAgentRecentRunsChanged() unconditionally, even
		// when nothing rendered would actually differ (e.g. a heartbeat re-send of
		// the same tool state). Fails on the pre-fix baseline (listener count 3),
		// passes after the change-guard (listener count 2).
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		const listener = vi.fn();
		const unsubscribe = subscribeAgentRecentRuns(listener);

		const details = {
			mode: "single" as const,
			status: "running" as const,
			runs: [makeRunDetailsWithTools(["read"])],
		};
		updateAgentRecentRunProgress(run, details);
		expect(listener).toHaveBeenCalledTimes(1);

		// Identical content again (only updatedAt would move under the hood) — must not renotify.
		updateAgentRecentRunProgress(run, details);
		expect(listener).toHaveBeenCalledTimes(1);

		// A real content change (new tool call) must still notify.
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetailsWithTools(["read", "grep"])],
		});
		expect(listener).toHaveBeenCalledTimes(2);

		unsubscribe();
	});

	test("shows child model and thinking in summary and detail views", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }]);
		finishAgentRecentRun(run, {
			mode: "single",
			status: "completed",
			runs: [
				{
					...makeRunDetails(),
					model: { provider: "clawrouter", id: "gpt-5.5" },
					thinking: "medium",
				},
			],
		});

		expect(formatAgentStatus()).toContain("models: clawrouter/gpt-5.5 · thinking medium");
		expect(formatAgentStatus(undefined, "agent-1")).toContain(
			"scout completed 1ms · clawrouter/gpt-5.5 · thinking medium",
		);
	});

	test("tracks startup failures", () => {
		const run = startAgentRecentRun("chain", [{ agent: "missing", task: "Do it" }]);
		failAgentRecentRun(run, new Error("boom"));

		expect(formatAgentStatus()).toContain("chain foreground failed");
		expect(formatAgentStatus()).toContain("boom");
	});

	test("shows running background runs in status and detail views", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});

		const status = formatAgentStatus();
		expect(status).toContain("agent-1 single background running");
		expect(status).toContain("Control: /agents interrupt <run-id>");

		const detail = formatAgentStatus(undefined, "agent-1");
		expect(detail).toContain("agent-1 single background running");
		expect(detail).toContain(`session: ${childSessionPath}`);
	});

	test("a real interrupt of a persistent run remains interrupted, not parked idle", async () => {
		const run = startAgentRecentRun("single", [{ agent: "general", task: "Observe" }], {
			background: true,
			persistent: true,
		});
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		attachAgentRecentRunController(run.id, { interrupt: vi.fn(), resume: vi.fn() });

		await interruptAgentRecentRun(run.id);

		expect(agentRunUiStatus(run)).toBe("interrupted");
		expect(run.needsAttention || run.error).toBeTruthy();
	});

	test("interrupt and cancel update background status", async () => {
		const interruptRun = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], {
			background: true,
		});
		updateAgentRecentRunProgress(interruptRun, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		const interrupt = vi.fn();
		attachAgentRecentRunController(interruptRun.id, { interrupt, resume: vi.fn() });

		const interrupted = await interruptAgentRecentRun(interruptRun.id);
		expect(interrupt).toHaveBeenCalledOnce();
		expect(interrupted.ok).toBe(true);
		expect(formatAgentStatus()).toContain("agent-1 single background interrupted resumable");

		const cancelRun = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(cancelRun, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		const cancel = vi.fn();
		attachAgentRecentRunController(cancelRun.id, { cancel });

		const cancelled = await cancelAgentRecentRun(cancelRun.id);
		expect(cancel).toHaveBeenCalledOnce();
		expect(cancelled.ok).toBe(true);
		expect(formatAgentStatus()).toContain("agent-2 single background cancelled");
	});

	test("formats footer summary for background runs", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [
				{
					...makeRunDetails("running"),
					model: { provider: "clawrouter", id: "gpt-5.5" },
					thinking: "medium",
				},
			],
		});

		expect(formatAgentFooterStatus()).toContain("Agents: 1 running");
		expect(formatAgentFooterStatus()).toContain("agent-1 running scout");
		expect(formatAgentFooterStatus()).toContain("clawrouter/gpt-5.5 · thinking medium");
		expect(formatAgentFooterStatus()).toContain("/agents runs");
	});

	test("formats agent tokens and durations compactly", () => {
		expect(formatAgentTokenCount(32_559)).toBe("32k");
		expect(formatAgentDurationMs(59_000)).toBe("59s");
		expect(formatAgentDurationMs(61_000)).toBe("1m 1s");
	});

	test("marks stale background runs as needing attention", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		markAgentRecentRunNeedsAttention(run, "No child progress for 10m");

		expect(formatAgentFooterStatus()).toContain("needs attention");
		expect(formatAgentStatus()).toContain("needs-attention: No child progress for 10m");
	});

	test("fires a terminal listener registered after the transition", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "completed",
			runs: [makeRunDetails("completed")],
		});
		const listener = vi.fn();

		attachAgentRecentRunTerminalListener(run.id, listener);

		expect(listener).toHaveBeenCalledOnce();
		expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: run.id, status: "completed" }));
	});

	test("notifies subscribers when recent runs change", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeAgentRecentRuns(listener);
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		unsubscribe();
		finishAgentRecentRun(run, {
			mode: "single",
			status: "completed",
			runs: [makeRunDetails("completed")],
		});

		expect(listener).toHaveBeenCalledTimes(2);
	});

	test("does not mark non-single interrupted runs resumable", async () => {
		const run = startAgentRecentRun(
			"parallel",
			[
				{ agent: "scout", task: "Map files" },
				{ agent: "reviewer", task: "Review files" },
			],
			{ background: true },
		);
		updateAgentRecentRunProgress(run, {
			mode: "parallel",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		attachAgentRecentRunController(run.id, { interrupt: vi.fn(), resume: vi.fn() });

		await interruptAgentRecentRun(run.id);

		expect(formatAgentStatus()).toContain("agent-1 parallel background interrupted");
		expect(formatAgentStatus()).not.toContain("resumable");
	});

	test("ignores stale generation completions after resume restart", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		restartAgentRecentRun(run);
		finishAgentRecentRun(
			run,
			{
				mode: "single",
				status: "completed",
				runs: [makeRunDetails("completed")],
			},
			0,
		);

		expect(formatAgentStatus()).toContain("agent-1 single background running");
	});

	test("resume control delegates resumable background runs", async () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		const resume = vi.fn();
		attachAgentRecentRunController(run.id, { interrupt: vi.fn(), resume });
		await interruptAgentRecentRun(run.id);

		const result = await resumeAgentRecentRun(run.id, "continue");
		expect(resume).toHaveBeenCalledWith("continue");
		expect(result.ok).toBe(true);
	});
});

describe("nested sub-agent visibility & transcript", () => {
	beforeEach(() => {
		clearAgentRecentRunsForTests();
		tempDir = mkdtempSync(join(tmpdir(), "agent-nesting-"));
		childSessionPath = join(tempDir, "child-session.jsonl");
		writeFileSync(childSessionPath, `${JSON.stringify({ type: "session", version: 1, id: "child-session" })}\n`);
	});
	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	// B1: the run model carries delegation depth + parent linkage.
	test("records delegation depth and parent run id", () => {
		const top = startAgentRecentRun("single", [{ agent: "scout", task: "t" }]);
		expect(top.depth).toBe(0);
		expect(top.parentRunId).toBeUndefined();

		const nested = startAgentRecentRun("single", [{ agent: "scout", task: "t" }], {
			depth: 2,
			parentRunId: top.id,
		});
		expect(nested.depth).toBe(2);
		expect(nested.parentRunId).toBe(top.id);
	});

	// The depth marker is render-agnostic: it formats whatever nesting level a run
	// carries, L1..L5, each distinctly, and the detail view links back to the parent.
	// (Real reach with cap 5 tops out at an L4 *run* marker because a depth-5 caller
	// is gated before it can start a run; depth-5 *sessions* are proven to spawn in
	// test/suite/nested-delegation-depth.test.ts. This pins the formatter itself.)
	test("renders the depth marker distinctly for every nesting level", () => {
		let parentRunId: string | undefined;
		const ids: string[] = [];
		for (let depth = 0; depth <= 5; depth++) {
			const run = startAgentRecentRun("single", [{ agent: `lvl${depth}`, task: "t" }], {
				background: true,
				depth,
				parentRunId,
			});
			ids.push(run.id);
			parentRunId = run.id;
		}

		const status = formatAgentStatus();
		for (let depth = 1; depth <= 5; depth++) {
			expect(status).toContain(`\u21b3L${depth}`);
		}
		expect(formatAgentStatus(undefined, ids[5])).toContain(`nested: depth 5 (parent ${ids[4]})`);
	});

	// B3 + B4: the agents view marks nested runs and shows fan-out done/total.
	test("renders a nesting marker and fan-out done/total", () => {
		const run = startAgentRecentRun(
			"parallel",
			[
				{ agent: "a", task: "t" },
				{ agent: "b", task: "t" },
			],
			{ background: true, depth: 1, parentRunId: "agent-0" },
		);
		updateAgentRecentRunProgress(run, {
			mode: "parallel",
			status: "running",
			runs: [makeRunDetails("completed"), makeRunDetails("running")],
		});

		const status = formatAgentStatus();
		expect(status).toContain("\u21b3L1");
		expect(status).toContain("[1/2 done]");
		expect(formatAgentStatus(undefined, run.id)).toContain("nested: depth 1 (parent agent-0)");
	});

	// B4 regression: fan-out total is the requested task count, not started children.
	// 3 parallel tasks with only 1 child started (others queued past the concurrency
	// limit) must read [1/3 done], never [1/1 done].
	test("fan-out total counts requested tasks, not just started children", () => {
		const run = startAgentRecentRun(
			"parallel",
			[
				{ agent: "a", task: "t" },
				{ agent: "b", task: "t" },
				{ agent: "c", task: "t" },
			],
			{ background: true },
		);
		updateAgentRecentRunProgress(run, {
			mode: "parallel",
			status: "running",
			runs: [makeRunDetails("completed")],
		});
		expect(formatAgentStatus()).toContain("[1/3 done]");
	});

	// C1: the detail view shows tool RESULTS, not just tool names (CC 2.1.178).
	test("shows subagent tool results in the run detail", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "t" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetailsWithTools(["read"])],
		});

		const detail = formatAgentStatus(undefined, run.id);
		expect(detail).toContain("recent tools:");
		expect(detail).toContain("read");
		expect(detail).toContain("\u2192 read result 0");
	});

	// C2: the rendered detail reflects newly appended tool calls as progress
	// arrives — the data flow the subscribed AgentsPane re-renders live.
	test("reflects newly appended tool calls as progress arrives", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "t" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetailsWithTools(["grep"])],
		});
		expect(formatAgentStatus(undefined, run.id)).toContain("grep");

		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetailsWithTools(["grep", "read"])],
		});
		const detail = formatAgentStatus(undefined, run.id);
		expect(detail).toContain("grep");
		expect(detail).toContain("read");
	});

	// B5: a failing run reaches a terminal status — never stuck "running".
	test("a failing run reaches a terminal failed status", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "t" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		expect(run.status).toBe("running");

		failAgentRecentRun(run, new Error("child crashed"));
		expect(run.status).toBe("failed");
		const status = formatAgentStatus();
		expect(status).toContain("failed");
		expect(status).toContain("child crashed");
	});
});
