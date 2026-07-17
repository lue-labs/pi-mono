import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../src/core/extensions/types.ts";
import { type BashBgJobStore, killAllBashBgJobs, spawnBashBackground } from "../src/core/tools/bash.ts";

vi.mock("../src/core/tools/bash.ts", async (importActual) => {
	const actual = await importActual<typeof import("../src/core/tools/bash.ts")>();
	return {
		...actual,
		createBashOutputNativeToolDefinition: vi.fn(() => ({ name: "BashOutput" })),
		createKillShellToolDefinition: vi.fn(() => ({ name: "KillShell" })),
		sweepStaleBashBgLogs: vi.fn(),
	};
});

import { hookBashBackgroundJobs } from "../src/core/extensions/bash-bg-jobs.ts";

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => void;

function installHook(): { start: SessionStartHandler; dispose: () => void; jobs: BashBgJobStore } {
	let start: SessionStartHandler | undefined;
	let dispose: (() => void) | undefined;
	let jobs: BashBgJobStore | undefined;
	const pi = {
		harness: {
			provide: vi.fn((_id: string, service: BashBgJobStore) => {
				jobs = service;
			}),
		},
		registerTool: vi.fn(),
		on: vi.fn((event: string, handler: SessionStartHandler) => {
			if (event === "session_start") start = handler;
		}),
		onSessionDispose: vi.fn((handler: () => void) => {
			dispose = handler;
		}),
	} as unknown as ExtensionAPI;

	hookBashBackgroundJobs(pi);
	if (!start || !dispose || !jobs) throw new Error("bash background hook did not register lifecycle handlers");
	return { start, dispose, jobs };
}

function context(sessionId: string, source: ExtensionContext["source"]): ExtensionContext {
	return {
		source,
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
}

afterEach(() => {
	killAllBashBgJobs();
});

describe("bash background job extension disposal", () => {
	it("reaps the disposed child session's actual jobs without killing parent jobs", () => {
		const hook = installHook();
		const childJob = spawnBashBackground("sleep 30", process.cwd(), undefined, undefined, "child-session");
		const parentJob = spawnBashBackground("sleep 30", process.cwd(), undefined, undefined, "root-session");
		hook.start({ type: "session_start", reason: "startup" }, context("child-session", "child-agent"));

		hook.dispose();

		expect(childJob.status).toBe("killed");
		expect(parentJob.status).toBe("running");
		expect(hook.jobs.list()).toEqual(expect.arrayContaining([childJob, parentJob]));
	});

	it("keeps root-session disposal as the actual all-jobs backstop", () => {
		const hook = installHook();
		const rootJob = spawnBashBackground("sleep 30", process.cwd(), undefined, undefined, "root-session");
		const childJob = spawnBashBackground("sleep 30", process.cwd(), undefined, undefined, "child-session");
		hook.start({ type: "session_start", reason: "startup" }, context("root-session", "interactive"));

		hook.dispose();

		expect(rootJob.status).toBe("killed");
		expect(childJob.status).toBe("killed");
		expect(hook.jobs.list()).toEqual([]);
	});
});
