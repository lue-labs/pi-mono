/**
 * BuildInterface — the generative-UI tool's public surface.
 *
 * See: rusty/docs/prd/generative-ui-proposal.md §4.2 / §4.3.
 *
 * The model calls **one** tool. It supplies:
 *   - `intent`: natural language — "ask the user N questions and give me
 *     their answers" / "show a 3-column table" / "confirm this destructive op"
 *   - `data`:   the structured payload (questions list, table rows, …)
 *   - `responseShape?`: optional declaration of the response it wants back
 *
 * The model never sees the catalog, the rendered component, or the Layout
 * Graph IR. The **UI Harness** (an LLM, Oracle-routed in prod) translates
 * intent + data + responseShape into a LayoutGraph composed from the
 * catalog. The renderer mounts the graph in the TUI, collects user input,
 * resolves the tool with the user's response (or void if fire-and-forget).
 *
 * Flow:
 *
 *   model → BuildInterface({ intent, data, responseShape? })
 *         → harness(input) → LayoutGraph
 *         → renderer mounts in TUI, collects user input
 *         → tool resolves with response (raw envelope; shape coupling is a
 *           harness responsibility — see notes below)
 *
 * MVP note on response shaping: the renderer produces a flat
 * `LayoutResponse` (component-id → value). It is the harness's job to use
 * component ids aligned with the model's declared `responseShape`. We do
 * **not** transform the response in this tool for MVP; full schema
 * validation + transformation lands once the renderer is wired (Stage 3+).
 */

import type { TextContent } from "@lue-labs/pi-ai";
import { LayoutRenderer, type LayoutResponse } from "@lue-labs/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { LayoutGraph } from "./layout-graph.ts";
import type { UIHarness, UIHarnessOptions } from "./ui-harness.ts";

// ============================================================================
// Public input schema — what the model fills in
// ============================================================================

/**
 * Tool input. Single envelope, no `kind` enum, no dispatch table. The
 * harness decides what to build from intent + data + responseShape.
 */
export const buildInterfaceSchema = Type.Object({
	intent: Type.String({
		description:
			"What you're trying to accomplish in 1–2 sentences. e.g. 'Ask the user which retry strategy to use'.",
	}),
	data: Type.Unknown({
		description:
			"Structured payload the harness should display. Any JSON-serializable shape — the harness reads it as opaque data.",
	}),
	responseShape: Type.Optional(
		Type.Unknown({
			description:
				"Optional JSON Schema declaring the response shape the caller expects. If present, the harness composes components whose ids align with this shape. If omitted, fire-and-forget (tool resolves once the UI is rendered).",
		}),
	),
});

export type BuildInterfaceInput = Static<typeof buildInterfaceSchema>;

// ============================================================================
// Harness contract
// ============================================================================

export type { UIHarness } from "./ui-harness.ts";

// ============================================================================
// Dispatch
// ============================================================================

/**
 * Resolve the tool input to a LayoutGraph by calling the harness. Pure
 * delegation today — the value of this seam is testability (the renderer
 * and the real LLM harness sit on opposite sides of it) and a single
 * choke-point for any cross-cutting concerns later (caching, telemetry,
 * graph-shape validation, etc.).
 *
 * The caller (the tool's `execute`) is responsible for mounting the
 * returned graph and producing the final tool result.
 */
export async function dispatchBuildInterface(
	input: BuildInterfaceInput,
	harness: UIHarness,
	options?: UIHarnessOptions,
): Promise<LayoutGraph> {
	return harness(input, options);
}

// ============================================================================
// Tool definition factory
// ============================================================================

/**
 * Outcome of mounting a graph in the renderer. The `done` callback in the
 * UI context's custom() flow receives one of these so the tool can
 * distinguish a real submit from a cancel without overloading
 * LayoutResponse with a status field.
 */
type RenderOutcome = { status: "submitted"; response: LayoutResponse } | { status: "cancelled" };

export interface BuildInterfaceToolOptions {
	/**
	 * The UI Harness. Inject the real LLM-backed harness in production; use
	 * `staticHarness` / `recordingHarness` / `exampleQuestionsHarness` in
	 * tests. See `./ui-harness.ts`.
	 */
	harness: UIHarness;
	/** Override the LLM-facing tool name. Default: "BuildInterface". */
	toolName?: string;
	/** Override the UI label. Default: "Build UI". */
	label?: string;
}

const DEFAULT_DESCRIPTION =
	"Build an interactive UI to ask the user something or display structured data. " +
	"Supply `intent` (1\u20132 sentences describing what you're trying to do), " +
	"`data` (the structured payload), and optional `responseShape` (a JSON Schema " +
	"describing the response you expect back). The UI Harness composes the actual " +
	"component from a fixed catalog and the user's input is returned to you. " +
	"Use this whenever you need clarification, multi-choice answers, or a confirmation.";

/**
 * Create the BuildInterface tool definition. The single public surface of the
 * generative-UI system: the agent calls this tool with intent + data +
 * optional responseShape, the harness builds a LayoutGraph, the renderer
 * mounts it, the user interacts, the tool resolves with the user's response.
 *
 * In print / RPC mode (no UI), the tool returns an error result rather than
 * silently dropping the call. The model should not be calling this when no
 * user is present, but a clear error makes the failure debuggable.
 */
export function createBuildInterfaceToolDefinition(
	options: BuildInterfaceToolOptions,
): ToolDefinition<typeof buildInterfaceSchema, BuildInterfaceDetails> {
	const toolName = options.toolName ?? "BuildInterface";
	const label = options.label ?? "Build UI";
	return {
		name: toolName,
		label,
		description: DEFAULT_DESCRIPTION,
		parameters: buildInterfaceSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeBuildInterface(params, options.harness, ctx, signal);
		},
	};
}

export interface BuildInterfaceDetails {
	graph: LayoutGraph;
	outcome: RenderOutcome;
}

/**
 * The execute body, broken out so tests can drive it with mocked context +
 * harness without spinning up the whole tool-registration pipeline.
 */
export async function executeBuildInterface(
	params: BuildInterfaceInput,
	harness: UIHarness,
	ctx: ExtensionContext | undefined,
	signal?: AbortSignal,
): Promise<{ content: TextContent[]; details: BuildInterfaceDetails }> {
	if (!ctx?.hasUI) {
		throw new Error("BuildInterface requires an interactive UI; the current mode does not provide one.");
	}
	if (signal?.aborted) throw new Error("Operation aborted");

	const graph = await harness(params, { signal });
	if (signal?.aborted) throw new Error("Operation aborted");

	const outcome = await ctx.ui.custom<RenderOutcome>(
		(_tui, _theme, _keybindings, done) =>
			new LayoutRenderer(graph, {
				onSubmit: (response) => done({ status: "submitted", response }),
				onCancel: () => done({ status: "cancelled" }),
			}),
		{ overlay: true },
	);

	return {
		content: [{ type: "text", text: formatOutcomeForModel(outcome) }],
		details: { graph, outcome },
	};
}

function formatOutcomeForModel(outcome: RenderOutcome): string {
	if (outcome.status === "cancelled") {
		return "User cancelled the UI prompt without responding.";
	}
	// MVP: stringify the raw envelope. Future: when responseShape is honored,
	// shape the response to match it before serializing.
	return JSON.stringify(outcome.response);
}
