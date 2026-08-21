/**
 * Deferred tools defer their guidelines (cache-stability seam).
 *
 * Schemas of deferLoading tools stay out of the cached prefix via provider
 * defer_loading; this suite pins the same rule for prompt prose:
 *   - system prompt NEVER contains promptSnippet/promptGuidelines of deferred
 *     tools (prefix stays byte-stable)
 *   - alwaysLoad opts back into ambient prose
 *
 * The tool_search discovery/guideline-delivery engine moved to the
 * pi-deferred-tools v2 extension (my-pi#1076); its unit tests moved with it.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { pickModel } from "./helpers/models.ts";

describe("system prompt excludes deferred-tool prose", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-deferred-guidelines-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("omits deferLoading tool guidelines/snippets but keeps alwaysLoad prose", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "deferred_desk",
							label: "Deferred Desk",
							description: "Standing desk control",
							deferLoading: true,
							promptSnippet: "Control the standing desk",
							promptGuidelines: ["Raise the desk slowly to avoid spills."],
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
						pi.registerTool({
							name: "ambient_lamp",
							label: "Ambient Lamp",
							description: "Lamp control",
							deferLoading: true,
							alwaysLoad: true,
							promptSnippet: "Control the lamp",
							promptGuidelines: ["Dim the lamp at night."],
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		await session.bindExtensions({});

		expect(session.getActiveToolNames()).toContain("deferred_desk");
		expect(session.systemPrompt).not.toContain("Control the standing desk");
		expect(session.systemPrompt).not.toContain("Raise the desk slowly to avoid spills.");
		expect(session.systemPrompt).toContain("Control the lamp");
		expect(session.systemPrompt).toContain("- Dim the lamp at night.");

		session.dispose();
	});
});
