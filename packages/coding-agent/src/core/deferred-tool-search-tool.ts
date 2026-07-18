import type { Api, Model } from "@valkyriweb/pi-ai";
import { Text } from "@valkyriweb/pi-tui";
import { Type } from "typebox";
import { keyHint } from "../modes/interactive/components/keybinding-hints.ts";
import {
	type DeferredToolSearchPlan,
	type DeferredToolSearchRuntimeActions,
	executeDeferredToolSearchForModel,
	searchDeferredTools,
} from "./deferred-tools.ts";
import type { ToolDefinition } from "./extensions/types.ts";

const toolSearchSchema = Type.Object({
	query: Type.Optional(Type.String()),
	toolNames: Type.Optional(Type.Array(Type.String())),
});

export interface DeferredToolSearchToolOptions {
	getToolDefinitions(): ToolDefinition[];
	getModel(): Model<Api> | undefined;
	getDiscoveredToolNames(): string[];
	setDiscoveredToolNames(toolNames: string[]): void;
	actions: DeferredToolSearchRuntimeActions;
}

function formatToolSearchLabel(args: { query?: string; toolNames?: string[] }): string {
	const names = (args.toolNames ?? []).filter(Boolean);
	const query = (args.query ?? "").trim();
	if (names.length > 0) {
		const head = names.slice(0, 3).join(", ");
		const extra = names.length > 3 ? ` +${names.length - 3}` : "";
		return head + extra;
	}
	if (query) return query.length > 60 ? `${query.slice(0, 59)}…` : query;
	return "…";
}

function preferClaudeCompatibleToolNames(toolNames: string[]): string[] {
	if (!toolNames.some((name) => name.toLowerCase().includes("agent"))) {
		return toolNames;
	}

	const preferred = new Set(toolNames);
	if (preferred.has("Agent") && preferred.has("Task")) {
		preferred.delete("agent");
	}
	return Array.from(preferred);
}

export function createDeferredToolSearchTool(
	options: DeferredToolSearchToolOptions,
): ToolDefinition<typeof toolSearchSchema> {
	return {
		name: "tool_search",
		label: "Tool Search",
		description: "Discover and load deferred tools by query or exact tool name.",
		promptSnippet: "Discover and progressively load deferred tools when needed",
		parameters: toolSearchSchema,
		renderCall(args, theme) {
			const label = formatToolSearchLabel(args);
			return new Text(theme.fg("toolTitle", `[tool_search] ${label}`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const plan = result.details as DeferredToolSearchPlan | undefined;
			const text = result.content
				.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
				.join("\n")
				.trim();
			const matched = plan?.matchedToolNames.length ?? 0;
			const missing = plan?.missingToolNames.length ?? 0;
			const already = Math.max(0, (plan?.discoveredToolNames.length ?? 0) - matched);
			const parts: string[] = [];
			if (matched > 0) parts.push(`activated ${matched}`);
			if (already > 0) parts.push(`${already} already active`);
			if (missing > 0) parts.push(`${missing} missing`);
			if (parts.length === 0) parts.push("no matches");
			const summary = `[tool_search] ${parts.join(", ")}`;
			const color = (result as { isError?: boolean }).isError ? "error" : "success";
			if (!expanded) {
				const hint = text ? ` (${keyHint("app.tools.expand", "to expand")})` : "";
				return new Text(theme.fg(color, summary + hint), 0, 0);
			}
			return new Text(theme.fg(color, text ? `${summary}\n${text}` : summary), 0, 0);
		},
		async execute(_toolCallId, params) {
			const definitions = options.getToolDefinitions();
			const exactNames = params.toolNames ?? [];
			const queryMatches = params.query
				? searchDeferredTools(definitions, params.query).map((tool) => tool.name)
				: [];
			const requestedNames = Array.from(new Set([...exactNames, ...preferClaudeCompatibleToolNames(queryMatches)]));
			const plan = executeDeferredToolSearchForModel(
				definitions,
				requestedNames,
				options.getModel(),
				options.actions,
				options.getDiscoveredToolNames(),
			);
			options.setDiscoveredToolNames(plan.discoveredToolNames);

			// tool_reference blocks lead the content array (the history scan that
			// reconstructs discovery state keys on them); message-delivered `<functions>`
			// schema blocks (hydrate mode) and guideline text follow.
			const content = [...plan.referenceBlocks, ...plan.schemaBlocks, ...plan.guidelineBlocks];
			return {
				content: content.length > 0 ? content : [{ type: "text" as const, text: plan.message }],
				details: plan,
			};
		},
	};
}
