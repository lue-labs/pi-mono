import type { Model } from "@valkyriweb/pi-ai";
import { describe, expect, it } from "vitest";
import type { Args } from "../src/cli/args.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { ScopedModel } from "../src/core/model-resolver.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSessionOptions } from "../src/main.ts";

const clawrouterModel = model("clawrouter", "claude-fable-5-200k");
const codexModel = model("openai-codex", "gpt-5.5");
const bridgeModel = model("claude-bridge", "claude-sonnet-5");

function model(provider: string, id: string): Model<any> {
	return {
		provider,
		id,
		name: `${provider}/${id}`,
		api: "openai-chat-completions",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32000,
		reasoning: true,
	} as unknown as Model<any>;
}

function settings(defaultProvider: string, defaultModel: string): SettingsManager {
	return {
		getDefaultProvider: () => defaultProvider,
		getDefaultModel: () => defaultModel,
	} as unknown as SettingsManager;
}

function registry(models: Model<any>[]): ModelRegistry {
	return {
		find(provider: string, id: string) {
			return models.find((candidate) => candidate.provider === provider && candidate.id === id);
		},
		getAll() {
			return models;
		},
		hasConfiguredAuth() {
			return true;
		},
	} as unknown as ModelRegistry;
}

function scoped(...models: Model<any>[]): ScopedModel[] {
	return models.map((scopedModel) => ({ model: scopedModel }));
}

describe("buildSessionOptions settings-default auto", () => {
	it("preserves a scoped settings-default auto request instead of falling back to the first scoped model", () => {
		const result = buildSessionOptions(
			{} as Args,
			scoped(clawrouterModel, codexModel, bridgeModel),
			false,
			registry([clawrouterModel, codexModel, bridgeModel]),
			settings("openai-codex", "auto"),
		);

		expect(result.options.requestedModel).toBe("openai-codex/auto");
		expect(result.options.model).toBe(codexModel);
		expect(result.options.model).not.toBe(clawrouterModel);
	});

	it("seeds the auto placeholder from enabledModels scope, not the full registry", () => {
		const outOfScopeCodexModel = model("openai-codex", "gpt-5.3-codex-spark");
		const result = buildSessionOptions(
			{} as Args,
			// Scope only allows gpt-5.5; the registry lists an out-of-scope codex model first.
			scoped(clawrouterModel, codexModel),
			false,
			registry([outOfScopeCodexModel, clawrouterModel, codexModel]),
			settings("openai-codex", "auto"),
		);

		expect(result.options.requestedModel).toBe("openai-codex/auto");
		expect(result.options.model).toBe(codexModel);
		expect(result.options.model).not.toBe(outOfScopeCodexModel);
	});

	it("keeps concrete settings defaults scoped to their saved model", () => {
		const result = buildSessionOptions(
			{} as Args,
			scoped(clawrouterModel, codexModel, bridgeModel),
			false,
			registry([clawrouterModel, codexModel, bridgeModel]),
			settings("openai-codex", "gpt-5.5"),
		);

		expect(result.options.requestedModel).toBeUndefined();
		expect(result.options.model).toBe(codexModel);
	});

	it("leaves existing sessions on the restore path", () => {
		const result = buildSessionOptions(
			{} as Args,
			scoped(clawrouterModel, codexModel, bridgeModel),
			true,
			registry([clawrouterModel, codexModel, bridgeModel]),
			settings("openai-codex", "auto"),
		);

		expect(result.options.requestedModel).toBeUndefined();
		expect(result.options.model).toBeUndefined();
	});

	it("lets an explicit CLI model win over a settings-default auto request", () => {
		const result = buildSessionOptions(
			{ model: "gpt-5.5" } as Args,
			scoped(clawrouterModel, codexModel, bridgeModel),
			false,
			registry([clawrouterModel, codexModel, bridgeModel]),
			settings("openai-codex", "auto"),
		);

		expect(result.options.requestedModel).toBeUndefined();
		expect(result.options.model).toBe(codexModel);
	});
});
