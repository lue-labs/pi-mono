import type { Api, Model } from "@valkyriweb/pi-ai";
import { createDeferredToolSearchTool } from "../deferred-tool-search-tool.ts";
import {
	createDeferredToolStateEntryData,
	DEFERRED_TOOL_STATE_CUSTOM_TYPE,
	type DeferredToolStateSnapshot,
	isDeferredTool,
} from "../deferred-tools.ts";
import { addAction, load } from "./extension-hooks.ts";
import type { ExtensionAPI, SessionStateOptions, ToolDefinition } from "./types.ts";

function parseDeferredToolState(value: unknown): DeferredToolStateSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { discoveredToolNames } = value as { discoveredToolNames?: unknown };
	if (!Array.isArray(discoveredToolNames)) return undefined;
	return createDeferredToolStateEntryData(
		discoveredToolNames.filter((name): name is string => typeof name === "string"),
	);
}

function mergeDeferredToolState(
	previous: DeferredToolStateSnapshot,
	next: DeferredToolStateSnapshot,
): DeferredToolStateSnapshot {
	return createDeferredToolStateEntryData([...previous.discoveredToolNames, ...next.discoveredToolNames]);
}

const deferredToolStateOptions: SessionStateOptions<DeferredToolStateSnapshot> = {
	customType: DEFERRED_TOOL_STATE_CUSTOM_TYPE,
	defaultValue: createDeferredToolStateEntryData([]),
	parse: parseDeferredToolState,
	merge: mergeDeferredToolState,
};

function hasDeferredTools(definitions: ToolDefinition[]): boolean {
	return definitions.some((definition) => isDeferredTool(definition));
}

export function hookDeferredTools(pi: ExtensionAPI): void {
	const discoveredTools = pi.state("pi.deferredTools", deferredToolStateOptions);
	let registered = false;
	let currentModel: Model<Api> | undefined;

	const registerToolSearchIfNeeded = (): void => {
		const definitions = pi.tools.definitions();
		if (
			registered ||
			!hasDeferredTools(definitions) ||
			definitions.some((definition) => definition.name === "tool_search")
		) {
			return;
		}

		registered = true;
		pi.registerTool(
			createDeferredToolSearchTool({
				getToolDefinitions: () => pi.tools.definitions(),
				getModel: () => currentModel,
				getDiscoveredToolNames: () => discoveredTools.get().discoveredToolNames,
				setDiscoveredToolNames: (toolNames) => {
					discoveredTools.set(createDeferredToolStateEntryData(toolNames));
				},
				actions: {
					getActiveToolNames: () => pi.tools.active(),
					setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
					hydrateTools: (toolNames) => pi.tools.hydrateMessageDeliveredTools(toolNames),
				},
			}),
		);
	};

	pi.on("model_select", (event) => {
		currentModel = event.model;
	});

	pi.on("session_start", (_event, ctx) => {
		currentModel = ctx.model;
		registerToolSearchIfNeeded();
	});

	pi.on("tools_changed", () => {
		registerToolSearchIfNeeded();
	});
}

addAction(load, "deferredTools", hookDeferredTools);
