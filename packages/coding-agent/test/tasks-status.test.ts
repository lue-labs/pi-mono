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
import { formatObserverFooterStatus, formatTaskFooterStatus, formatTaskStatus } from "../src/core/tasks/status.ts";
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

	test("footer reports a running background bash job even without background agents", () => {
		const job = spawnBashBackground("sleep 5", bashTempDir);

		const footer = formatTaskFooterStatus();
		expect(footer).toContain("Background:");
		expect(footer).toContain("1 running");
		expect(footer).toContain("1 shell");
		expect(footer).toContain(job.id);
		expect(footer).toContain("bash");
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

	test("observer runs are excluded from Background footer and get a dedicated observer footer", () => {
		const observer = startAgentRecentRun(
			"single",
			[{ agent: "general", task: "You are now armed as a background observer." }],
			{ background: true, kind: "observer" },
		);
		const regular = startAgentRecentRun("single", [{ agent: "scout", task: "Map files" }], { background: true });

		const backgroundFooter = formatTaskFooterStatus();
		expect(backgroundFooter).toContain("Background: 1 running");
		expect(backgroundFooter).toContain(regular.id);
		expect(backgroundFooter).not.toContain(observer.id);

		const observerFooter = formatObserverFooterStatus();
		expect(observerFooter).toContain("Observer: 1 armed");
		expect(observerFooter).toContain(observer.id);
		expect(observerFooter).not.toContain("Background:");

		const status = formatTaskStatus();
		expect(status).toContain(`${observer.id} [observer] armed`);
	});
});
