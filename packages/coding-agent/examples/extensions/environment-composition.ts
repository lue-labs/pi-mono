import type { ExtensionAPI } from "@lue-labs/pi-coding-agent";
import { Type } from "typebox";

/**
 * Environment profile example.
 *
 * Eager profiles run before Pi fires the built-in `load` actions, so they can
 * remove or replace native behavior before tools are frozen into the prompt.
 * Mark this extension as eager in a package manifest; deferred profiles are too
 * late for startup tool composition.
 */
export default function openclawProfile(pi: ExtensionAPI) {
	// Keep the core harness, but skip MacBook-only convenience tools in this runtime.
	pi.hooks.removeAction("load", "deferredTools");
	pi.hooks.removeAction("load", "bashBgJobs");

	// Replace the native agent tools with an environment-specific adapter.
	pi.hooks.removeAction("load", "agents");
	pi.hooks.addAction("load", "openclawAgents", (pi) => {
		pi.registerTool({
			name: "openclaw_agent",
			label: "OpenClaw Agent",
			description: "Delegate work to the OpenClaw runtime.",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text", text: "OpenClaw delegation would run here." }],
				};
			},
		});
	});

	pi.hooks.addFilter<string>("systemPrompt:build", "openclawPromptPolicy", (prompt) => {
		return `${prompt}\n\nOpenClaw runtime policy: keep tool use portable and cache-stable.`;
	});

	pi.hooks.addFilter("provider:beforeRequest", "openclawProviderPolicy", (payload) => {
		if (!payload || typeof payload !== "object") return payload;
		return { ...payload, metadata: { runtime: "openclaw" } };
	});
}
