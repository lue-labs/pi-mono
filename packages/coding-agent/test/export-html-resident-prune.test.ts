import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-export-resident-prune-"));
	tempDirs.push(dir);
	return dir;
}

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function exportedSessionData(outputPath: string): string {
	const html = readFileSync(outputPath, "utf8");
	const base64 = html.match(/<script id="session-data" type="application\/json">([^<]+)/)?.[1];
	if (!base64) throw new Error("Expected exported session data");
	return Buffer.from(base64, "base64").toString("utf8");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("HTML export after resident pruning", () => {
	it("recovers the complete durable transcript instead of resident placeholders", async () => {
		const dir = makeTempDir();
		const session = SessionManager.create(dir, dir);
		const fullText = `full export payload ${"x".repeat(32_000)}`;
		session.appendMessage({ role: "user", content: fullText, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			api: "synthetic",
			provider: "synthetic",
			model: "synthetic",
			usage: usage(),
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
		const compactionId = session.appendCompaction("summary", firstKeptEntryId, 100_000);
		session.pruneResidentHistoryAfterCompaction(compactionId);

		const outputPath = join(dir, "session.html");
		await exportSessionToHtml(session, undefined, { outputPath });
		const data = exportedSessionData(outputPath);

		expect(data).toContain(fullText);
		expect(data).not.toContain("Resident session payload pruned");
	});
});
