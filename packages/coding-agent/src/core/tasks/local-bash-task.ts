/**
 * LocalBashTask — Task adapter over `BashBgJob`.
 *
 * Maps the unified Task verbs onto pi's background-bash control surface in
 * `core/tools/bash.ts`:
 *
 *   Task.kill → killBashBgJob   (hard abort of the process tree)
 *
 * Background bash jobs have no cooperative-shutdown or message-injection
 * channel, so `requestShutdown` and `injectMessage` are intentionally absent —
 * the unified Task interface marks both optional. This is a pure facade: the
 * job store in `core/tools/bash.ts` stays the single source of truth, so the
 * TUI and the unified task tools talk to one interface regardless of flavor.
 */

import type { BashBgJob } from "../tools/bash.ts";
import { getBashBgJob, killBashBgJob, renderBashBgOutput } from "../tools/bash.ts";
import type { Task, TaskControlResult, TaskOutputResult, TaskSnapshot, TaskStatus } from "./types.ts";

function mapStatus(job: BashBgJob): TaskStatus {
	if (job.lifecycle?.terminalReason === "non_zero_exit" || job.lifecycle?.terminalReason === "output_limit") {
		return "failed";
	}
	switch (job.status) {
		case "running":
			return "running";
		case "exited":
			return "completed";
		case "killed":
			return "killed";
		case "failed":
			return "failed";
	}
}

function describeJob(job: BashBgJob): string {
	const command = job.command.replace(/\s+/g, " ").trim();
	return command.length > 60 ? `${command.slice(0, 59)}…` : command;
}

function snapshotFromJob(job: BashBgJob): TaskSnapshot {
	const lifecycle = job.lifecycle;
	return {
		id: job.id,
		type: "local_bash",
		status: mapStatus(job),
		description: describeJob(job),
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		outputPath: job.logPath,
		// Background bash jobs cannot resume once stopped.
		resumable: false,
		error: job.error,
		// Needs-input only for a genuine user wait: the job stalled on an
		// interactive prompt. A failed job is settled state (its failure is
		// already delivered via task_notification), not a pending user action.
		needsInput: lifecycle?.promptStalledAt !== undefined,
		lifecycle: {
			ownerSessionId: job.ownerSessionId,
			terminalReason: lifecycle?.terminalReason,
			promptStalled: lifecycle?.promptStalledAt !== undefined,
			outputBytes: lifecycle?.outputBytes,
			outputLimitBytes: lifecycle?.outputLimitBytes,
		},
	};
}

function lookup(taskId: string): TaskSnapshot | undefined {
	const job = getBashBgJob(taskId);
	return job ? snapshotFromJob(job) : undefined;
}

export const LocalBashTask: Task = {
	type: "local_bash",

	snapshot(taskId) {
		return lookup(taskId);
	},

	async output(taskId, options): Promise<TaskOutputResult | undefined> {
		const job = getBashBgJob(taskId);
		if (!job) return undefined;
		const rendered = renderBashBgOutput(job, options);
		return { text: rendered.text, fullOutputPath: rendered.fullOutputPath, snapshot: snapshotFromJob(job) };
	},

	async kill(taskId): Promise<TaskControlResult> {
		const job = getBashBgJob(taskId);
		if (!job) return { ok: false, message: `Background job not found: ${taskId}` };
		if (job.status !== "running") {
			return { ok: true, message: `${taskId} already ${job.status}`, snapshot: snapshotFromJob(job) };
		}
		const { error } = killBashBgJob(taskId);
		if (error) return { ok: false, message: error, snapshot: lookup(taskId) };
		return { ok: true, message: `Killed ${taskId}`, snapshot: lookup(taskId) };
	},
};
