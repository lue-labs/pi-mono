import { describe, expect, it } from "vitest";
import {
	createBashKillToolDefinition,
	createBashOutputToolDefinition,
	createBashToolDefinition,
	getBashBgJob,
	onBashTimeout,
} from "../src/core/tools/bash.ts";

// End-to-end coverage for the foreground-timeout disposition seam (onBashTimeout):
// real spawn, real 1s timeout, real background registry. The core default kills
// and reports a timeout; the detach-on-timeout policy is opt-in via onBashTimeout
// (Luke's native-tool-aliases extension installs it for the Bash tool).

const ownerSessionId = "timeout-session";
type BashContext = NonNullable<Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[4]>;
const ctx = { sessionManager: { getSessionId: () => ownerSessionId } } as BashContext;
const text = (r: any): string => r.content?.[0]?.text ?? "";
const bgIdOf = (r: any): string => text(r).match(/bgId="?([\w-]+)"?/)?.[1] ?? "";
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("bash foreground-timeout disposition seam", () => {
	it("core default: kills the timed-out process and reports a timeout (no detach)", async () => {
		const bash = createBashToolDefinition(process.cwd());
		await expect(
			bash.execute("t1", { command: "echo early; sleep 3; echo late", timeout: 1 }, undefined, undefined, ctx),
		).rejects.toThrow(/timed out after 1 seconds/);
	});

	it("an override can detach the live process into a background job that captures late output", async () => {
		const restore = onBashTimeout((t) => ({ backgroundedJobId: t.background().id }));
		const bash = createBashToolDefinition(process.cwd());
		const out = createBashOutputToolDefinition();
		const kill = createBashKillToolDefinition();
		try {
			const result = await bash.execute(
				"t1",
				{ command: "echo early; sleep 3; echo late", timeout: 1 },
				undefined,
				undefined,
				ctx,
			);
			expect(text(result)).toContain("detached into background job");
			const bgId = bgIdOf(result);
			expect(bgId).toBeTruthy();
			expect(getBashBgJob(bgId)?.ownerSessionId).toBe(ownerSessionId);

			let combined = "";
			for (let attempt = 0; attempt < 40 && !combined.includes("late"); attempt++) {
				await delay(200);
				combined += text(await out.execute("t2", { bgId }, undefined, undefined, ctx));
			}
			expect(combined).toContain("late");
			await kill.execute("t3", { bgId }, undefined, undefined, ctx);
		} finally {
			restore();
		}
	});

	it("an override receives the timeout context and can fail-fast by killing", async () => {
		const seen: { command: string; timeoutMs: number }[] = [];
		const restore = onBashTimeout((t) => {
			seen.push({ command: t.command, timeoutMs: t.timeoutMs });
			t.kill();
			return { failed: true };
		});
		const bash = createBashToolDefinition(process.cwd());
		try {
			await expect(
				bash.execute("t1", { command: "sleep 3", timeout: 1 }, undefined, undefined, ctx),
			).rejects.toThrow(/timed out after 1 seconds/);
			expect(seen).toHaveLength(1);
			expect(seen[0].command).toContain("sleep 3");
			expect(seen[0].timeoutMs).toBe(1000);
		} finally {
			restore();
		}

		// Default kill behaviour is restored after the override is removed.
		const bash2 = createBashToolDefinition(process.cwd());
		await expect(bash2.execute("t1", { command: "sleep 3", timeout: 1 }, undefined, undefined, ctx)).rejects.toThrow(
			/timed out after 1 seconds/,
		);
	});
});
