import type { Api, Model } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import {
	type DeferredToolSearchRuntimeActions,
	executeDeferredToolSearchForModel,
	getDeferredToolSearchToolNames,
} from "./deferred-tools.js";
import type { ToolDefinition } from "./extensions/types.js";

/** Canonical tool name — PascalCase to match native-tool conventions (Read/Edit/Bash). */
export const TOOL_SEARCH_NAME = "ToolSearch";

const toolSearchSchema = Type.Object({
	query: Type.String({
		description:
			"Search query. Plain keywords for ranked search (e.g. 'click ui'). " +
			"'select:Name1,Name2' for direct activation by exact tool name. " +
			"Prefix any token with '+' to require it (e.g. '+screenshot click').",
	}),
	max_results: Type.Optional(
		Type.Number({
			description: "Maximum number of tools to return and activate. Default 5.",
			default: 5,
		}),
	),
});

export interface DeferredToolSearchToolOptions {
	getToolDefinitions(): ToolDefinition[];
	getModel(): Model<Api> | undefined;
	getDiscoveredToolNames(): string[];
	setDiscoveredToolNames(toolNames: string[]): void;
	actions: DeferredToolSearchRuntimeActions;
}

export function createDeferredToolSearchTool(
	options: DeferredToolSearchToolOptions,
): ToolDefinition<typeof toolSearchSchema> {
	return {
		name: TOOL_SEARCH_NAME,
		label: "Tool Search",
		description:
			"Discover and activate deferred tools by keyword or exact name. " +
			"Use this when you need a tool whose name is in <deferred-tools> but whose schema isn't in your tool list. " +
			"Matches are activated for the rest of the session — call them directly afterwards.",
		promptSnippet: "discover and activate deferred tools by keyword or exact name",
		parameters: toolSearchSchema,
		async execute(_toolCallId, params) {
			const definitions = options.getToolDefinitions();
			const maxResults = params.max_results ?? 5;
			const requestedNames = getDeferredToolSearchToolNames(definitions, params.query, maxResults);

			const plan = executeDeferredToolSearchForModel(
				definitions,
				requestedNames,
				options.getModel(),
				options.actions,
				options.getDiscoveredToolNames(),
			);
			options.setDiscoveredToolNames(plan.discoveredToolNames);

			return {
				content:
					plan.referenceBlocks.length > 0 ? plan.referenceBlocks : [{ type: "text" as const, text: plan.message }],
				details: plan,
			};
		},
	};
}
