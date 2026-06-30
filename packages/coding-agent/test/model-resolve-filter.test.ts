import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addFilter, removeFilter } from "../src/core/extensions/extension-hooks.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const baseModel = {
	provider: "claude-bridge",
	id: "claude-opus-4-8",
	name: "Opus",
	api: "anthropic-messages",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
} as unknown as Model<any>;

const routedModel = {
	...baseModel,
	id: "claude-sonnet-4-6",
	name: "Sonnet",
} as unknown as Model<any>;

function fakeModelRegistry(): ModelRegistry {
	return {
		find(provider: string, id: string) {
			return provider === routedModel.provider && id === routedModel.id ? routedModel : undefined;
		},
		hasConfiguredAuth() {
			return true;
		},
	} as unknown as ModelRegistry;
}

describe("model:resolve startup filter", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		removeFilter("model:resolve", "test-model-resolve");
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("resolves a requested auto alias before the initial model is persisted", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-resolve-"));
		addFilter<any>("model:resolve", "test-model-resolve", (value) => ({
			...value,
			model: routedModel,
			thinkingLevel: "medium",
			metadata: { route: value.requestedModel, reason: ["test"] },
		}));

		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			modelRegistry: fakeModelRegistry(),
			model: baseModel,
			thinkingLevel: "high",
			requestedModel: "pi-fork/auto",
		});

		expect(result.session.model?.id).toBe("claude-sonnet-4-6");
		expect(result.session.thinkingLevel).toBe("medium");
		expect(sessionManager.buildSessionContext().model?.modelId).toBe("claude-sonnet-4-6");
		expect(result.modelFallbackMessage).toContain("Auto model pi-fork/auto selected claude-bridge/claude-sonnet-4-6");
	});

	it("defers an interactive auto alias until semantic prompt text exists", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-resolve-deferred-"));
		let called = false;
		addFilter<any>("model:resolve", "test-model-resolve", (value) => {
			called = true;
			return {
				...value,
				model: routedModel,
				thinkingLevel: "low",
				metadata: { route: value.requestedModel, tier: "cheap" },
			};
		});

		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			modelRegistry: fakeModelRegistry(),
			model: baseModel,
			thinkingLevel: "high",
			requestedModel: "openai-codex/auto",
			routingMetadata: { appMode: "interactive", promptPreview: "", promptLength: 0 },
			deferRequestedModelResolution: true,
		});

		expect(called).toBe(false);
		expect(result.session.pendingAutoModelAlias).toBe("openai-codex/auto");
		expect(result.session.model?.id).toBe("claude-opus-4-8");
		expect(sessionManager.buildSessionContext().model).toBeNull();

		await (result.session as any)._resolvePendingAutoModelForPrompt("Implement the router boundary tests");

		expect(called).toBe(true);
		expect(result.session.pendingAutoModelAlias).toBeUndefined();
		expect(result.session.model?.id).toBe("claude-sonnet-4-6");
		expect(result.session.thinkingLevel).toBe("low");
		expect(sessionManager.buildSessionContext().model?.modelId).toBe("claude-sonnet-4-6");
	});

	it("resolves a deferred auto alias before a triggerTurn custom message", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-resolve-trigger-turn-"));
		let seenRoutingMetadata: any;
		addFilter<any>("model:resolve", "test-model-resolve", (value) => {
			seenRoutingMetadata = value.metadata?.routing;
			return {
				...value,
				model: routedModel,
				thinkingLevel: "medium",
				metadata: { ...(value.metadata ?? {}), route: value.requestedModel, tier: "medium" },
			};
		});

		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			modelRegistry: fakeModelRegistry(),
			model: baseModel,
			thinkingLevel: "high",
			requestedModel: "openai-codex/auto",
			deferRequestedModelResolution: true,
		});
		const runSpy = vi.spyOn(result.session as any, "_runAgentPrompt").mockResolvedValue(undefined);

		await result.session.sendCustomMessage(
			{ customType: "goal", content: "Ship the goal", display: false },
			{ triggerTurn: true },
		);

		expect(seenRoutingMetadata?.promptPreview).toBe("Ship the goal");
		expect(result.session.pendingAutoModelAlias).toBeUndefined();
		expect(result.session.model?.id).toBe("claude-sonnet-4-6");
		expect(result.session.thinkingLevel).toBe("medium");
		expect(sessionManager.buildSessionContext().model?.modelId).toBe("claude-sonnet-4-6");
		expect(runSpy).toHaveBeenCalledOnce();
	});

	it("keeps the current model when deferred auto routing is unavailable", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-resolve-unavailable-"));
		addFilter<any>("model:resolve", "test-model-resolve", (value) => ({
			...value,
			metadata: {
				...(value.metadata ?? {}),
				llmRouterUnavailable: { message: "Auto model unavailable: semantic router is not running." },
			},
		}));

		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			modelRegistry: fakeModelRegistry(),
			model: baseModel,
			thinkingLevel: "high",
			requestedModel: "pi-fork/auto",
			deferRequestedModelResolution: true,
		});

		expect(result.session.pendingAutoModelAlias).toBe("pi-fork/auto");
		await (result.session as any)._resolvePendingAutoModelForPrompt("hello");

		expect(result.session.pendingAutoModelAlias).toBeUndefined();
		expect(result.session.model?.id).toBe("claude-opus-4-8");
		expect(sessionManager.buildSessionContext().model?.modelId).toBe("claude-opus-4-8");
	});

	it("passes initial routing metadata into the startup filter", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-resolve-metadata-"));
		let seenRoutingMetadata: unknown;
		addFilter<any>("model:resolve", "test-model-resolve", (value) => {
			seenRoutingMetadata = value.metadata?.routing;
			return {
				...value,
				model: routedModel,
				metadata: { ...(value.metadata ?? {}), route: value.requestedModel, reason: ["metadata-test"] },
			};
		});

		await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			modelRegistry: fakeModelRegistry(),
			model: baseModel,
			requestedModel: "auto",
			routingMetadata: { promptPreview: "Design an architecture", promptLength: 22, appMode: "print" },
		});

		expect(seenRoutingMetadata).toEqual({
			promptPreview: "Design an architecture",
			promptLength: 22,
			appMode: "print",
		});
	});

	it("does not reroute an existing session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-resolve-existing-"));
		let called = false;
		addFilter<any>("model:resolve", "test-model-resolve", (value) => {
			called = true;
			return { ...value, model: routedModel };
		});

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange(baseModel.provider, baseModel.id);
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			modelRegistry: fakeModelRegistry(),
			model: baseModel,
			requestedModel: "pi-fork/auto",
		});

		expect(called).toBe(false);
		expect(result.session.model?.id).toBe("claude-opus-4-8");
	});

	it("defers an explicit interactive auto alias on an existing session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-resolve-existing-deferred-"));
		let called = false;
		addFilter<any>("model:resolve", "test-model-resolve", (value) => {
			called = true;
			return {
				...value,
				model: routedModel,
				thinkingLevel: "medium",
				metadata: { route: value.requestedModel, reason: ["existing-deferred"] },
			};
		});

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange(baseModel.provider, baseModel.id);
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			modelRegistry: fakeModelRegistry(),
			model: baseModel,
			requestedModel: "openai-codex/auto",
			deferRequestedModelResolution: true,
		});

		expect(called).toBe(false);
		expect(result.session.pendingAutoModelAlias).toBe("openai-codex/auto");
		expect(result.session.model?.id).toBe("claude-opus-4-8");

		await (result.session as any)._resolvePendingAutoModelForPrompt("fix the codex auto route");

		expect(called).toBe(true);
		expect(result.session.pendingAutoModelAlias).toBeUndefined();
		expect(result.session.model?.id).toBe("claude-sonnet-4-6");
		expect(result.session.thinkingLevel).toBe("medium");
		expect(sessionManager.buildSessionContext().model?.modelId).toBe("claude-sonnet-4-6");
	});
});
