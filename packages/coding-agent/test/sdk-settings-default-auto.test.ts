import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
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

function fakeModelRegistry(): ModelRegistry {
	const models = [sparkModel, codexModel, bridgeModel];
	return {
		find(provider: string, id: string) {
			return models.find((model) => model.provider === provider && model.id === id);
		},
		getAvailable() {
			return [sparkModel, codexModel, bridgeModel];
		},
		hasConfiguredAuth() {
			return true;
		},
	} as unknown as ModelRegistry;
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
			modelRegistry: fakeModelRegistry(),
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
			modelRegistry: fakeModelRegistry(),
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
			modelRegistry: fakeModelRegistry(),
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
			modelRegistry: fakeModelRegistry(),
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
			modelRegistry: fakeModelRegistry(),
			scopedModels: [{ model: bridgeModel }],
			noTools: "all",
		});

		expect(result.session.pendingAutoModelAlias).toBeUndefined();
	});

	it("does not override an explicit requested auto alias", async () => {
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
			modelRegistry: fakeModelRegistry(),
			requestedModel: "pi-fork/auto",
			deferRequestedModelResolution: true,
			noTools: "all",
		});

		expect(result.session.pendingAutoModelAlias).toBe("pi-fork/auto");
		expect(sessionManager.buildSessionContext().model).toBeNull();
	});
});
