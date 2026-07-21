import { fauxAssistantMessage, type Tool } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../../../src/core/agents/executor.ts";
import {
	clearAgentRecentRunsForTests,
	resumeAgentRecentRun,
	waitForAgentRecentRun,
} from "../../../src/core/agents/status.ts";
import { createPromptCacheAffinityKey } from "../../../src/core/cache-affinity.ts";
import { addFilter, removeFilter } from "../../../src/core/extensions/extension-hooks.ts";
import { createHarness, type Harness } from "../harness.ts";

const ROUTING_FILTER_ID = "child-run-preparation-parity-277";

describe("agent tool suite: child-run preparation parity (#277)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		removeFilter("model:resolve", ROUTING_FILTER_ID);
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		clearAgentRecentRunsForTests();
	});

	it("preserves the child execution contract on persistent resume", async () => {
		const harness = await createHarness({
			provider: "anthropic",
			models: [
				{ id: "parent-model", name: "Parent", reasoning: true, maxTokens: 8_000 },
				{ id: "pinned-cheap-model", name: "Pinned", reasoning: true, maxTokens: 8_000 },
			],
			settings: {
				subagents: {
					providers: { anthropic: { model: "anthropic/pinned-cheap-model", thinking: "low" } },
				},
			},
		});
		harnesses.push(harness);

		const seenModels: Array<{ id: string; maxTokens: number }> = [];
		const seenThinking: string[] = [];
		const seenMaxTurns: Array<number | undefined> = [];
		const seenTools: string[][] = [];
		const seenSystemPrompts: string[] = [];
		const respond = (
			_context: unknown,
			_options: unknown,
			_state: unknown,
			model: { id: string; maxTokens: number },
		) => {
			seenModels.push({ id: model.id, maxTokens: model.maxTokens });
			return fauxAssistantMessage("turn complete");
		};
		harness.setResponses([respond]);

		const initial = await executeAgentTool(
			{
				mode: "single",
				background: true,
				persistent: true,
				tasks: [
					{
						agent: "general",
						task: "Keep the same execution contract across turns",
						context: "fork",
						maxOutputTokens: 1_200,
						maxTurns: 3,
					},
				],
			},
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: ["read", "bash", "edit", "write", "agent"],
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel("parent-model"),
				parentThinkingLevel: "high",
				parentSystemPrompt: "PARENT PROMPT",
				onChildSessionStart: (session) => {
					seenThinking.push(session.thinkingLevel);
					seenMaxTurns.push(session.agent.maxTurns);
					seenTools.push(session.getActiveToolNames());
					seenSystemPrompts.push(session.systemPrompt);
				},
			},
		);

		expect(initial.runId).toBeTruthy();
		await waitForAgentRecentRun(initial.runId!);

		harness.appendResponses([respond]);
		expect((await resumeAgentRecentRun(initial.runId!, "Continue with the same contract")).ok).toBe(true);
		await waitForAgentRecentRun(initial.runId!);

		expect(seenModels).toEqual([
			{ id: "parent-model", maxTokens: 1_200 },
			{ id: "parent-model", maxTokens: 1_200 },
		]);
		expect(seenThinking).toEqual(["high", "high"]);
		expect(seenMaxTurns).toEqual([3, 3]);
		expect(seenTools[1]).toEqual(seenTools[0]);
		expect(seenSystemPrompts).toEqual(["PARENT PROMPT", "PARENT PROMPT"]);
	});

	it("does not reuse a parent cache lane for explicit fork model, system, or tool overrides on initial or resumed turns", async () => {
		const harness = await createHarness({
			provider: "anthropic",
			models: [
				{ id: "parent-model", name: "Parent", reasoning: true },
				{ id: "child-model", name: "Child", reasoning: true },
			],
		});
		harnesses.push(harness);
		const parentProviderTools: Tool[] = ["read", "bash", "edit", "write", "agent"].map((name) => ({
			name,
			description: `Parent ${name} schema`,
			parameters: { type: "object", properties: {} },
		}));
		const parentCacheAffinityKey = createPromptCacheAffinityKey(harness.getModel("parent-model"), {
			systemPrompt: "PARENT PROMPT",
			tools: parentProviderTools,
		});
		const overrides = [
			{ label: "model", model: "anthropic/child-model" },
			{ label: "system", systemPrompt: "CHILD PROMPT" },
			{ label: "tools", tools: ["read"] },
		] as const;

		for (const override of overrides) {
			const observedAffinityKeys: Array<string | undefined> = [];
			harness.setResponses([fauxAssistantMessage(`${override.label} initial`)]);
			const initial = await executeAgentTool(
				{
					mode: "single",
					background: true,
					persistent: true,
					tasks: [{ agent: "general", task: `override ${override.label}`, context: "fork", ...override }],
				},
				{
					parentServices: {
						cwd: harness.tempDir,
						agentDir: harness.tempDir,
						authStorage: harness.authStorage,
						settingsManager: harness.settingsManager,
						modelRegistry: harness.session.modelRegistry,
					},
					parentActiveTools: parentProviderTools.map((tool) => tool.name),
					parentProviderTools,
					parentCacheAffinityKey,
					parentSessionManager: harness.sessionManager,
					parentModel: harness.getModel("parent-model"),
					parentThinkingLevel: "off",
					parentSystemPrompt: "PARENT PROMPT",
					onChildSessionStart: (session) => observedAffinityKeys.push(session.getPromptCacheAffinityKey()),
				},
			);

			await waitForAgentRecentRun(initial.runId!);
			harness.appendResponses([fauxAssistantMessage(`${override.label} resumed`)]);
			expect((await resumeAgentRecentRun(initial.runId!, "continue")).ok).toBe(true);
			await waitForAgentRecentRun(initial.runId!);

			expect(observedAffinityKeys).toHaveLength(2);
			for (const affinityKey of observedAffinityKeys) {
				expect(affinityKey).not.toBe(parentCacheAffinityKey);
			}
		}
	});

	it("honors an empty General system override on initial and resumed turns", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const parentProviderTools = harness.session.getActiveToolProviderSchemas();
		const parentCacheAffinityKey = createPromptCacheAffinityKey(harness.getModel(), {
			systemPrompt: "PARENT PROMPT",
			tools: parentProviderTools,
		});
		const seenSystemPrompts: string[] = [];
		const observedAffinityKeys: Array<string | undefined> = [];
		harness.setResponses([
			(context) => {
				seenSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("initial complete");
			},
		]);

		const initial = await executeAgentTool(
			{
				mode: "single",
				background: true,
				persistent: true,
				tasks: [{ agent: "general", task: "Use no base prompt", systemPrompt: "" }],
			},
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: harness.session.getActiveToolNames(),
				parentProviderTools,
				parentCacheAffinityKey,
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel(),
				parentThinkingLevel: "off",
				parentSystemPrompt: "PARENT PROMPT",
				onChildSessionStart: (session) => observedAffinityKeys.push(session.getPromptCacheAffinityKey()),
			},
		);

		await waitForAgentRecentRun(initial.runId!);
		harness.appendResponses([
			(context) => {
				seenSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("resumed complete");
			},
		]);
		expect((await resumeAgentRecentRun(initial.runId!, "continue")).ok).toBe(true);
		await waitForAgentRecentRun(initial.runId!);

		expect(seenSystemPrompts).toEqual(["", ""]);
		expect(observedAffinityKeys).toHaveLength(2);
		for (const affinityKey of observedAffinityKeys) {
			expect(affinityKey).not.toBe(parentCacheAffinityKey);
		}
	});

	it("preserves the initial semantic auto route on persistent resume", async () => {
		const harness = await createHarness({
			models: [
				{ id: "parent-model", name: "Parent", reasoning: true, maxTokens: 8_000 },
				{ id: "routed-child", name: "Routed Child", reasoning: true, maxTokens: 8_000 },
			],
		});
		harnesses.push(harness);

		const provider = harness.getModel().provider;
		const seenRequests: Array<{ requestedModel: string; promptPreview: string }> = [];
		const seenSessions: Array<{ model: string; maxTokens: number; thinking: string }> = [];
		addFilter<any>("model:resolve", ROUTING_FILTER_ID, (value, context) => {
			const routing = value.metadata?.routing as Record<string, unknown>;
			const resolveContext = context as { modelRegistry: { find(provider: string, modelId: string): unknown } };
			seenRequests.push({
				requestedModel: value.requestedModel,
				promptPreview: String(routing.promptPreview ?? ""),
			});
			return {
				...value,
				model: resolveContext.modelRegistry.find(provider, "routed-child"),
				thinkingLevel: "medium",
			};
		});
		harness.setResponses([fauxAssistantMessage("initial route complete")]);

		const initial = await executeAgentTool(
			{
				mode: "single",
				background: true,
				persistent: true,
				tasks: [
					{
						agent: "general",
						task: "Route this persistent task consistently",
						model: "auto",
						maxOutputTokens: 1_200,
					},
				],
			},
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: ["read", "bash", "edit", "write", "agent"],
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel("parent-model"),
				parentThinkingLevel: "high",
				onChildSessionStart: (session) => {
					seenSessions.push({
						model: session.model?.id ?? "missing",
						maxTokens: session.model?.maxTokens ?? 0,
						thinking: session.thinkingLevel,
					});
				},
			},
		);

		expect(initial.runId).toBeTruthy();
		await waitForAgentRecentRun(initial.runId!);

		harness.appendResponses([fauxAssistantMessage("resume route complete")]);
		expect((await resumeAgentRecentRun(initial.runId!, "Continue with the same route")).ok).toBe(true);
		await waitForAgentRecentRun(initial.runId!);

		expect(seenRequests).toEqual([
			{ requestedModel: "clawrouter/auto", promptPreview: "Route this persistent task consistently" },
		]);
		expect(seenSessions).toEqual([
			{ model: "routed-child", maxTokens: 1_200, thinking: "medium" },
			{ model: "routed-child", maxTokens: 1_200, thinking: "medium" },
		]);
	});
});
