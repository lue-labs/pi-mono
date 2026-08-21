import { fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// Regression for #178: a concurrency window in _resolvePendingAutoModelForPrompt
// let two overlapping prompt resolutions both observe the same pending auto-model
// request and both resolve it, emitting duplicate model-select / routing warnings.
// The single-flight guard must ensure exactly one resolution runs per pending request.
describe("regression #178: concurrent auto-model resolution dedupe", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("resolves a pending auto-model exactly once under overlapping resolves", async () => {
		let releaseFilter: () => void = () => {};
		const filterGate = new Promise<void>((resolve) => {
			releaseFilter = resolve;
		});
		let filterCalls = 0;

		const harness = await createHarness({
			models: [{ id: "faux-1", name: "One", reasoning: true }],
			extensionFactories: [
				(pi) => {
					pi.hooks.addFilter<any>("model:resolve", "test.slow-route", async (value) => {
						filterCalls += 1;
						// Hold inside the awaited filter so a second resolve can race the window.
						await filterGate;
						return {
							...value,
							model: value.model,
							thinkingLevel: value.thinkingLevel,
							metadata: {
								...(value.metadata ?? {}),
								tier: "medium",
								llmRouterDecision: {
									route: value.requestedModel,
									provider: value.model?.provider,
									modelId: value.model?.id,
									tier: "medium",
									thinkingLevel: value.thinkingLevel,
									reason: ["test"],
								},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		harness.session.setPendingAutoModelAlias("clawrouter/auto");

		// Two overlapping resolutions land in the post-busy-gate / pre-clear window.
		const resolve = (
			harness.session as unknown as {
				_resolvePendingAutoModelForPrompt(text: string): Promise<void>;
			}
		)._resolvePendingAutoModelForPrompt.bind(harness.session);
		const first = resolve("route me");
		const second = resolve("route me too");
		releaseFilter();
		await Promise.all([first, second]);

		expect(filterCalls).toBe(1);
		expect(harness.session.pendingAutoModelAlias).toBeUndefined();
		expect(harness.eventsOfType("model_changed")).toHaveLength(1);
	});
});
