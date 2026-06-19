import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	clearAgentRecentRunsForTests,
	startAgentRecentRun,
	updateAgentRecentRunProgress,
} from "../src/core/agents/status.ts";
import type { AgentRunDetails } from "../src/core/agents/types.ts";
import { LocalAgentTask } from "../src/core/tasks/local-agent-task.ts";
import { LocalBashTask } from "../src/core/tasks/local-bash-task.ts";
import {
	createTaskBackgroundListToolDefinition,
	createTaskStopToolDefinition,
} from "../src/core/tools/background-tasks.ts";
import {
	createBashOutputToolDefinition,
	getBashBgJob,
	killAllBashBgJobs,
	spawnBashBackground,
} from "../src/core/tools/bash.ts";

const TaskStop = createTaskStopToolDefinition();
const TaskBackgroundList = createTaskBackgroundListToolDefinition();
const BashOutput = createBashOutputToolDefinition();

/** Invoke a tool's execute with the unused signal/onUpdate/ctx slots padded out. */
async function call(tool: { execute: unknown }, params: Record<string, unknown>): Promise<string> {
	const run = tool.execute as (...a: unknown[]) => Promise<{ content: Array<{ text?: string }> }>;
	const result = await run("c1", params, undefined, undefined, undefined);
	return result.content.map((part) => part.text ?? "").join("");
}

async function waitForJobToSettle(jobId: string, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (getBashBgJob(jobId)?.status !== "running") return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function completedRunDetail(finalOutput: string): AgentRunDetails {
	return {
		agent: "scout",
		source: "builtin",
		task: "Map files",
		status: "completed",
		context: {
			mode: "default",
			includeTranscript: false,
			includeProjectContext: true,
			includeSkills: true,
			includeAppendSystemPrompt: true,
		},
		effectiveTools: ["read"],
		deniedTools: [],
		durationMs: 1,
		toolCallCount: 0,
		messageCount: 1,
		recentToolCalls: [],
		recentOutputSnippets: [],
		loadedSkills: [],
		invokedSkills: { count: 0, names: [] },
		finalOutput,
	};
}

describe("background-tasks tools — push notification + explicit output paths", () => {
	let bashTempDir = "";

	beforeEach(() => {
		killAllBashBgJobs();
		clearAgentRecentRunsForTests();
		bashTempDir = mkdtempSync(join(tmpdir(), "bg-tasks-"));
	});

	afterEach(() => {
		killAllBashBgJobs();
		clearAgentRecentRunsForTests();
		if (bashTempDir) rmSync(bashTempDir, { recursive: true, force: true });
	});

	test("TaskOutput is not exported as a model-facing tool", async () => {
		const mod = await import("../src/core/tools/background-tasks.ts");
		expect("createTaskOutputToolDefinition" in mod).toBe(false);
		expect("createTaskOutputTool" in mod).toBe(false);
	});

	test("background bash adapter exposes output file path for Read inspection", async () => {
		const job = spawnBashBackground("echo hello-from-bash", bashTempDir);
		await waitForJobToSettle(job.id);
		const output = await LocalBashTask.output?.(job.id, { mode: "tail", maxLines: 20 });
		expect(output?.text).toContain(`bgId: ${job.id}`);
		expect(output?.text).toContain("status:");
		expect(output?.text).toContain("hello-from-bash");
		expect(output?.fullOutputPath).toBe(job.logPath);
	});

	test("background bash adapter exposes non-zero exit status and output file path", async () => {
		const job = spawnBashBackground("echo failed-background; exit 7", bashTempDir);
		await waitForJobToSettle(job.id);
		const output = await LocalBashTask.output?.(job.id, { mode: "tail", maxLines: 20 });
		expect(output?.text).toContain(`bgId: ${job.id}`);
		expect(output?.text).toContain("status: exited (exit 7)");
		expect(output?.text).toContain("failed-background");
		expect(output?.fullOutputPath).toBe(job.logPath);
	});

	test("background agent adapter returns final result and output path when available", async () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "completed",
			runs: [{ ...completedRunDetail("AGENT FINAL RESULT"), outputPath: "/tmp/agent-output.txt" }],
		});
		const output = await LocalAgentTask.output?.(run.id);
		expect(output?.text).toContain(run.id);
		expect(output?.text).toContain("AGENT FINAL RESULT");
		expect(output?.fullOutputPath).toBe("/tmp/agent-output.txt");
	});

	test("background agent adapter avoids full render for bounded path discovery", async () => {
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		updateAgentRecentRunProgress(run, {
			mode: "single",
			status: "completed",
			runs: [{ ...completedRunDetail("VERY LARGE AGENT FINAL RESULT"), outputPath: "/tmp/agent-output.txt" }],
		});
		const output = await LocalAgentTask.output?.(run.id, { mode: "tail", maxLines: 1 });
		expect(output?.text).toBe(`${run.id}: completed`);
		expect(output?.text).not.toContain("VERY LARGE AGENT FINAL RESULT");
		expect(output?.fullOutputPath).toBe("/tmp/agent-output.txt");
	});

	test("BashOutput renders persisted bash log when registry entry is gone", async () => {
		const job = spawnBashBackground("echo orphaned-bash-output", bashTempDir);
		await waitForJobToSettle(job.id);
		killAllBashBgJobs();

		const text = await call(BashOutput, { bgId: job.id });
		expect(text).toContain("status: registry-missing");
		expect(text).toContain("orphaned-bash-output");
	});

	test("TaskStop kills a running bash job", async () => {
		const job = spawnBashBackground("sleep 30", bashTempDir);
		const text = await call(TaskStop, { task_id: job.id });
		expect(text).toContain("Killed");
		expect(getBashBgJob(job.id)?.status).toBe("killed");
	});

	test("TaskStop accepts the deprecated shell_id alias", async () => {
		const job = spawnBashBackground("sleep 30", bashTempDir);
		const text = await call(TaskStop, { shell_id: job.id });
		expect(text).toContain("Killed");
		expect(getBashBgJob(job.id)?.status).toBe("killed");
	});

	test("TaskStop with neither id errors clearly", async () => {
		const text = await call(TaskStop, {});
		expect(text).toContain("requires task_id");
	});

	test("TaskStop on unknown id reports no stoppable task", async () => {
		const text = await call(TaskStop, { task_id: "nope" });
		expect(text).toContain("No stoppable background task");
	});

	test("TaskBackgroundList enumerates bash jobs and background agent runs together", async () => {
		const job = spawnBashBackground("sleep 5", bashTempDir);
		const foregroundRun = startAgentRecentRun("single", [{ agent: "scout", task: "Foreground map" }]);
		const run = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });
		const text = await call(TaskBackgroundList, {});
		expect(text).toContain(job.id);
		expect(text).toContain("[bash]");
		expect(text).toContain(run.id);
		expect(text).toContain("[agent]");
		expect(text).not.toContain(foregroundRun.id);
	});

	test("TaskBackgroundList with no tasks says so", async () => {
		const text = await call(TaskBackgroundList, {});
		expect(text).toBe("No background tasks.");
	});
});
