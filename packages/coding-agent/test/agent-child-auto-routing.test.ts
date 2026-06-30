import { fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../src/core/agents/executor.ts";
import { addFilter, removeFilter } from "../src/core/extensions/extension-hooks.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const FILTER_ID = "agent-child-auto-routing-test";

describe("agent child auto model routing", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		removeFilter("model:resolve", FILTER_ID);
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createRoutingHarness(): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "parent-model", name: "Parent", reasoning: true },
				{ id: "cheap-child", name: "Cheap Child", reasoning: true },
				{ id: "medium-child", name: "Medium Child", reasoning: true },
				{ id: "frontier-child", name: "Frontier Child", reasoning: true },
			],
		});
		harnesses.push(harness);
		return harness;
	}

	it("passes child prompt and agent metadata to model:resolve at child session creation", async () => {
		const harness = await createRoutingHarness();
		const provider = harness.getModel().provider;
		const seen: Array<{ requestedModel: string; routing: Record<string, unknown> }> = [];

		addFilter<any>("model:resolve", FILTER_ID, (value, context) => {
			const routing = value.metadata?.routing as Record<string, unknown>;
			seen.push({ requestedModel: value.requestedModel, routing });
			const prompt = String(routing.promptPreview ?? "").toLowerCase();
			const target = prompt.includes("ok only")
				? "cheap-child"
				: prompt.includes("implement")
					? "medium-child"
					: "frontier-child";
			return {
				...value,
				model: context.modelRegistry.find(provider, target),
				thinkingLevel: target === "cheap-child" ? "low" : target === "medium-child" ? "medium" : "high",
				metadata: { ...(value.metadata ?? {}), route: value.requestedModel, reason: [`target:${target}`] },
			};
		});

		harness.setResponses([
			fauxAssistantMessage("cheap done"),
			fauxAssistantMessage("medium done"),
			fauxAssistantMessage("frontier done"),
		]);

		const baseOptions = {
			parentServices: {
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				authStorage: harness.authStorage,
				settingsManager: harness.settingsManager,
				modelRegistry: harness.session.modelRegistry,
			},
			parentActiveTools: ["read", "grep", "bash", "edit", "write"],
			parentSessionManager: harness.sessionManager,
			parentModel: harness.getModel("parent-model"),
			parentThinkingLevel: "medium" as const,
		};

		const cheap = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "explore", task: "Reply with OK only.", model: "auto" }] },
			baseOptions,
		);
		const medium = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "worker", task: "Implement the fix and add tests.", model: "auto" }] },
			baseOptions,
		);
		const frontier = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "plan", task: "Design the architecture.", model: "auto" }] },
			baseOptions,
		);

		expect(cheap.runs[0]?.model?.id).toBe("cheap-child");
		expect(cheap.runs[0]?.thinking).toBe("low");
		expect(medium.runs[0]?.model?.id).toBe("medium-child");
		expect(medium.runs[0]?.thinking).toBe("medium");
		expect(frontier.runs[0]?.model?.id).toBe("frontier-child");
		expect(frontier.runs[0]?.thinking).toBe("high");

		expect(seen).toHaveLength(3);
		expect(seen.map((entry) => entry.requestedModel)).toEqual(["auto", "auto", "auto"]);
		expect(seen[0]?.routing).toMatchObject({ source: "child-agent", agentId: "explore", contextMode: "none" });
		expect(seen[0]?.routing.promptPreview).toContain("Reply with OK only.");
		expect(seen[1]?.routing).toMatchObject({ source: "child-agent", agentId: "worker" });
		expect(seen[1]?.routing.promptPreview).toContain("Implement the fix");
		expect(seen[2]?.routing).toMatchObject({ source: "child-agent", agentId: "plan" });
		expect(seen[2]?.routing.promptPreview).toContain("Design the architecture");
	});

	it("does not call model:resolve for concrete child model ids", async () => {
		const harness = await createRoutingHarness();
		let called = false;
		addFilter<any>("model:resolve", FILTER_ID, (value) => {
			called = true;
			return value;
		});
		harness.setResponses([fauxAssistantMessage("concrete done")]);

		const result = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "worker", task: "Implement normally.", model: "medium-child" }] },
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: ["read", "grep", "bash", "edit", "write"],
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel("parent-model"),
				parentThinkingLevel: "medium",
			},
		);

		expect(called).toBe(false);
		expect(result.runs[0]?.model?.id).toBe("medium-child");
	});
});
