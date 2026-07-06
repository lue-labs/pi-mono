import { type Api, type Model, registerFauxProvider } from "@valkyriweb/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import { getBuiltinAgentDefinitions } from "../src/core/agents/definitions.ts";
import { resolveAgentDefaults, resolveAgentModel, resolveAgentThinking } from "../src/core/agents/executor.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const registrations: ReturnType<typeof registerFauxProvider>[] = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function createRegistry() {
	return createProviderRegistry("anthropic", [
		{ id: "parent-model", name: "Parent", reasoning: true },
		{ id: "child-model", name: "Child", reasoning: true },
		{ id: "plain-model", name: "Plain", reasoning: false },
		{ id: "provider-default-model", name: "Provider Default", reasoning: true },
		// matches the anthropic entry in fastModelPerProvider so the `"fast"`
		// alias has something to resolve to in this faux registry.
		{ id: "claude-haiku-4-5", name: "Haiku", reasoning: true },
	]);
}

function createStaticRegistry(provider: string, models: Array<{ id: string; name: string; reasoning: boolean }>) {
	const available: Model<Api>[] = models.map((model) => ({
		...model,
		api: "faux" as Api,
		provider,
		baseUrl: "http://localhost:0",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	}));
	return {
		registry: { getAvailable: () => available } as unknown as ModelRegistry,
		parent: available[0],
	};
}

function createProviderRegistry(provider: string, models: Array<{ id: string; name: string; reasoning: boolean }>) {
	const faux = registerFauxProvider({ provider, models });
	registrations.push(faux);
	const auth = AuthStorage.inMemory();
	auth.setRuntimeApiKey(provider, "faux-key");
	const registry = ModelRegistry.inMemory(auth);
	registry.registerProvider(provider, {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	return { registry, parent: registry.getAvailable().find((model) => model.id === models[0]?.id) };
}

describe("agent model and thinking selection", () => {
	test("task model overrides parent and definition", () => {
		const { registry, parent } = createRegistry();
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "parent-model" };
		const selected = resolveAgentModel({
			modelReference: "child-model",
			agent,
			parentModel: parent,
			modelRegistry: registry,
		});
		expect(selected?.id).toBe("child-model");
	});

	test("definition model applies when task/tool do not override", () => {
		const { registry, parent } = createRegistry();
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "child-model" };
		const selected = resolveAgentModel({ agent, parentModel: parent, modelRegistry: registry });
		expect(selected?.id).toBe("child-model");
	});

	test('"fast" alias resolves to the parent provider mapped fast model', () => {
		const { registry, parent } = createRegistry();
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "fast" };
		const selected = resolveAgentModel({ agent, parentModel: parent, modelRegistry: registry });
		expect(selected?.id).toBe("claude-haiku-4-5");
		expect(selected?.provider).toBe("anthropic");
	});

	test('"fast" alias resolves clawrouter explore workers to claude-haiku-4-5', () => {
		const faux = registerFauxProvider({
			provider: "clawrouter",
			models: [
				{ id: "claude-fable-5-200k", name: "Claude Fable", reasoning: true },
				{ id: "claude-haiku-4-5", name: "Claude Haiku", reasoning: true },
			],
		});
		registrations.push(faux);
		const auth = AuthStorage.inMemory();
		auth.setRuntimeApiKey("clawrouter", "faux-key");
		const registry = ModelRegistry.inMemory(auth);
		registry.registerProvider("clawrouter", {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});
		const parent = registry.getAvailable().find((m) => m.provider === "clawrouter" && m.id === "claude-fable-5-200k");
		const explore = getBuiltinAgentDefinitions().find((definition) => definition.id === "explore");
		if (!explore) throw new Error("expected builtin explore agent");
		const selected = resolveAgentModel({ agent: explore, parentModel: parent, modelRegistry: registry });
		expect(selected?.provider).toBe("clawrouter");
		expect(selected?.id).toBe("claude-haiku-4-5");
	});

	test('"fast" alias keeps clawrouter GPT parents on gpt-5.4-mini', () => {
		const { registry, parent } = createStaticRegistry("clawrouter", [
			{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
			{ id: "claude-haiku-4-5", name: "Claude Haiku", reasoning: true },
			{ id: "gpt-5.4-mini", name: "GPT 5.4 Mini", reasoning: true },
		]);
		const explore = getBuiltinAgentDefinitions().find((definition) => definition.id === "explore");
		if (!explore) throw new Error("expected builtin explore agent");
		const selected = resolveAgentModel({ agent: explore, parentModel: parent, modelRegistry: registry });
		expect(selected?.provider).toBe("clawrouter");
		expect(selected?.id).toBe("gpt-5.4-mini");
	});

	test('"fast" alias resolves openai-codex explore workers to gpt-5.4-mini', () => {
		const faux = registerFauxProvider({
			provider: "openai-codex",
			models: [
				{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
				{ id: "gpt-5.4-mini", name: "GPT 5.4 Mini", reasoning: true },
			],
		});
		registrations.push(faux);
		const auth = AuthStorage.inMemory();
		auth.setRuntimeApiKey("openai-codex", "faux-key");
		const registry = ModelRegistry.inMemory(auth);
		registry.registerProvider("openai-codex", {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});
		const parent = registry.getAvailable().find((m) => m.provider === "openai-codex" && m.id === "gpt-5.5");
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "fast" };
		const selected = resolveAgentModel({ agent, parentModel: parent, modelRegistry: registry });
		expect(selected?.provider).toBe("openai-codex");
		expect(selected?.id).toBe("gpt-5.4-mini");
	});

	test('"medium" alias resolves openai-codex workers to gpt-5.4', () => {
		const faux = registerFauxProvider({
			provider: "openai-codex",
			models: [
				{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
				{ id: "gpt-5.4", name: "GPT 5.4", reasoning: true },
			],
		});
		registrations.push(faux);
		const auth = AuthStorage.inMemory();
		auth.setRuntimeApiKey("openai-codex", "faux-key");
		const registry = ModelRegistry.inMemory(auth);
		registry.registerProvider("openai-codex", {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});
		const parent = registry.getAvailable().find((m) => m.provider === "openai-codex" && m.id === "gpt-5.5");
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "medium" };
		const selected = resolveAgentModel({ agent, parentModel: parent, modelRegistry: registry });
		expect(selected?.provider).toBe("openai-codex");
		expect(selected?.id).toBe("gpt-5.4");
	});

	test('"medium" alias keeps clawrouter GPT parents on gpt-5.4', () => {
		const { registry, parent } = createStaticRegistry("clawrouter", [
			{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
			{ id: "claude-sonnet-5", name: "Claude Sonnet", reasoning: true },
			{ id: "gpt-5.4", name: "GPT 5.4", reasoning: true },
		]);
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "medium" };
		const selected = resolveAgentModel({ agent, parentModel: parent, modelRegistry: registry });
		expect(selected?.provider).toBe("clawrouter");
		expect(selected?.id).toBe("gpt-5.4");
	});

	test('"medium" alias falls back to claude-sonnet-4-6 when sonnet-5 is unavailable', () => {
		const { registry, parent } = createStaticRegistry("clawrouter", [
			{ id: "claude-opus-4-8-200k", name: "Claude Opus", reasoning: true },
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true },
			{ id: "gpt-5.4", name: "GPT 5.4", reasoning: true },
		]);
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "medium" };
		const selected = resolveAgentModel({ agent, parentModel: parent, modelRegistry: registry });
		expect(selected?.provider).toBe("clawrouter");
		expect(selected?.id).toBe("claude-sonnet-4-6");
	});

	test('"frontier" alias keeps clawrouter GPT parents on gpt-5.5', () => {
		const { registry, parent } = createStaticRegistry("clawrouter", [
			{ id: "gpt-5.4", name: "GPT 5.4", reasoning: true },
			{ id: "claude-opus-4-8-200k", name: "Claude Opus", reasoning: true },
			{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
		]);
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "frontier" };
		const selected = resolveAgentModel({ agent, parentModel: parent, modelRegistry: registry });
		expect(selected?.provider).toBe("clawrouter");
		expect(selected?.id).toBe("gpt-5.5");
	});

	test('"frontier" alias keeps clawrouter Claude parents on claude-opus-4-8-200k', () => {
		const { registry, parent } = createStaticRegistry("clawrouter", [
			{ id: "claude-sonnet-5", name: "Claude Sonnet", reasoning: true },
			{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
			{ id: "claude-opus-4-8-200k", name: "Claude Opus 200k", reasoning: true },
		]);
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "frontier" };
		const selected = resolveAgentModel({ agent, parentModel: parent, modelRegistry: registry });
		expect(selected?.provider).toBe("clawrouter");
		expect(selected?.id).toBe("claude-opus-4-8-200k");
	});

	test('"ultra" alias uses fable now and GPT-5.6 for GPT parents when available', () => {
		const { registry: claudeRegistry, parent: claudeParent } = createStaticRegistry("clawrouter", [
			{ id: "claude-opus-4-8-200k", name: "Claude Opus", reasoning: true },
			{ id: "claude-fable-5-200k", name: "Claude Fable 200k", reasoning: true },
		]);
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "ultra" };
		const claudeSelected = resolveAgentModel({ agent, parentModel: claudeParent, modelRegistry: claudeRegistry });
		expect(claudeSelected?.provider).toBe("clawrouter");
		expect(claudeSelected?.id).toBe("claude-fable-5-200k");

		const { registry: gptRegistry, parent: gptParent } = createStaticRegistry("clawrouter", [
			{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
			{ id: "claude-fable-5-200k", name: "Claude Fable 200k", reasoning: true },
			{ id: "gpt-5.6", name: "GPT 5.6", reasoning: true },
		]);
		const gptSelected = resolveAgentModel({ agent, parentModel: gptParent, modelRegistry: gptRegistry });
		expect(gptSelected?.provider).toBe("clawrouter");
		expect(gptSelected?.id).toBe("gpt-5.6");
	});

	test("qualified tier aliases select from that provider", () => {
		const { registry, parent } = createStaticRegistry("clawrouter", [
			{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
			{ id: "claude-fable-5-200k", name: "Claude Fable 200k", reasoning: true },
			{ id: "gpt-5.6", name: "GPT 5.6", reasoning: true },
		]);
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "clawrouter/ultra" };
		const selected = resolveAgentModel({ agent, parentModel: parent, modelRegistry: registry });
		expect(selected?.provider).toBe("clawrouter");
		expect(selected?.id).toBe("gpt-5.6");
	});

	test('"medium" alias resolves clawrouter workers to claude-sonnet-5', () => {
		const faux = registerFauxProvider({
			provider: "clawrouter",
			models: [
				{ id: "claude-fable-5-200k", name: "Claude Fable", reasoning: true },
				{ id: "claude-sonnet-5", name: "Claude Sonnet", reasoning: true },
			],
		});
		registrations.push(faux);
		const auth = AuthStorage.inMemory();
		auth.setRuntimeApiKey("clawrouter", "faux-key");
		const registry = ModelRegistry.inMemory(auth);
		registry.registerProvider("clawrouter", {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});
		const parent = registry.getAvailable().find((m) => m.provider === "clawrouter" && m.id === "claude-fable-5-200k");
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "medium" };
		const selected = resolveAgentModel({ agent, parentModel: parent, modelRegistry: registry });
		expect(selected?.provider).toBe("clawrouter");
		expect(selected?.id).toBe("claude-sonnet-5");
	});

	test('"fast" alias falls back to parent when provider has no mapped fast model', () => {
		// Re-register faux under a provider name with no fastModelPerProvider entry.
		const faux = registerFauxProvider({
			provider: "opencode",
			models: [{ id: "parent-model", name: "Parent", reasoning: true }],
		});
		registrations.push(faux);
		const auth = AuthStorage.inMemory();
		auth.setRuntimeApiKey("opencode", "faux-key");
		const registry = ModelRegistry.inMemory(auth);
		registry.registerProvider("opencode", {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});
		const parent = registry.getAvailable().find((m) => m.id === "parent-model");
		const agent = { ...getBuiltinAgentDefinitions()[0], id: "explore", model: "fast" };
		const warnings: string[] = [];
		const selected = resolveAgentModel({
			agent,
			parentModel: parent,
			modelRegistry: registry,
			onWarning: (warning) => warnings.push(warning),
		});
		expect(selected?.id).toBe("parent-model");
		expect(warnings).toEqual([
			"Warning: explore running on parent model opencode/parent-model for fast alias — add a fast-tier mapping for this provider or pass an explicit cheap model",
		]);
	});

	test("invalid model errors", () => {
		const { registry, parent } = createRegistry();
		expect(() =>
			resolveAgentModel({
				modelReference: "missing-model",
				agent: getBuiltinAgentDefinitions()[0],
				parentModel: parent,
				modelRegistry: registry,
			}),
		).toThrow("Unknown or unavailable model");
	});

	test("thinking precedence clamps unsupported off to the lowest supported level", () => {
		const { registry } = createRegistry();
		const reasoningModel = registry.getAvailable().find((model) => model.id === "child-model");
		const plainModel = registry.getAvailable().find((model) => model.id === "plain-model");
		if (!reasoningModel) throw new Error("expected reasoning model");
		const noOffModel = { ...reasoningModel, thinkingLevelMap: { off: null } };
		const agent = { ...getBuiltinAgentDefinitions()[0], thinking: "low" as const };
		expect(
			resolveAgentThinking({ taskThinking: "high", agent, parentThinkingLevel: "minimal", model: reasoningModel }),
		).toBe("high");
		expect(resolveAgentThinking({ agent, parentThinkingLevel: "minimal", model: plainModel })).toBe("off");
		expect(
			resolveAgentThinking({ taskThinking: "off", agent, parentThinkingLevel: "minimal", model: noOffModel }),
		).toBe("minimal");
	});

	// Subagents precedence layer: settings.subagents.defaults / providers[parent.provider].
	test("settings.subagents defaults apply when task and definition both inherit", () => {
		const { registry, parent } = createRegistry();
		const selected = resolveAgentModel({
			agent: getBuiltinAgentDefinitions()[0],
			defaults: { model: "provider-default-model" },
			parentModel: parent,
			modelRegistry: registry,
		});
		expect(selected?.id).toBe("provider-default-model");
	});

	test("explicit task model overrides settings.subagents defaults", () => {
		const { registry, parent } = createRegistry();
		const selected = resolveAgentModel({
			modelReference: "child-model",
			agent: getBuiltinAgentDefinitions()[0],
			defaults: { model: "provider-default-model" },
			parentModel: parent,
			modelRegistry: registry,
		});
		expect(selected?.id).toBe("child-model");
	});

	test("agent frontmatter model overrides settings.subagents defaults", () => {
		const { registry, parent } = createRegistry();
		const agent = { ...getBuiltinAgentDefinitions()[0], model: "child-model" };
		const selected = resolveAgentModel({
			agent,
			defaults: { model: "provider-default-model" },
			parentModel: parent,
			modelRegistry: registry,
		});
		expect(selected?.id).toBe("child-model");
	});

	test("resolveAgentDefaults reads settings.subagents end-to-end (defaults + provider override)", () => {
		const { parent } = createRegistry();
		if (!parent) throw new Error("createRegistry must yield a parent model");
		const settings = SettingsManager.inMemory({
			subagents: {
				defaults: { model: "fallback-default", thinking: "low" },
				providers: {
					[parent.provider]: { model: "provider-default-model" },
				},
			},
		});
		const resolved = resolveAgentDefaults({ parentModel: parent, settingsManager: settings });
		// Provider override wins for model; defaults supply thinking.
		expect(resolved.model).toBe("provider-default-model");
		expect(resolved.thinking).toBe("low");
	});

	test("resolveAgentDefaults returns empty selection when no settings.subagents config", () => {
		const { parent } = createRegistry();
		const settings = SettingsManager.inMemory({});
		const resolved = resolveAgentDefaults({ parentModel: parent, settingsManager: settings });
		expect(resolved).toEqual({});
	});

	test("settings.subagents thinking default applies and can be overridden by task", () => {
		const { registry } = createRegistry();
		const model = registry.getAvailable().find((candidate) => candidate.id === "child-model");
		const agent = getBuiltinAgentDefinitions()[0];
		expect(
			resolveAgentThinking({ agent, defaults: { thinking: "high" }, parentThinkingLevel: "minimal", model }),
		).toBe("high");
		expect(
			resolveAgentThinking({
				taskThinking: "off",
				agent,
				defaults: { thinking: "high" },
				parentThinkingLevel: "minimal",
				model,
			}),
		).toBe("off");
	});
});
