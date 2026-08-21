import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BASH_TIMEOUT_ENV_VAR,
	createBashKillToolDefinition,
	createBashToolDefinition,
	DEFAULT_BASH_TIMEOUT_SECONDS,
	getBashBgJob,
	resolveBashDefaultTimeoutSeconds,
} from "../src/core/tools/bash.ts";

// A foreground bash call blocks the whole turn and cannot be interrupted, so the
// harness arms a default timeout whenever the model omits one. These tests pin the
// contract end to end with real spawns: the default applies when `timeout` is
// omitted, every explicit escape hatch outranks it, `run_in_background` stays
// unbounded, the whole process tree dies, and output captured before the kill
// survives in the error.

const ownerSessionId = "default-timeout-session";
type BashContext = NonNullable<Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[4]>;
const ctx = { sessionManager: { getSessionId: () => ownerSessionId } } as BashContext;
const text = (r: unknown): string => (r as { content?: { text?: string }[] })?.content?.[0]?.text ?? "";
const bgIdOf = (r: unknown): string => (r as { details?: { bgId?: string } })?.details?.bgId ?? "";
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("bash default foreground timeout", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe("resolution precedence", () => {
		it("falls back to the built-in default with no environment or configured value", () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, undefined);
			expect(resolveBashDefaultTimeoutSeconds()).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
			expect(DEFAULT_BASH_TIMEOUT_SECONDS).toBe(120);
		});

		it("uses a configured value over the built-in default", () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, undefined);
			expect(resolveBashDefaultTimeoutSeconds(45)).toBe(45);
		});

		it("lets the environment variable override a configured value", () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, "7");
			expect(resolveBashDefaultTimeoutSeconds(45)).toBe(7);
		});

		it("treats 0 from either source as disabling the default", () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, "0");
			expect(resolveBashDefaultTimeoutSeconds()).toBeUndefined();
			expect(resolveBashDefaultTimeoutSeconds(45)).toBeUndefined();

			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, undefined);
			expect(resolveBashDefaultTimeoutSeconds(0)).toBeUndefined();
		});

		it.each([["not-a-number"], ["-30"], [" "]])(
			"ignores the unusable environment value %p and falls through",
			(raw) => {
				vi.stubEnv(BASH_TIMEOUT_ENV_VAR, raw);
				expect(resolveBashDefaultTimeoutSeconds(45)).toBe(45);
				expect(resolveBashDefaultTimeoutSeconds()).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
			},
		);

		it("ignores an unusable configured value and falls through to the built-in default", () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, undefined);
			expect(resolveBashDefaultTimeoutSeconds(-1)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
			expect(resolveBashDefaultTimeoutSeconds(Number.NaN)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
		});
	});

	describe("enforcement when the model omits a timeout", () => {
		it("kills the command at the default and returns an actionable error", async () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, "1");
			const bash = createBashToolDefinition(process.cwd());

			await expect(
				bash.execute("t1", { command: "echo early-default; sleep 30" }, undefined, undefined, ctx),
			).rejects.toThrow(/timed out after \d+s .*foreground limit 1s/s);
		});

		it("preserves output captured before the timeout and names every way to raise the limit", async () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, "1");
			const bash = createBashToolDefinition(process.cwd());

			const error = await bash
				.execute("t1", { command: "echo early-default; sleep 30" }, undefined, undefined, ctx)
				.then(() => undefined)
				.catch((err: Error) => err);

			const message = error?.message ?? "";
			expect(message).toContain("early-default");
			expect(message).toContain("preserved above");
			expect(message).toMatch(/timeout:<seconds>/);
			expect(message).toContain("timeout:false");
			expect(message).toContain("run_in_background:true");
			expect(message).toContain("bashTimeoutSeconds");
			expect(message).toContain(BASH_TIMEOUT_ENV_VAR);
		});

		it("kills the whole process tree, not just the shell", async () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, "1");
			const bash = createBashToolDefinition(process.cwd());

			const error = await bash
				.execute("t1", { command: "sleep 300 & echo child_pid:$!; wait" }, undefined, undefined, ctx)
				.then(() => undefined)
				.catch((err: Error) => err);

			const childPid = Number(error?.message.match(/child_pid:(\d+)/)?.[1]);
			expect(Number.isInteger(childPid)).toBe(true);

			// The grandchild shares the detached shell's process group, so the timeout
			// kill must take it down with the shell rather than orphaning it.
			for (let attempt = 0; attempt < 50 && isAlive(childPid); attempt++) await delay(100);
			expect(isAlive(childPid)).toBe(false);
		});

		it("applies a configured default when no environment override is set", async () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, undefined);
			const bash = createBashToolDefinition(process.cwd(), { defaultTimeoutSeconds: 1 });

			await expect(
				bash.execute("t1", { command: "echo from-settings; sleep 30" }, undefined, undefined, ctx),
			).rejects.toThrow(/from-settings[\s\S]*timed out after \d+s/);
		});
	});

	describe("escape hatches outrank the default", () => {
		it("honours an explicit timeout larger than the default", async () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, "1");
			const bash = createBashToolDefinition(process.cwd());

			const result = await bash.execute(
				"t1",
				{ command: "sleep 2; echo explicit-wins", timeout: 20 },
				undefined,
				undefined,
				ctx,
			);
			expect(text(result)).toContain("explicit-wins");
		});

		it("honours timeout:false against a configured default", async () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, "1");
			const bash = createBashToolDefinition(process.cwd(), { defaultTimeoutSeconds: 1 });

			const result = await bash.execute(
				"t1",
				{ command: "sleep 2; echo no-limit", timeout: false },
				undefined,
				undefined,
				ctx,
			);
			expect(text(result)).toContain("no-limit");
		});

		it("treats a configured 0 as unbounded foreground execution", async () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, undefined);
			const bash = createBashToolDefinition(process.cwd(), { defaultTimeoutSeconds: 0 });

			const result = await bash.execute("t1", { command: "sleep 2; echo opted-out" }, undefined, undefined, ctx);
			expect(text(result)).toContain("opted-out");
		});

		it("still enforces an explicit timeout below the default", async () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, "600");
			const bash = createBashToolDefinition(process.cwd());

			await expect(
				bash.execute("t1", { command: "sleep 30", timeout: 1 }, undefined, undefined, ctx),
			).rejects.toThrow(/timed out after \d+s .*foreground limit 1s/s);
		});
	});

	describe("run_in_background stays unbounded", () => {
		it("runs past the default timeout to a clean exit", async () => {
			vi.stubEnv(BASH_TIMEOUT_ENV_VAR, "1");
			const bash = createBashToolDefinition(process.cwd());
			const kill = createBashKillToolDefinition();

			const result = await bash.execute(
				"t1",
				{ command: "sleep 3; echo bg-survived", run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			const bgId = bgIdOf(result);
			expect(bgId).toBeTruthy();

			try {
				let job = getBashBgJob(bgId);
				for (let attempt = 0; attempt < 100 && job?.status === "running"; attempt++) {
					await delay(100);
					job = getBashBgJob(bgId);
				}

				// A default-timeout kill would land at 1s with status "killed"; the
				// background lane must reach its own clean exit instead.
				expect(job?.status).toBe("exited");
				expect(job?.exitCode).toBe(0);
			} finally {
				await kill.execute("t2", { bgId }, undefined, undefined, ctx);
			}
		});
	});
});
