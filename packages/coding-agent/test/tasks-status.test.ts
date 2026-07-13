import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	attachAgentRecentRunController,
	clearAgentRecentRunsForTests,
	interruptAgentRecentRun,
	markAgentRecentRunNeedsAttention,
	startAgentRecentRun,
	updateAgentRecentRunProgress,
} from "../src/core/agents/status.ts";
import type { AgentRunDetails } from "../src/core/agents/types.ts";
import { LocalAgentTask } from "../src/core/tasks/local-agent-task.ts";
import {
	formatTaskFooterStatus,
	formatTaskStatus,
	taskNeedsAttention,
	taskNeedsInput,
} from "../src/core/tasks/status.ts";
import { killAllBashBgJobs, spawnBashBackground } from "../src/core/tools/bash.ts";

function runningRunDetail(): AgentRunDetails {
	return {
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
		effectiveTools: ["read"],
		deniedTools: [],
		durationMs: 0,
		toolCallCount: 0,
		messageCount: 1,
		recentToolCalls: [],
		recentOutputSnippets: [],
		loadedSkills: [],
		invokedSkills: { count: 0, names: [] },
	};
}

describe("background task status formatting", () => {
	let bashTempDir = "";

	beforeEach(() => {
		clearAgentRecentRunsForTests();
		killAllBashBgJobs();
		bashTempDir = mkdtempSync(join(tmpdir(), "tasks-status-"));
	});

	afterEach(() => {
		killAllBashBgJobs();
		clearAgentRecentRunsForTests();
		if (bashTempDir) rmSync(bashTempDir, { recursive: true, force: true });
	});

	// Generic Claude-style agent footer contract: three compact semantic states,
	// no internal task ids/types/descriptions leaking into the footer text.
	test("shows the navigation hint before any runtime task exists", () => {
		expect(formatTaskFooterStatus()).toBe("← for agents");
	});

	test("lifecycle states do not imply semantic input or attention", () => {
		const task = {
			id: "external-1",
			type: "monitor" as const,
			status: "interrupted" as const,
			description: "External task",
			startedAt: Date.now(),
			resumable: true,
		};
		expect(taskNeedsInput(task)).toBe(false);
		expect(taskNeedsAttention(task)).toBe(false);
		expect(taskNeedsInput({ ...task, status: "failed" })).toBe(false);
		expect(taskNeedsInput({ ...task, attentionReason: "user_input" })).toBe(true);
		expect(taskNeedsAttention({ ...task, attentionReason: "failure", needsAttention: true })).toBe(true);
	});

	test("idle state: a fully completed run still keeps the hint visible, with no counts", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, { mode: "single", status: "running", runs: [runningRunDetail()] });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "completed",
			runs: [{ ...runningRunDetail(), status: "completed" }],
		});

		expect(formatTaskFooterStatus()).toBe("← for agents");
	});

	test("working state: a running background bash job reports a compact count", () => {
		spawnBashBackground("sleep 5", bashTempDir);

		const footer = formatTaskFooterStatus();
		expect(footer).toBe("1 working · ← for agents");
		// Never leak ids/types/descriptions into the footer.
		expect(footer).not.toMatch(/bg_/);
		expect(footer).not.toContain("bash");
		expect(footer).not.toContain("sleep 5");
	});

	test("an ordinary interrupted agent remains visible without claiming it needs input", async () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		const detail = { ...runningRunDetail(), startedAt: Date.now() - 1_000 };
		updateAgentRecentRunProgress(run, { mode: "single", status: "running", runs: [detail] });
		attachAgentRecentRunController(run.id, { interrupt: async () => {} });
		await interruptAgentRecentRun(run.id);

		const snapshot = LocalAgentTask.snapshot(run.id);
		expect(snapshot).toMatchObject({ status: "interrupted", needsInput: false, needsAttention: false });
		expect(snapshot?.children?.[0]?.endedAt).toBeGreaterThan(snapshot?.children?.[0]?.startedAt ?? 0);
		expect(formatTaskFooterStatus()).toBe("← for agents");
	});

	test("attention wins: needs-input takes priority over a simultaneous working count", async () => {
		spawnBashBackground("sleep 5", bashTempDir);
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, { mode: "single", status: "running", runs: [runningRunDetail()] });
		markAgentRecentRunNeedsAttention(run, "Should I proceed?", "user_input");

		const footer = formatTaskFooterStatus();
		expect(footer).toBe("1 needs input · ← for agents");
		expect(footer).not.toContain("working");
	});

	test("stale progress surfaces as needs attention, not needs input", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, { mode: "single", status: "running", runs: [runningRunDetail()] });
		markAgentRecentRunNeedsAttention(run, "No child progress for 10m");

		expect(LocalAgentTask.snapshot(run.id)).toMatchObject({
			status: "running",
			needsInput: false,
			needsAttention: true,
			attentionReason: "stale_progress",
		});
		expect(formatTaskFooterStatus()).toBe("1 needs attention · ← for agents");
	});

	test("persistent parked forks surface as idle, not needs-input", () => {
		const run = startAgentRecentRun("single", [{ agent: "explore", task: "watch" }], {
			background: true,
			persistent: true,
			label: "Observer",
		});
		updateAgentRecentRunProgress(run, { mode: "single", status: "running", runs: [runningRunDetail()] });
		// Executor parks a persistent single-mode background run at "interrupted"
		// on completion — the UI must read this as idle, not needs-input.
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "interrupted",
			parked: true,
			runs: [
				{
					...runningRunDetail(),
					status: "completed",
					sessionId: "observer-child",
					sessionPath: "/tmp/observer-child.jsonl",
				},
			],
		});

		const snapshot = LocalAgentTask.snapshot(run.id);
		expect(snapshot).toMatchObject({ status: "idle", label: "Observer", sessionPath: "/tmp/observer-child.jsonl" });
		expect(snapshot?.children).toEqual([
			expect.objectContaining({
				status: "idle",
				label: "Observer",
				sessionPath: "/tmp/observer-child.jsonl",
				controlId: run.id,
			}),
		]);
		expect(formatTaskFooterStatus()).toBe("← for agents");
	});

	test("status pane lists background bash jobs and background agents together", () => {
		const job = spawnBashBackground("sleep 5", bashTempDir);
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, { mode: "single", status: "running", runs: [runningRunDetail()] });

		const status = formatTaskStatus();
		expect(status).toContain("Background task status");
		expect(status).toContain(`${job.id} [bash] running`);
		expect(status).toContain(`${run.id} [agent] running`);
		expect(status).toContain("TaskStop { task_id }");
	});
});
