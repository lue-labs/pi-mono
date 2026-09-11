/**
 * BuildInterface (LLM harness) Extension
 *
 * Production wiring of the generative-UI BuildInterface tool. The agent
 * calls BuildInterface with {intent, data, responseShape?}; the harness LLM
 * composes the actual UI from the catalog; the renderer mounts it; the
 * user's response is returned to the agent.
 *
 * Run:
 *   pi -e ./examples/extensions/build-interface-llm.ts
 *
 * Configuration:
 *   Pick a cheap, fast model (Haiku / Flash / Mistral-small) for the harness.
 *   This file uses the session's current model as a starting point, but for
 *   production swap to an explicit Oracle-routed cheap model (see proposal
 *   §4.3).
 *
 * See:
 *   - build-interface-demo.ts for a no-LLM demo
 *   - rusty/docs/prd/generative-ui-proposal.md
 */

import {
	createBuildInterfaceToolDefinition,
	createLLMHarness,
	createPiModelCaller,
	type ExtensionAPI,
} from "@lue-labs/pi-coding-agent";

export default function buildInterfaceLLMExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("BuildInterface (LLM): no model configured — tool not registered.", "warning");
			return;
		}

		// Wire: BuildInterface tool ← createLLMHarness ← createPiModelCaller ← model.
		// In production, replace `model` with an Oracle-routed cheap model
		// (the agent's main model is overkill for catalog composition).
		const harness = createLLMHarness({
			call: createPiModelCaller(model, {
				maxTokens: 2048,
				temperature: 0.2,
			}),
		});

		pi.registerTool(createBuildInterfaceToolDefinition({ harness, events: pi.events }));

		ctx.ui.notify(`BuildInterface (LLM) registered. Harness model: ${model.name}`, "info");
	});
}
