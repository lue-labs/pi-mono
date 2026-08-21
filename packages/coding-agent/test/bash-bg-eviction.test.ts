import { describe, expect, it } from "vitest";
import { BASH_BG_MAX_TERMINAL, type BashBgJob, selectTerminalBashBgJobIdsToEvict } from "../src/core/tools/bash.ts";

function job(id: string, status: BashBgJob["status"], endedAt?: number): BashBgJob {
	return {
		id,
		command: "true",
		cwd: "/tmp",
		pid: 1,
		startedAt: endedAt ?? 0,
		status,
		exitCode: status === "exited" ? 0 : null,
		signal: null,
		logPath: `/tmp/${id}.log`,
		endedAt,
		error: undefined,
	};
}

describe("bash-bg terminal eviction policy", () => {
	it("evicts nothing when terminal count is at or below the cap", () => {
		const jobs = Array.from({ length: BASH_BG_MAX_TERMINAL }, (_, i) => job(`t${i}`, "exited", i + 1));
		expect(selectTerminalBashBgJobIdsToEvict(jobs)).toEqual([]);
	});

	it("evicts the oldest terminal jobs beyond the cap, keeping the most recent", () => {
		const jobs = Array.from({ length: BASH_BG_MAX_TERMINAL + 3 }, (_, i) => job(`t${i}`, "exited", i + 1));
		// endedAt ascending, so t0..t2 are the three oldest.
		expect(selectTerminalBashBgJobIdsToEvict(jobs)).toEqual(["t0", "t1", "t2"]);
	});

	it("never evicts running jobs even when they outnumber the cap", () => {
		const running = Array.from({ length: BASH_BG_MAX_TERMINAL + 5 }, (_, i) => job(`r${i}`, "running"));
		expect(selectTerminalBashBgJobIdsToEvict(running)).toEqual([]);
	});

	it("counts only terminal jobs toward the cap and evicts oldest terminal", () => {
		const jobs = [
			...Array.from({ length: BASH_BG_MAX_TERMINAL }, (_, i) => job(`t${i}`, "exited", i + 10)),
			...Array.from({ length: 10 }, (_, i) => job(`r${i}`, "running")),
			job("old", "killed", 1),
			job("old2", "failed", 2),
		];
		expect(selectTerminalBashBgJobIdsToEvict(jobs)).toEqual(["old", "old2"]);
	});

	it("respects a custom cap", () => {
		const jobs = [job("a", "exited", 1), job("b", "exited", 2), job("c", "exited", 3)];
		expect(selectTerminalBashBgJobIdsToEvict(jobs, 1)).toEqual(["a", "b"]);
	});
});
