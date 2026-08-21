import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@lue-labs/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../../../src/core/agents/executor.ts";
import { clearAgentRecentRunsForTests } from "../../../src/core/agents/status.ts";
import { createHarness, type Harness } from "../harness.ts";

function executeChild(harness: Harness) {
	return executeAgentTool(
		{ mode: "single", tasks: [{ agent: "general", task: "Summarize the repo" }] },
		{
			parentServices: {
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				authStorage: harness.authStorage,
				settingsManager: harness.settingsManager,
				modelRegistry: harness.session.modelRegistry,
			},
			parentActiveTools: ["read"],
			parentSessionManager: harness.sessionManager,
			parentModel: harness.getModel(),
			parentThinkingLevel: "off",
		},
	);
}

describe("my-pi#1210 child provider errors", () => {
	const harnesses: Harness[] = [];
	const extensionDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (extensionDirs.length > 0) rmSync(extensionDirs.pop()!, { recursive: true, force: true });
		clearAgentRecentRunsForTests();
	});

	it("reports a child run that stops on a provider error as failed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "400 Tool reference 'ctx_fetch_and_index' not found in available tools",
			}),
		]);

		const details = await executeChild(harness);

		expect(details.status).toBe("failed");
		expect(details.runs[0]?.status).toBe("failed");
		expect(details.runs[0]?.error).toContain("Tool reference 'ctx_fetch_and_index' not found");
	});

	it("reports a child overflow when recovery compaction is cancelled", async () => {
		const extensionDir = mkdtempSync(join(tmpdir(), "pi-1210-"));
		extensionDirs.push(extensionDir);
		const extensionPath = join(extensionDir, "cancel-compaction.js");
		writeFileSync(
			extensionPath,
			'module.exports = async (pi) => pi.on("session_before_compact", () => ({ cancel: true }));\n',
		);
		const harness = await createHarness({
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1 },
				extensions: [extensionPath],
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("context overflow", {
				stopReason: "error",
				errorMessage: "prompt is too long",
			}),
		]);

		const details = await executeChild(harness);

		expect(details.status).toBe("failed");
		expect(details.runs[0]?.error).toContain("prompt is too long");
	});

	it("keeps successful overflow recovery completed", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: true, keepRecentTokens: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("context overflow", {
				stopReason: "error",
				errorMessage: "prompt is too long",
			}),
			fauxAssistantMessage("compaction summary"),
			fauxAssistantMessage("child recovered"),
		]);

		const details = await executeChild(harness);

		expect(details.status).toBe("completed");
		expect(details.runs[0]?.finalOutput).toBe("child recovered");
	});
});
