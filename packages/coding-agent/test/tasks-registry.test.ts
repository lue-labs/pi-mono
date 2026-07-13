import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	attachAgentRecentRunController,
	clearAgentRecentRunsForTests,
	failAgentRecentRun,
	findAgentRecentRun,
	finishAgentRecentRun,
	startAgentRecentRun,
	updateAgentRecentRunProgress,
} from "../src/core/agents/status.ts";
import type { AgentRunDetails } from "../src/core/agents/types.ts";
import { getTaskSnapshot, LocalAgentTask, LocalBashTask, listTasks } from "../src/core/tasks/index.ts";
import { getBashBgJob, killAllBashBgJobs, spawnBashBackground } from "../src/core/tools/bash.ts";

/** Poll a background bash job until it leaves the running state (or times out). */
async function waitForJobToSettle(jobId: string, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (getBashBgJob(jobId)?.status !== "running") return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

let tempDir = "";
let childSessionPath = "";

function makeRunDetails(status: AgentRunDetails["status"] = "running"): AgentRunDetails {
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
	};
}

describe("tasks registry — LocalAgentTask adapter", () => {
	beforeEach(() => {
		clearAgentRecentRunsForTests();
		tempDir = mkdtempSync(join(tmpdir(), "tasks-registry-"));
		childSessionPath = join(tempDir, "child-session.jsonl");
		writeFileSync(
			childSessionPath,
			`${JSON.stringify({ type: "session", version: 1, id: "child-session", timestamp: new Date().toISOString(), cwd: tempDir })}\n`,
		);
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	test("snapshot maps AgentRecentRun fields onto TaskSnapshot", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});

		const snap = LocalAgentTask.snapshot(run.id);
		expect(snap).toMatchObject({
			id: run.id,
			type: "local_agent",
			status: "running",
			resumable: false,
		});
		expect(snap?.description).toContain("scout");
		expect(snap?.description).toContain("Map files");
		expect(snap?.startedAt).toBeGreaterThan(0);
	});

	// Regression: `listTasks()`'s TaskSnapshot.children (each `${run.id}:${n}`)
	// are display-only leaf rows with no independent adapter/live-session/
	// message-buffer registration — every control primitive is keyed by the
	// top-level run id only. A consumer (e.g. pi-agent-panel's row flattening,
	// which always drills into `children` the moment a run has any sub-runs —
	// i.e. every real Agent-tool run, not just parallel batches) that threads
	// a child's bare `id` into zoom/interrupt/cancel/kill-all/resume gets a
	// silent "not found" even though the run is alive and controllable under
	// its own id. `controlId` on each child snapshot must resolve to the owning
	// run's real id so those consumers have a correct id to dispatch on.
	test("child snapshots carry controlId pointing at the owning run's real id", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});

		const snap = LocalAgentTask.snapshot(run.id);
		expect(snap?.children).toHaveLength(1);
		const child = snap?.children?.[0];
		expect(child?.id).toBe(`${run.id}:1`);
		expect(child?.id).not.toBe(run.id);
		expect(child?.controlId).toBe(run.id);
	});

	test("listTasks enumerates registered agent runs", () => {
		const a = startAgentRecentRun("single", [{ agent: "scout", task: "A" }], { background: true });
		const b = startAgentRecentRun("single", [{ agent: "scout", task: "B" }], { background: true });

		const tasks = listTasks();
		expect(tasks.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
		expect(tasks.every((t) => t.type === "local_agent")).toBe(true);
	});

	test("getTaskSnapshot finds task by id across adapters", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map" }], { background: true });
		expect(getTaskSnapshot(run.id)?.id).toBe(run.id);
		expect(getTaskSnapshot("does-not-exist")).toBeUndefined();
	});

	test("kill dispatches to cancelAgentRecentRun", async () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		const cancel = vi.fn();
		attachAgentRecentRunController(run.id, { cancel });

		const result = await LocalAgentTask.kill?.(run.id);
		expect(cancel).toHaveBeenCalledOnce();
		expect(result?.ok).toBe(true);
		expect(result?.snapshot?.status).toBe("cancelled");
	});

	test("requestShutdown dispatches to interruptAgentRecentRun", async () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		const interrupt = vi.fn();
		attachAgentRecentRunController(run.id, { interrupt, resume: vi.fn() });

		const result = await LocalAgentTask.requestShutdown?.(run.id);
		expect(interrupt).toHaveBeenCalledOnce();
		expect(result?.ok).toBe(true);
		expect(result?.snapshot?.status).toBe("interrupted");
		expect(result?.snapshot?.resumable).toBe(true);
	});

	test("injectMessage on a running task calls controller.inject with the message", async () => {
		// Behavior set by commit 849b3e11 ("steer input into running background
		// agents"): running tasks now use a single controller.inject(message) call
		// instead of the previous interrupt→resume pattern, so the message is
		// delivered at the next turn boundary without tearing down the loop.
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		const interrupt = vi.fn();
		const resume = vi.fn();
		const inject = vi.fn();
		attachAgentRecentRunController(run.id, { interrupt, resume, inject });

		const result = await LocalAgentTask.injectMessage?.(run.id, "look at config.ts");
		expect(inject).toHaveBeenCalledWith("look at config.ts");
		expect(interrupt).not.toHaveBeenCalled();
		expect(resume).not.toHaveBeenCalled();
		expect(result?.ok).toBe(true);
	});

	test("injectMessage on an interrupted task skips the interrupt and resumes directly", async () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "running",
			runs: [makeRunDetails("running")],
		});
		const interrupt = vi.fn();
		const resume = vi.fn();
		attachAgentRecentRunController(run.id, { interrupt, resume });

		// First soft-stop
		await LocalAgentTask.requestShutdown?.(run.id);
		expect(interrupt).toHaveBeenCalledOnce();

		// Now inject — should not interrupt again, just resume
		const result = await LocalAgentTask.injectMessage?.(run.id, "follow up");
		expect(interrupt).toHaveBeenCalledOnce(); // still one
		expect(resume).toHaveBeenCalledWith("follow up");
		expect(result?.ok).toBe(true);
	});

	test("injectMessage rejects empty input", async () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map" }], { background: true });
		const result = await LocalAgentTask.injectMessage?.(run.id, "   ");
		expect(result?.ok).toBe(false);
		expect(result?.message).toContain("empty");
	});

	test("injectMessage on unknown id returns ok=false", async () => {
		const result = await LocalAgentTask.injectMessage?.("nope", "hi");
		expect(result?.ok).toBe(false);
		expect(result?.message).toContain("nope");
	});

	test("snapshot reflects terminal status after run completes", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map" }], { background: true });
		finishAgentRecentRun(run, {
			mode: "single",
			status: "completed",
			runs: [makeRunDetails("completed")],
		});

		const snap = LocalAgentTask.snapshot(run.id);
		expect(snap?.status).toBe("completed");
		expect(snap?.endedAt).toBeGreaterThan(0);
	});

	test("acknowledge moves a failed pre-start parallel run out of needs input without removing it", async () => {
		const run = startAgentRecentRun(
			"parallel",
			[
				{ agent: "missing-model", task: "First" },
				{ agent: "missing-model", task: "Second" },
			],
			{ background: true },
		);
		failAgentRecentRun(run, new Error("Model unavailable before children started"));

		expect(LocalAgentTask.snapshot(run.id)).toMatchObject({ status: "failed", needsInput: true, children: [] });

		const result = await LocalAgentTask.acknowledge?.(run.id);

		expect(result?.ok).toBe(true);
		expect(result?.snapshot).toMatchObject({ id: run.id, status: "failed", needsInput: false, children: [] });
		expect(findAgentRecentRun(run.id)).toMatchObject({ id: run.id, status: "failed", runs: [] });
	});

	test("acknowledge clears failed child attention without removing diagnostic artifacts", async () => {
		const outputPath = join(tempDir, "failed-review.md");
		const run = startAgentRecentRun(
			"parallel",
			[
				{ agent: "scout", task: "First" },
				{ agent: "scout", task: "Second" },
			],
			{ background: true },
		);
		finishAgentRecentRun(run, {
			mode: "parallel",
			status: "failed",
			runs: [{ ...makeRunDetails("failed"), outputPath }, makeRunDetails("completed")],
		});

		expect(LocalAgentTask.snapshot(run.id)?.children?.map((child) => child.needsInput)).toEqual([true, false]);

		const result = await LocalAgentTask.acknowledge?.(run.id);
		const repeated = await LocalAgentTask.acknowledge?.(run.id);
		const stored = findAgentRecentRun(run.id);

		expect(result?.ok).toBe(true);
		expect(result?.snapshot?.children?.map((child) => child.needsInput)).toEqual([false, false]);
		expect(repeated).toMatchObject({ ok: true, message: `${run.id} is already dismissed` });
		expect(stored?.outputPaths).toEqual([outputPath]);
		expect(stored?.sessionRefs).toHaveLength(2);
		expect(stored?.sessionRefs[0]).toEqual({
			agent: "scout",
			sessionId: "child-session",
			sessionPath: childSessionPath,
		});
	});

	test("acknowledge rejects a non-failed run", async () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Still working" }], { background: true });

		const result = await LocalAgentTask.acknowledge?.(run.id);

		expect(result).toMatchObject({ ok: false, message: `${run.id} is not a failed terminal run (status: running)` });
		expect(findAgentRecentRun(run.id)).toMatchObject({ status: "running", acknowledged: false });
	});
});

describe("tasks registry — LocalBashTask adapter", () => {
	let bashTempDir = "";

	beforeEach(() => {
		killAllBashBgJobs();
		clearAgentRecentRunsForTests();
		bashTempDir = mkdtempSync(join(tmpdir(), "tasks-bash-"));
	});

	afterEach(() => {
		killAllBashBgJobs();
		if (bashTempDir) rmSync(bashTempDir, { recursive: true, force: true });
	});

	test("snapshot maps a running BashBgJob onto TaskSnapshot", () => {
		const job = spawnBashBackground("sleep 2", bashTempDir);
		const snap = LocalBashTask.snapshot(job.id);
		expect(snap).toMatchObject({ id: job.id, type: "local_bash", status: "running", resumable: false });
		expect(snap?.description).toContain("sleep 2");
		expect(snap?.startedAt).toBeGreaterThan(0);
	});

	test("kill stops a running background job", async () => {
		const job = spawnBashBackground("sleep 30", bashTempDir);
		const result = await LocalBashTask.kill?.(job.id);
		expect(result?.ok).toBe(true);
		expect(result?.snapshot?.status).toBe("killed");
	});

	test("kill on a finished job is a no-op success", async () => {
		const job = spawnBashBackground("true", bashTempDir);
		await waitForJobToSettle(job.id);
		const result = await LocalBashTask.kill?.(job.id);
		expect(result?.ok).toBe(true);
		expect(result?.snapshot?.status).toBe("completed");
	});

	test("kill on unknown id returns ok=false", async () => {
		const result = await LocalBashTask.kill?.("bg_nope");
		expect(result?.ok).toBe(false);
		expect(result?.message).toContain("bg_nope");
	});

	test("unified registry enumerates agent runs AND bash jobs in one seam", () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map" }], { background: true });
		const job = spawnBashBackground("sleep 2", bashTempDir);

		const tasks = listTasks();
		const byId = new Map(tasks.map((t) => [t.id, t.type]));
		expect(byId.get(run.id)).toBe("local_agent");
		expect(byId.get(job.id)).toBe("local_bash");

		// Cross-adapter resolution: getTaskSnapshot finds either flavor by id alone.
		expect(getTaskSnapshot(run.id)?.type).toBe("local_agent");
		expect(getTaskSnapshot(job.id)?.type).toBe("local_bash");
	});
});
