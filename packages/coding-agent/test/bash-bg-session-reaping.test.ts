import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createBashToolDefinition,
	getBashBgJob,
	killAllBashBgJobs,
	killBashBgJobsForSession,
	listBashBgJobs,
	spawnBashBackground,
	subscribeBashBgTerminal,
} from "../src/core/tools/bash.ts";

afterEach(() => {
	killAllBashBgJobs();
});

describe("background bash session ownership", () => {
	it("tags an explicitly backgrounded job with the executing session", async () => {
		const bash = createBashToolDefinition(process.cwd());
		type BashContext = NonNullable<Parameters<typeof bash.execute>[4]>;
		const ctx = {
			sessionManager: { getSessionId: () => "child-session" },
		} as BashContext;

		const result = await bash.execute(
			"call-1",
			{ command: "sleep 30", run_in_background: true },
			undefined,
			undefined,
			ctx,
		);
		const bgId = (result.details as { bgId: string }).bgId;

		expect(getBashBgJob(bgId)?.ownerSessionId).toBe("child-session");
	});

	it("kills only running jobs owned by the disposed session", () => {
		const childJob = spawnBashBackground("sleep 30", process.cwd(), undefined, undefined, "child-session");
		const rootJob = spawnBashBackground("sleep 30", process.cwd(), undefined, undefined, "root-session");

		killBashBgJobsForSession("child-session");

		expect(childJob).toMatchObject({ ownerSessionId: "child-session", status: "killed" });
		expect(rootJob).toMatchObject({ ownerSessionId: "root-session", status: "running" });
		expect(listBashBgJobs()).toEqual(expect.arrayContaining([childJob, rootJob]));
	});

	it("does not emit a terminal wake for a deliberate session reap", async () => {
		const listener = vi.fn();
		const unsubscribe = subscribeBashBgTerminal(listener);
		const job = spawnBashBackground("sleep 30", process.cwd(), undefined, undefined, "child-session");

		try {
			killBashBgJobsForSession("child-session");
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(job.status).toBe("killed");
			expect(listener).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
		}
	});
});
