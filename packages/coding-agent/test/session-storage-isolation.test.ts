import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { resolvePath } from "../src/utils/paths.ts";
import { fixtureSessionDir } from "./helpers/session-storage.ts";
import { createTestSession } from "./utilities.ts";

function defaultSessionDirForCwd(cwd: string): string {
	const resolvedCwd = resolvePath(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(getAgentDir(), "sessions", safePath);
}

describe("test session storage isolation", () => {
	it("persists createTestSession output in the fixture and removes it on cleanup", async () => {
		const ctx = await createTestSession();
		const leakedDir = defaultSessionDirForCwd(ctx.tempDir);
		const fixtureDir = fixtureSessionDir(ctx.tempDir);

		try {
			expect(existsSync(leakedDir)).toBe(false);
			expect(existsSync(fixtureDir)).toBe(true);

			ctx.sessionManager.appendMessage({
				role: "user",
				content: "isolation-proof",
				timestamp: Date.now(),
			});
			ctx.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});

			const sessionDir = ctx.sessionManager.getSessionDir();
			const sessionFile = ctx.sessionManager.getSessionFile();
			expect(sessionDir).toBe(fixtureDir);
			expect(sessionFile).toBeTruthy();
			expect(sessionFile!.startsWith(`${sessionDir}/`)).toBe(true);
			expect(existsSync(sessionFile!)).toBe(true);
			expect(readdirSync(fixtureDir).length).toBeGreaterThan(0);
			expect(existsSync(leakedDir)).toBe(false);
		} finally {
			const fixtureRoot = ctx.tempDir;
			ctx.cleanup();
			expect(existsSync(fixtureRoot)).toBe(false);
			expect(existsSync(leakedDir)).toBe(false);
		}
	});
});
