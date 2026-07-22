import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const childState = vi.hoisted(() => ({ child: undefined as ReturnType<typeof createChild> | undefined }));

function createChild() {
	const child = new EventEmitter() as EventEmitter & {
		pid: undefined;
		stdout: PassThrough;
		stderr: PassThrough;
		unref: () => void;
	};
	child.pid = undefined;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.unref = () => {};
	return child;
}

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => childState.child),
}));

import {
	killAllBashBgJobs,
	killBashBgJob,
	spawnBashBackground,
	subscribeBashBgJobs,
	subscribeBashBgTerminal,
} from "../src/core/tools/bash.ts";

afterEach(() => {
	killAllBashBgJobs();
	childState.child = undefined;
});

describe("background bash output stream failures", () => {
	it("publishes a deliberate kill before pending stream cleanup", () => {
		const child = createChild();
		childState.child = child;
		const changed = vi.fn();
		const terminal = vi.fn();
		const unsubscribeChanged = subscribeBashBgJobs(changed);
		const unsubscribeTerminal = subscribeBashBgTerminal(terminal);
		try {
			const job = spawnBashBackground("echo never-runs", process.cwd());
			changed.mockClear();

			killBashBgJob(job.id);

			expect(job).toMatchObject({ status: "killed", lifecycle: { terminalReason: "manual_kill" } });
			expect(job.endedAt).toBeDefined();
			expect(changed).toHaveBeenCalledExactlyOnceWith();
			expect(terminal).not.toHaveBeenCalled();

			child.stdout.emit("error", new Error("stdout disconnected"));
			child.emit("exit", 0, null);
			child.emit("close", 0, null);

			expect(job).toMatchObject({ status: "killed", lifecycle: { terminalReason: "manual_kill" } });
			expect(changed).toHaveBeenCalledExactlyOnceWith();
			expect(terminal).not.toHaveBeenCalled();
		} finally {
			unsubscribeChanged();
			unsubscribeTerminal();
		}
	});

	it("handles a pipe error without publishing until the child closes", () => {
		const child = createChild();
		childState.child = child;
		const terminal = vi.fn();
		const unsubscribe = subscribeBashBgTerminal(terminal);
		try {
			const job = spawnBashBackground("echo never-runs", process.cwd());

			child.stdout.emit("error", new Error("stdout disconnected"));
			child.emit("exit", 0, null);
			expect(job.status).toBe("running");
			expect(terminal).not.toHaveBeenCalled();

			child.emit("close", 0, null);
			expect(job.status).toBe("failed");
			expect(job.lifecycle?.terminalReason).toBe("stream_error");
			expect(job.error).toContain("stdout disconnected");
			expect(terminal).toHaveBeenCalledExactlyOnceWith(job);
		} finally {
			unsubscribe();
		}
	});
});
