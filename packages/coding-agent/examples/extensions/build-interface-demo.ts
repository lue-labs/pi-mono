/**
 * BuildInterface Demo Extension
 *
 * Demonstrates the generative-UI BuildInterface tool end-to-end *without*
 * needing an LLM-backed harness. Uses the deterministic
 * `exampleQuestionsHarness` so the entire chain (tool → harness → renderer →
 * response) runs from a single slash command.
 *
 * Run:
 *   pi -e ./examples/extensions/build-interface-demo.ts
 *
 * Then in the TUI:
 *   /build-interface-demo          # fires a single-question UI
 *   /build-interface-demo-multi    # fires a multi-tab questions UI
 *
 * For the LLM-backed (production) variant, see build-interface-llm.ts.
 *
 * See: rusty/docs/prd/generative-ui-proposal.md
 */

import {
	type BuildInterfaceInput,
	createBuildInterfaceToolDefinition,
	type ExtensionAPI,
	exampleQuestionsHarness,
	executeBuildInterface,
} from "@lue-labs/pi-coding-agent";

const SINGLE_QUESTION_INPUT: BuildInterfaceInput = {
	intent: "ask the user which retry strategy to use for the failing job",
	data: {
		questions: [
			{
				header: "Strategy",
				question: "Which retry strategy should we use?",
				multiSelect: false,
				options: [
					{
						label: "Exponential backoff (Recommended)",
						description: "Double the wait time on each retry, with jitter",
					},
					{
						label: "Fixed interval",
						description: "Retry every 5 seconds, up to 5 times",
					},
					{
						label: "No retry",
						description: "Fail fast on the first error",
					},
				],
			},
		],
	},
};

const MULTI_QUESTION_INPUT: BuildInterfaceInput = {
	intent: "clarify deployment target preferences from the user",
	data: {
		questions: [
			{
				header: "Lang",
				question: "Which language should the new service use?",
				multiSelect: false,
				options: [
					{ label: "TypeScript", description: "Node 22 runtime, fast iteration" },
					{ label: "Rust", description: "Native binary, lower memory overhead" },
				],
			},
			{
				header: "Targets",
				question: "Which platforms should we build for?",
				multiSelect: true,
				options: [
					{ label: "macOS", description: "Apple Silicon (arm64)" },
					{ label: "Linux", description: "x86_64 and arm64" },
					{ label: "Windows", description: "x86_64 only" },
				],
			},
		],
	},
};

export default function buildInterfaceDemoExtension(pi: ExtensionAPI) {
	// Register the tool itself so the agent can also call it. The harness here
	// is the deterministic test fixture; swap for `createLLMHarness(...)` once
	// a harness model is configured (see build-interface-llm.ts).
	pi.registerTool(createBuildInterfaceToolDefinition({ harness: exampleQuestionsHarness }));

	// Slash commands let you fire the tool's body directly without going
	// through an LLM round-trip — handy for trying the renderer interactively.
	pi.registerCommand("build-interface-demo", {
		description: "Demo the generative-UI BuildInterface tool with a single radio question.",
		handler: async (_args, ctx) => {
			try {
				const result = await executeBuildInterface(SINGLE_QUESTION_INPUT, exampleQuestionsHarness, ctx);
				ctx.ui.notify(`Response: ${result.content[0]?.text ?? "(no content)"}`, "info");
			} catch (err) {
				ctx.ui.notify(`Demo failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("build-interface-demo-multi", {
		description: "Demo BuildInterface with two tabbed questions (radio + checkbox).",
		handler: async (_args, ctx) => {
			try {
				const result = await executeBuildInterface(MULTI_QUESTION_INPUT, exampleQuestionsHarness, ctx);
				ctx.ui.notify(`Response: ${result.content[0]?.text ?? "(no content)"}`, "info");
			} catch (err) {
				ctx.ui.notify(`Demo failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify("BuildInterface demo loaded — try /build-interface-demo or /build-interface-demo-multi", "info");
	});
}
