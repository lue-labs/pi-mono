/**
 * Deterministic per-tool serialization + deferred-tool detection (fork-owned).
 *
 * - {@link convertOneTool} + {@link convertedToolCache}: memoized, key-sorted
 *   conversion of one pi Tool to the Anthropic wire shape. Identity +
 *   sort-keys together guarantee a byte-stable tools[] cache prefix. The
 *   WeakMap is module-global on purpose: `convertTools` (anthropic-messages.ts)
 *   must hit the same memo across requests for the lifetime of a Tool object.
 * - {@link hasDeferredTool} / {@link hasToolReferenceContent}: inputs to the
 *   tool-search beta decision (`shouldUseToolSearchBeta`, anthropic-messages.ts).
 *
 * Fork provenance: extracted verbatim from anthropic-messages.ts (fork-delta
 * reforge slice 6); tier `platform` in pi-fork-patch-inventory.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Context, Model, Tool } from "../types.ts";

export function hasDeferredTool(context: Context): boolean {
	return context.tools?.some((tool) => tool.deferLoading && !tool.alwaysLoad) ?? false;
}

export function hasToolReferenceContent(context: Context): boolean {
	return context.messages.some((message) => {
		if (message.role === "assistant" || message.role === "toolResult") {
			return message.content.some((block) => block.type === "tool_reference");
		}
		return false;
	});
}

/**
 * Recursively sort object keys for deterministic serialization. Arrays are
 * left in place (preserves enum order). Primitives pass through.
 *
 * JSON Schema is semantically key-order-independent, so sorting is safe. This
 * defends against cache-prefix mutation when the upstream schema source (e.g.
 * an MCP server re-emitting `tools/list`) returns the same keys in a
 * different order between turns.
 *
 * Refs: my-pi/docs/cache-break-investigation-2026-05-16.md Fix #2.
 */
function sortObjectKeysDeep(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const input = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		out[key] = sortObjectKeysDeep(input[key]);
	}
	return out;
}

/**
 * Per-tool memoization of the converted Anthropic shape. Same `tool` reference
 * + same flag combination => byte-identical returned object across calls.
 *
 * Steady state (no `_buildRuntime` rebuild): `state.tools.slice()` returns a
 * fresh array but the element references are stable, so the memo hits and we
 * return the exact same converted object each turn. Anthropic's prompt cache
 * hashes these bytes, so identity + sort-keys together guarantee a stable
 * cache prefix for the tools slot.
 *
 * On rebuild: new tool references => memo miss => recompute. No correctness
 * risk; just no caching benefit until the rebuild cycle itself is fixed
 * (Fix #3 in the cache-break investigation doc).
 *
 * @internal Shared only with `anthropic-messages.ts` `convertTools` (which
 * stays inline for upstream-coupling reasons). Not exported from the package
 * barrel; do not add it to `src/index.ts` or mutate it from elsewhere.
 */
export const convertedToolCache = new WeakMap<object, Map<string, Anthropic.Messages.ToolUnion>>();

export function convertOneTool(
	tool: Tool,
	model: Model<any>,
	supportsEagerToolInputStreaming: boolean,
	deferLoading: boolean,
	wireName: string,
): Anthropic.Messages.ToolUnion {
	// Explicit server-tool opt-in: the tool definition supplies the exact
	// Anthropic server tool block (web_search_20250305, web_fetch_20260309, ...).
	// Replaces the old name-based web_fetch/web_search interception so client-side
	// implementations may reuse those wire names.
	if (model.provider === "claude-bridge" && tool.anthropicServerTool) {
		return tool.anthropicServerTool as unknown as Anthropic.Messages.ToolUnion;
	}
	if (model.provider === "claude-bridge" && tool.name === "advisor") {
		// Server-side advisor (advisor_20260301, beta advisor-tool-2026-03-01).
		// Anthropic runs the advisor call server-side and forwards the full
		// conversation — the advisor rides the parent's prompt cache instead of
		// paying full input cost on a client-built transcript. The advisor model
		// comes from the schema's `model` default (set by the advisor extension);
		// the bridge adds the beta header when it sees this typed block.
		const schema = tool.parameters as { properties?: { model?: { default?: string } } };
		const advisorModel = schema.properties?.model?.default;
		if (typeof advisorModel === "string" && advisorModel.length > 0) {
			return {
				name: "advisor",
				type: "advisor_20260301",
				model: advisorModel,
			} as unknown as Anthropic.Messages.ToolUnion;
		}
		// No advisor model configured → fall through to the client tool path.
	}
	const schema = tool.parameters as { properties?: unknown; required?: string[] };
	const properties = sortObjectKeysDeep(schema.properties ?? {}) as Record<string, unknown>;
	const required = (schema.required ?? []).slice().sort();
	return {
		name: wireName,
		description: tool.description,
		...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
		...(deferLoading ? { defer_loading: true } : {}),
		input_schema: {
			type: "object",
			properties,
			required,
		},
	};
}
