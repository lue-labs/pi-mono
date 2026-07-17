import {
	createDeferredToolSearchTool,
	type DeferredToolSearchToolOptions,
	TOOL_SEARCH_NAME,
} from "./deferred-tool-search-tool.js";
import { isDeferredTool } from "./deferred-tools.js";
import type { ToolDefinition } from "./extensions/types.js";
import { createSyntheticSourceInfo } from "./source-info.js";

export interface ToolDefinitionEntryLike {
	definition: ToolDefinition;
	sourceInfo: unknown;
}

export function ensureDeferredToolSearchDefinition<TEntry extends ToolDefinitionEntryLike>(
	definitionRegistry: Map<string, TEntry>,
	options: DeferredToolSearchToolOptions & { enabled?: boolean },
): boolean {
	if (options.enabled === false) return false;
	const hasDeferredTools = Array.from(definitionRegistry.values()).some(({ definition }) =>
		isDeferredTool(definition),
	);
	if (!hasDeferredTools || definitionRegistry.has(TOOL_SEARCH_NAME)) return false;

	definitionRegistry.set(TOOL_SEARCH_NAME, {
		definition: createDeferredToolSearchTool(options),
		sourceInfo: createSyntheticSourceInfo(`<builtin:${TOOL_SEARCH_NAME}>`, { source: "builtin" }),
	} as unknown as TEntry);
	return true;
}
