import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { addFilter, removeFilter } from "../src/core/extensions/extension-hooks.ts";
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
			model: baseModel,
			thinkingLevel: "high",
			requestedModel: "clawrouter/auto",
		});

		expect(result.session.model?.id).toBe("claude-sonnet-4-6");
		expect(result.session.thinkingLevel).toBe("medium");
		expect(sessionManager.buildSessionContext().model?.modelId).toBe("claude-sonnet-4-6");
		expect(result.modelFallbackMessage).toContain(
			"Auto model clawrouter/auto selected claude-bridge/claude-sonnet-4-6",
		);
		expect(result.modelRoutingFailed).toBe(false);
	});

	it("keeps the startup fallback model when no router resolves an auto alias", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-resolve-startup-noop-"));
		addFilter<any>("model:resolve", "test-model-resolve", (value) => value);

		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			model: baseModel,
			thinkingLevel: "high",
			requestedModel: "clawrouter/auto",
		});

		expect(result.session.model?.id).toBe("claude-opus-4-8");
		expect(result.session.thinkingLevel).toBe("high");
		expect(sessionManager.buildSessionContext().model?.modelId).toBe("claude-opus-4-8");
		expect(result.modelFallbackMessage).toContain(
			"Auto model clawrouter/auto could not be routed (no routing decision); continuing with claude-bridge/claude-opus-4-8",
		);
		expect(result.modelRoutingFailed).toBe(true);
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
			model: baseModel,
			thinkingLevel: "high",
			requestedModel: "clawrouter/auto",
			deferRequestedModelResolution: true,
		});

		expect(result.session.pendingAutoModelAlias).toBe("clawrouter/auto");
		await (result.session as any)._resolvePendingAutoModelForPrompt("hello");

		expect(result.session.pendingAutoModelAlias).toBeUndefined();
		expect(result.session.model?.id).toBe("claude-opus-4-8");
		expect(sessionManager.buildSessionContext().model?.modelId).toBe("claude-opus-4-8");
	});

	it("clears a deferred auto alias and warns when no router resolves it", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-resolve-noop-"));
		addFilter<any>("model:resolve", "test-model-resolve", (value) => value);

		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			model: baseModel,
			thinkingLevel: "high",
			requestedModel: "clawrouter/auto",
			deferRequestedModelResolution: true,
		});

		expect(result.session.pendingAutoModelAlias).toBe("clawrouter/auto");
		await expect((result.session as any)._resolvePendingAutoModelForPrompt("hello")).resolves.toBeUndefined();

		expect(result.session.pendingAutoModelAlias).toBeUndefined();
		expect(result.session.model?.id).toBe("claude-opus-4-8");
		expect(result.session.thinkingLevel).toBe("high");
		expect(sessionManager.buildSessionContext().model).toBeNull();
		const warning = sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom_message" && entry.customType === "model-routing-warning");
		expect(warning).toMatchObject({
			content:
				"Auto model clawrouter/auto could not be routed (no routing decision); continuing with claude-bridge/claude-opus-4-8.",
			display: true,
		});
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
			model: baseModel,
			requestedModel: "clawrouter/auto",
		});

		expect(called).toBe(false);
		expect(result.session.model?.id).toBe("claude-opus-4-8");
	});
});
