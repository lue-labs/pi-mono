// bash_kill — stop a backgrounded bash job
// (fork-owned; extracted verbatim from bash.ts).

import type { AgentTool } from "@valkyriweb/pi-agent-core";
import { type Static, Type } from "typebox";
import { type BashBgJob, type BashBgJobStore, createBashBgJobStore } from "../bash-bg-jobs.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const bashKillSchema = Type.Object({
	bgId: Type.String({ description: "Background job id returned by bash(run_in_background:true)." }),
});

export type BashKillToolInput = Static<typeof bashKillSchema>;

export function createBashKillToolDefinition(options?: {
	toolName?: string;
	label?: string;
	jobs?: BashBgJobStore;
	alwaysLoad?: boolean;
}): ToolDefinition<typeof bashKillSchema, BashBgJob | undefined> {
	const toolName = options?.toolName ?? "bash_kill";
	const label = options?.label ?? "KillShell";
	const jobs = options?.jobs ?? createBashBgJobStore();
	return {
		name: toolName,
		label,
		description:
			"Stop a backgrounded bash job (started via bash with run_in_background:true). Sends SIGTERM to the whole process tree; the job moves to status=killed. Idempotent \u2014 calling on an already-finished job is safe and just reports state.",
		promptSnippet: "Stop a backgrounded bash job by bgId",
		alwaysLoad: options?.alwaysLoad,
		executionMode: "sequential",
		parameters: bashKillSchema,
		async execute(_id, { bgId }) {
			const job = jobs.get(bgId);
			if (!job) {
				return {
					content: [{ type: "text", text: `No background bash job with bgId=${bgId}` }],
					details: undefined,
				};
			}
			if (job.status !== "running") {
				return {
					content: [
						{
							type: "text",
							text: `bgId=${bgId} already ${job.status} (exit ${job.exitCode}, signal ${job.signal ?? "none"}).`,
						},
					],
					details: job,
				};
			}
			const killed = jobs.kill(bgId);
			if (killed.error) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to kill bgId=${bgId} (pid=${job.pid}): ${killed.error}`,
						},
					],
					details: job,
				};
			}
			return {
				content: [{ type: "text", text: `Killed bgId=${bgId} (pid=${job.pid ?? "unknown"}).` }],
				details: job,
			};
		},
	};
}

export function createBashKillTool(): AgentTool<typeof bashKillSchema> {
	return wrapToolDefinition(createBashKillToolDefinition());
}

export function createKillShellToolDefinition(options?: {
	jobs?: BashBgJobStore;
	alwaysLoad?: boolean;
}): ToolDefinition<typeof bashKillSchema, BashBgJob | undefined> {
	return createBashKillToolDefinition({
		toolName: "KillShell",
		label: "KillShell",
		jobs: options?.jobs,
		alwaysLoad: options?.alwaysLoad,
	});
}

export function createKillShellTool(): AgentTool<typeof bashKillSchema> {
	return wrapToolDefinition(createKillShellToolDefinition());
}
