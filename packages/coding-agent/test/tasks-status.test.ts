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
import { formatTaskFooterStatus, formatTaskStatus, taskNeedsInput } from "../src/core/tasks/status.ts";
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

	test("needs-input is an explicit provider claim, never derived from status", () => {
		const task = {
			id: "external-1",
			type: "monitor" as const,
			status: "interrupted" as const,
			description: "External task",
			startedAt: Date.now(),
			resumable: true,
		};
		// Interrupted/failed are settled state, not a user wait.
		expect(taskNeedsInput(task)).toBe(false);
		expect(taskNeedsInput({ ...task, status: "failed" as const })).toBe(false);
		expect(taskNeedsInput({ ...task, needsInput: true })).toBe(true);
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

	test("an interrupted agent never reports needs input — Pi agents have no blocking path", async () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, { mode: "single", status: "running", runs: [runningRunDetail()] });
		attachAgentRecentRunController(run.id, { interrupt: async () => {} });
		await interruptAgentRecentRun(run.id);

		const footer = formatTaskFooterStatus();
		expect(footer).not.toContain("needs input");
		expect(footer).toBe("← for agents");
	});

	test("a failed agent run never reports needs input", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, { mode: "single", status: "running", runs: [runningRunDetail()] });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "failed",
			runs: [{ ...runningRunDetail(), status: "failed", error: "boom" }],
		});

		expect(LocalAgentTask.snapshot(run.id)?.needsInput).toBe(false);
		expect(formatTaskFooterStatus()).toBe("← for agents");
	});

	test("needs-attention on a running agent stays informational — footer keeps the working count", () => {
		spawnBashBackground("sleep 5", bashTempDir);
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, { mode: "single", status: "running", runs: [runningRunDetail()] });
		markAgentRecentRunNeedsAttention(run, "No child progress for 10m");

		const footer = formatTaskFooterStatus();
		expect(footer).toBe("2 working · ← for agents");
		expect(footer).not.toContain("needs input");
	});

	test("a bash job stalled on an interactive prompt is the one real needs-input", () => {
		const job = spawnBashBackground("sleep 5", bashTempDir);
		if (!job.lifecycle) throw new Error("expected lifecycle state on spawned job");
		job.lifecycle.promptStalledAt = Date.now();

		const footer = formatTaskFooterStatus();
		expect(footer).toBe("1 needs input · ← for agents");
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
