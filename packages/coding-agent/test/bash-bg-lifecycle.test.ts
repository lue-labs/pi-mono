import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalBashTask } from "../src/core/tasks/local-bash-task.ts";
import {
	BASH_BG_STALL_THRESHOLD_MS,
	type BackgroundShellNotification,
	type BashBgJob,
	checkBashBgLifecycle,
	killAllBashBgJobs,
	killBashBgJob,
	looksLikeBashBgPrompt,
	renderBashBgOutput,
	spawnBashBackground,
	subscribeBashBgNotificationForOwner,
	subscribeBashBgStall,
	subscribeBashBgStallForOwner,
	subscribeBashBgTerminal,
	subscribeBashBgTerminalForOwner,
} from "../src/core/tools/bash.ts";

let cwd = "";

async function waitForTerminal(job: { status: string }, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (job.status === "running" && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function waitForFile(path: string, minBytes: number, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while ((!existsSync(path) || statSync(path).size < minBytes) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

beforeEach(() => {
	killAllBashBgJobs();
	cwd = mkdtempSync(join(tmpdir(), "bash-bg-lifecycle-"));
});

afterEach(() => {
	killAllBashBgJobs();
	if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("background bash lifecycle watchdog", () => {
	it("renders legacy public jobs without lifecycle metadata", () => {
		const logPath = join(cwd, "legacy.log");
		writeFileSync(logPath, "legacy output\n");
		const job: BashBgJob = {
			id: "legacy",
			command: "true",
			cwd,
			pid: undefined,
			startedAt: Date.now(),
			status: "exited",
			exitCode: 0,
			signal: null,
			logPath,
			endedAt: Date.now(),
			error: undefined,
		};

		expect(renderBashBgOutput(job).text).toContain("legacy output");
	});

	it("recognizes only actionable interactive prompts on the final output line", () => {
		for (const prompt of [
			"Continue (y/n)",
			"Continue (Y/n)",
			"Continue (y/N)",
			"Continue [y/n]",
			"Continue (yes/no)",
			"Are you sure?",
			"Press Enter",
			"Press any key",
			"Continue?",
			"Overwrite?",
		]) {
			expect(looksLikeBashBgPrompt(`progress\n${prompt}`)).toBe(true);
		}
		expect(looksLikeBashBgPrompt("Continue?\nnow compiling")).toBe(false);
		expect(looksLikeBashBgPrompt("progress: Continue? later")).toBe(false);
		expect(looksLikeBashBgPrompt("selected (y/n) earlier")).toBe(false);
		expect(looksLikeBashBgPrompt("quiet build output")).toBe(false);
	});

	it("latches a prompt-stall wake per unchanged output size and re-arms after growth", () => {
		const job = spawnBashBackground("sleep 30", cwd);
		const stalls = vi.fn();
		const unsubscribe = subscribeBashBgStall(stalls);
		try {
			appendFileSync(job.logPath, "Continue?");
			checkBashBgLifecycle(job.startedAt);
			checkBashBgLifecycle(job.startedAt + BASH_BG_STALL_THRESHOLD_MS);
			checkBashBgLifecycle(job.startedAt + BASH_BG_STALL_THRESHOLD_MS + 5_000);

			expect(stalls).toHaveBeenCalledTimes(1);
			expect(job.lifecycle?.promptStalledAt).toBeDefined();
			expect(LocalBashTask.snapshot(job.id)?.lifecycle).toMatchObject({ promptStalled: true });

			appendFileSync(job.logPath, "\nContinue?");
			checkBashBgLifecycle(job.startedAt + BASH_BG_STALL_THRESHOLD_MS + 10_000);
			checkBashBgLifecycle(job.startedAt + BASH_BG_STALL_THRESHOLD_MS * 2 + 10_000);

			expect(stalls).toHaveBeenCalledTimes(2);
		} finally {
			unsubscribe();
		}
	});

	it("excludes only explicitly tagged monitor jobs and never treats a quiet watcher as a prompt", () => {
		const monitor = spawnBashBackground("sleep 30", cwd, undefined, undefined, undefined, { kind: "monitor" });
		const commandNamedMonitor = spawnBashBackground("sleep 30 # monitor", cwd);
		const quiet = spawnBashBackground("sleep 30", cwd);
		const stalls = vi.fn();
		const unsubscribe = subscribeBashBgStall(stalls);
		try {
			appendFileSync(monitor.logPath, "Continue?");
			appendFileSync(commandNamedMonitor.logPath, "Continue?");
			checkBashBgLifecycle(monitor.startedAt);
			checkBashBgLifecycle(monitor.startedAt + BASH_BG_STALL_THRESHOLD_MS * 2);
			checkBashBgLifecycle(commandNamedMonitor.startedAt);
			checkBashBgLifecycle(commandNamedMonitor.startedAt + BASH_BG_STALL_THRESHOLD_MS * 2);
			checkBashBgLifecycle(quiet.startedAt + BASH_BG_STALL_THRESHOLD_MS * 2);

			expect(stalls).toHaveBeenCalledExactlyOnceWith(commandNamedMonitor);
			expect(monitor.status).toBe("running");
			expect(commandNamedMonitor.status).toBe("running");
			expect(quiet.status).toBe("running");
		} finally {
			unsubscribe();
		}
	});

	it("enforces the exact output cap at the write seam", async () => {
		const job = spawnBashBackground(
			`node -e 'process.stdout.write("x".repeat(4096)); setTimeout(() => {}, 30000)'`,
			cwd,
			undefined,
			undefined,
			"owner-session",
			{ maxOutputBytes: 64 },
		);
		await waitForTerminal(job);

		expect(job.status).toBe("killed");
		expect(job.lifecycle?.terminalReason).toBe("output_limit");
		expect(job.lifecycle?.outputBytes).toBe(64);
		expect(statSync(job.logPath).size).toBe(64);
	});

	it("deduplicates output-limit wakes across stream, exit, and watchdog races", async () => {
		const terminal = vi.fn();
		const unsubscribe = subscribeBashBgTerminal(terminal);
		const job = spawnBashBackground(
			`node -e 'process.stdout.write("x".repeat(4096))'`,
			cwd,
			undefined,
			undefined,
			"owner-session",
			{ maxOutputBytes: 64 },
		);
		try {
			await waitForTerminal(job);
			checkBashBgLifecycle();
			checkBashBgLifecycle();

			expect(job.lifecycle?.terminalReason).toBe("output_limit");
			expect(terminal).toHaveBeenCalledExactlyOnceWith(job);
		} finally {
			unsubscribe();
		}
	});

	it("sends exact one-shot owner payloads for clean, failed, and signalled terminals", async () => {
		const notifications: BackgroundShellNotification[] = [];
		const unsubscribe = subscribeBashBgNotificationForOwner("owner", (notification) => notifications.push(notification));
		const clean = spawnBashBackground("true", cwd, undefined, undefined, "owner");
		const failed = spawnBashBackground("exit 7", cwd, undefined, undefined, "owner");
		const signalled = spawnBashBackground("kill -TERM $$", cwd, undefined, undefined, "owner");
		try {
			await Promise.all([waitForTerminal(clean), waitForTerminal(failed), waitForTerminal(signalled)]);

			expect(notifications.filter((notification) => notification.taskId === clean.id)).toHaveLength(1);
			expect(notifications.find((notification) => notification.taskId === clean.id)).toEqual({
				type: "shell_completion",
				taskId: clean.id,
				ownerSessionId: "owner",
				status: "exited",
				exitCode: 0,
				signal: null,
				outputPath: clean.logPath,
				summary: "Background shell task completed.",
				terminalReason: "clean_exit",
			});
			expect(notifications.find((notification) => notification.taskId === failed.id)).toEqual({
				type: "shell_completion",
				taskId: failed.id,
				ownerSessionId: "owner",
				status: "failed",
				exitCode: 7,
				signal: null,
				outputPath: failed.logPath,
				summary: "Background shell task failed.",
				terminalReason: "non_zero_exit",
			});
			expect(notifications.find((notification) => notification.taskId === signalled.id)).toEqual({
				type: "shell_completion",
				taskId: signalled.id,
				ownerSessionId: "owner",
				status: "killed",
				exitCode: null,
				signal: "SIGTERM",
				outputPath: signalled.logPath,
				summary: "Background shell task was stopped.",
				terminalReason: "signal",
			});
		} finally {
			unsubscribe();
		}
	});

	it("distinguishes owner prompt and output-limit payloads without duplicate wakes", async () => {
		const notifications: BackgroundShellNotification[] = [];
		const unsubscribe = subscribeBashBgNotificationForOwner("owner", (notification) => notifications.push(notification));
		const stalled = spawnBashBackground("sleep 30", cwd, undefined, undefined, "owner");
		const limited = spawnBashBackground(
			`node -e 'process.stdout.write("x".repeat(4096))'`,
			cwd,
			undefined,
			undefined,
			"owner",
			{ maxOutputBytes: 64 },
		);
		try {
			appendFileSync(stalled.logPath, "Continue?");
			checkBashBgLifecycle(stalled.startedAt);
			checkBashBgLifecycle(stalled.startedAt + BASH_BG_STALL_THRESHOLD_MS);
			checkBashBgLifecycle(stalled.startedAt + BASH_BG_STALL_THRESHOLD_MS + 5_000);
			await waitForTerminal(limited);
			checkBashBgLifecycle();

			expect(notifications.filter((notification) => notification.taskId === stalled.id)).toEqual([
				{
					type: "shell_needs_input",
					taskId: stalled.id,
					ownerSessionId: "owner",
					status: "failed",
					exitCode: null,
					signal: null,
					outputPath: stalled.logPath,
					summary: "Background shell task needs input.",
				},
			]);
			expect(notifications.filter((notification) => notification.taskId === limited.id)).toEqual([
				{
					type: "shell_output_limited",
					taskId: limited.id,
					ownerSessionId: "owner",
					status: "killed",
					exitCode: null,
					signal: "SIGKILL",
					outputPath: limited.logPath,
					summary: "Background shell task stopped after reaching its output limit.",
					terminalReason: "output_limit",
				},
			]);
		} finally {
			unsubscribe();
		}
	});

	it("writes late pipe output before publishing a natural terminal notification", async () => {
		const observedOutput: string[] = [];
		const unsubscribe = subscribeBashBgTerminal((job) => {
			observedOutput.push(readFileSync(job.logPath, "utf8"));
		});
		const job = spawnBashBackground(`(sleep 0.05; printf late-output) &`, cwd);
		try {
			await waitForTerminal(job);

			expect(job.status).toBe("exited");
			expect(readFileSync(job.logPath, "utf8")).toBe("late-output");
			expect(observedOutput).toEqual(["late-output"]);
		} finally {
			unsubscribe();
		}
	});

	it("classifies a post-exit oversized pipe write as an output-limit terminal", async () => {
		const job = spawnBashBackground(
			`(sleep 0.05; printf 'x%.0s' {1..4096}) &`,
			cwd,
			undefined,
			undefined,
			undefined,
			{
				maxOutputBytes: 64,
			},
		);
		await waitForTerminal(job);

		expect(job.status).toBe("killed");
		expect(job.lifecycle?.terminalReason).toBe("output_limit");
		expect(statSync(job.logPath).size).toBe(64);
	});

	it("wakes exactly once when spawning the child fails", async () => {
		const terminal = vi.fn();
		const unsubscribe = subscribeBashBgTerminal(terminal);
		const job = spawnBashBackground("echo never-runs", cwd, cwd);
		try {
			await waitForTerminal(job);
			checkBashBgLifecycle();

			expect(job.status).toBe("failed");
			expect(job.lifecycle?.terminalReason).toBe("spawn_error");
			expect(terminal).toHaveBeenCalledExactlyOnceWith(job);
		} finally {
			unsubscribe();
		}
	});

	it("routes prompt and terminal wakes to only the current owner receiver", async () => {
		const replacedOwnerTerminal = vi.fn();
		const ownerTerminal = vi.fn();
		const otherTerminal = vi.fn();
		const ownerStall = vi.fn();
		const otherStall = vi.fn();
		const unsubscribeReplaced = subscribeBashBgTerminalForOwner("owner", replacedOwnerTerminal);
		const unsubscribeOwnerTerminal = subscribeBashBgTerminalForOwner("owner", ownerTerminal);
		const unsubscribeOtherTerminal = subscribeBashBgTerminalForOwner("other", otherTerminal);
		const unsubscribeOwnerStall = subscribeBashBgStallForOwner("owner", ownerStall);
		const unsubscribeOtherStall = subscribeBashBgStallForOwner("other", otherStall);
		const terminal = spawnBashBackground("true", cwd, undefined, undefined, "owner");
		const stalled = spawnBashBackground("sleep 30", cwd, undefined, undefined, "owner");
		try {
			await waitForTerminal(terminal);
			appendFileSync(stalled.logPath, "Continue?");
			checkBashBgLifecycle(stalled.startedAt);
			checkBashBgLifecycle(stalled.startedAt + BASH_BG_STALL_THRESHOLD_MS);

			expect(replacedOwnerTerminal).not.toHaveBeenCalled();
			expect(ownerTerminal).toHaveBeenCalledExactlyOnceWith(terminal);
			expect(otherTerminal).not.toHaveBeenCalled();
			expect(ownerStall).toHaveBeenCalledExactlyOnceWith(stalled);
			expect(otherStall).not.toHaveBeenCalled();
		} finally {
			unsubscribeReplaced();
			unsubscribeOwnerTerminal();
			unsubscribeOtherTerminal();
			unsubscribeOwnerStall();
			unsubscribeOtherStall();
		}
	});
});

describe("background bash terminal reasons", () => {
	it("distinguishes clean, non-zero, signal, and deliberate terminal paths", async () => {
		const clean = spawnBashBackground("true", cwd);
		const nonZero = spawnBashBackground("exit 7", cwd);
		const signalled = spawnBashBackground("kill -TERM $$", cwd);
		const manual = spawnBashBackground("sleep 30", cwd);

		await Promise.all([waitForTerminal(clean), waitForTerminal(nonZero), waitForTerminal(signalled)]);
		killBashBgJob(manual.id);
		await waitForTerminal(manual);

		expect(clean.lifecycle?.terminalReason).toBe("clean_exit");
		expect(nonZero.lifecycle?.terminalReason).toBe("non_zero_exit");
		expect(signalled.lifecycle?.terminalReason).toBe("signal");
		expect(manual.lifecycle?.terminalReason).toBe("manual_kill");
		expect(LocalBashTask.snapshot(nonZero.id)?.status).toBe("failed");
		expect(LocalBashTask.snapshot(nonZero.id)?.needsInput).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"reaps a descendant that keeps pipes open after its shell exits",
		async () => {
			const childPidPath = join(cwd, "orphan-descendant.pid");
			const job = spawnBashBackground(
				`(sleep 30) & child=$!; printf %s "$child" > ${JSON.stringify(childPidPath)}; exit 0`,
				cwd,
			);
			await waitForFile(childPidPath, 1);
			const childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(job.status).toBe("running");
			killBashBgJob(job.id);
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(job.lifecycle?.terminalReason).toBe("manual_kill");
			expect(() => process.kill(childPid, 0)).toThrow();
		},
	);

	it.skipIf(process.platform === "win32").each(["manual", "output-limit", "dispose"] as const)(
		"reaps descendants when stopped by %s",
		async (stop) => {
			const childPidPath = join(cwd, "descendant.pid");
			const job = spawnBashBackground(
				`(sleep 30) & child=$!; printf %s "$child" > ${JSON.stringify(childPidPath)}; ${stop === "output-limit" ? "printf 'x%.0s' {1..4096}; " : ""}wait "$child"`,
				cwd,
				undefined,
				undefined,
				undefined,
				stop === "output-limit" ? { maxOutputBytes: 64 } : undefined,
			);
			await waitForFile(childPidPath, 1);
			const childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);

			if (stop === "manual") killBashBgJob(job.id);
			else if (stop === "dispose") killAllBashBgJobs();
			else await waitForTerminal(job);
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(childPid).toBeGreaterThan(0);
			expect(() => process.kill(childPid, 0)).toThrow();
		},
	);
});
