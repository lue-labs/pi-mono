import {
	type BashBgJobStore,
	createBashBgJobStore,
	createBashOutputNativeToolDefinition,
	createKillShellToolDefinition,
	sweepStaleBashBgLogs,
} from "../tools/bash.ts";
import { addAction, load } from "./extension-hooks.ts";
import type { ExtensionAPI } from "./types.ts";

export const BASH_BG_JOBS_SERVICE_ID = "bash.bgJobs";

export function hookBashBackgroundJobs(pi: ExtensionAPI): void {
	// Reap background-bash logs left by crashed/force-killed past sessions so the
	// ~/.pi/agent/bash-bg directory cannot grow unbounded. Runs once at load (no
	// jobs exist yet) and off the hot path; best-effort, never throws.
	queueMicrotask(() => {
		sweepStaleBashBgLogs();
	});

	const jobs = createBashBgJobStore();
	pi.harness.provide<BashBgJobStore>(BASH_BG_JOBS_SERVICE_ID, jobs, { scope: "process" });

	pi.registerTool(createBashOutputNativeToolDefinition({ jobs, alwaysLoad: true }));
	pi.registerTool(createKillShellToolDefinition({ jobs, alwaysLoad: true }));

	let sessionId: string | undefined;
	let isRootSession = true;
	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		isRootSession = ctx.source !== "child-agent";
	});

	pi.onSessionDispose(() => {
		if (!isRootSession && sessionId) jobs.killForSession(sessionId);
		else jobs.killAll();
	});
}

addAction(load, "bashBgJobs", hookBashBackgroundJobs);
