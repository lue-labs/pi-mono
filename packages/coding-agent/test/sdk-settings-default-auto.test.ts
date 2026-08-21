import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@lue-labs/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const sparkModel = {
	provider: "openai-codex",
	id: "gpt-5.3-codex-spark",
	name: "Spark",
	api: "openai-responses",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 32000,
	reasoning: true,
} as unknown as Model<any>;

const codexModel = {
	...sparkModel,
	id: "gpt-5.5",
	name: "GPT-5.5",
	contextWindow: 272000,
} as unknown as Model<any>;

const bridgeModel = {
	...sparkModel,
	provider: "clawrouter",
	id: "claude-opus-4-8-200k",
	name: "Opus 4.8",
	api: "anthropic-messages",
} as unknown as Model<any>;

function fakeModelRuntime(): ModelRuntime {
	const models = [sparkModel, codexModel, bridgeModel];
	return {
		getModel(provider: string, id: string) {
			return models.find((model) => model.provider === provider && model.id === id);
		},
		getAvailableSnapshot() {
			return [sparkModel, codexModel, bridgeModel];
		},
		hasConfiguredAuth() {
			return true;
		},
	} as unknown as ModelRuntime;
}

describe("settings-default auto routing", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	function createTempDir(): string {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-settings-auto-"));
		return tempDir;
	}

	it("preserves settings default openai-codex/auto as a deferred pending auto request", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd,
			agentDir: cwd,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "openai-codex",
				defaultModel: "auto",
				defaultThinkingLevel: "high",
			}),
			modelRuntime: fakeModelRuntime(),
			noTools: "all",
		});

		expect(result.session.pendingAutoModelAlias).toBe("openai-codex/auto");
		expect(result.session.model?.provider).toBe("openai-codex");
		expect(sessionManager.buildSessionContext().model).toBeNull();
	});

	it("keeps concrete settings defaults unchanged", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd,
			agentDir: cwd,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "clawrouter",
				defaultModel: "claude-opus-4-8-200k",
			}),
			modelRuntime: fakeModelRuntime(),
			noTools: "all",
		});

		expect(result.session.pendingAutoModelAlias).toBeUndefined();
		expect(result.session.model?.provider).toBe("clawrouter");
		expect(result.session.model?.id).toBe("claude-opus-4-8-200k");
		expect(sessionManager.buildSessionContext().model).toEqual({
			provider: "clawrouter",
			modelId: "claude-opus-4-8-200k",
		});
	});

	it("does not override an explicit model option", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd,
			agentDir: cwd,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "openai-codex",
				defaultModel: "auto",
			}),
			modelRuntime: fakeModelRuntime(),
			model: bridgeModel,
			noTools: "all",
		});

		expect(result.session.pendingAutoModelAlias).toBeUndefined();
		expect(result.session.model?.provider).toBe("clawrouter");
		expect(sessionManager.buildSessionContext().model).toEqual({
			provider: "clawrouter",
			modelId: "claude-opus-4-8-200k",
		});
	});

	it("does not fire when restoring an existing session", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] } as never);
		sessionManager.appendModelChange("openai-codex", "gpt-5.3-codex-spark");
		const result = await createAgentSession({
			cwd,
			agentDir: cwd,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "openai-codex",
				defaultModel: "auto",
			}),
			modelRuntime: fakeModelRuntime(),
			noTools: "all",
		});

		expect(result.session.pendingAutoModelAlias).toBeUndefined();
		expect(result.session.model?.id).toBe("gpt-5.3-codex-spark");
	});

	it("does not fire when scoped models are provided", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd,
			agentDir: cwd,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "openai-codex",
				defaultModel: "auto",
			}),
			modelRuntime: fakeModelRuntime(),
			scopedModels: [{ model: bridgeModel }],
			noTools: "all",
		});

		expect(result.session.pendingAutoModelAlias).toBeUndefined();
	});

	it("canonicalizes a legacy explicit requested auto alias", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd,
			agentDir: cwd,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "openai-codex",
				defaultModel: "auto",
			}),
			modelRuntime: fakeModelRuntime(),
			requestedModel: "pi-fork/auto",
			deferRequestedModelResolution: true,
			noTools: "all",
		});

		expect(result.session.pendingAutoModelAlias).toBe("clawrouter/auto");
		expect(sessionManager.buildSessionContext().model).toBeNull();
	});
});
