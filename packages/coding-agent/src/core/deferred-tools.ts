import type { Api, Model, ToolReferenceContent } from "@valkyriweb/pi-ai";
import { type DeferredToolCapabilities, getDeferredToolCapabilities } from "./deferred-tool-capabilities.ts";
import type { ToolDefinition } from "./extensions/types.ts";

export type DeferredToolReferenceBlock = ToolReferenceContent;

export interface DeferredToolDiscoveryResult {
	matches: ToolDefinition[];
	missing: string[];
	discoveredToolNames: string[];
	referenceBlocks: DeferredToolReferenceBlock[];
	guidelineBlocks: DeferredToolGuidelineBlock[];
}

export interface DeferredToolGuidelineBlock {
	type: "text";
	text: string;
}

/**
 * CACHE CRITICAL: deferred tools keep their schemas out of the cached prefix
 * via defer_loading; their prompt prose (promptSnippet/promptGuidelines) must
 * follow the same rule. The system prompt never includes it (see
 * agent-session._rebuildSystemPrompt); instead it is delivered here, in the
 * tool_search result — transcript suffix, delta-only, persisted in history.
 */
export function buildDeferredToolGuidelineBlock(definition: ToolDefinition): DeferredToolGuidelineBlock | undefined {
	const lines: string[] = [];
	const snippet = definition.promptSnippet?.trim();
	if (snippet) lines.push(snippet);
	for (const guideline of definition.promptGuidelines ?? []) {
		const trimmed = guideline.trim();
		if (trimmed) lines.push(`- ${trimmed}`);
	}
	if (lines.length === 0) return undefined;
	return {
		type: "text",
		text: `<tool-guidelines name="${definition.name}">\n${lines.join("\n")}\n</tool-guidelines>`,
	};
}

export const DEFERRED_TOOL_STATE_CUSTOM_TYPE = "pi.deferred_tools.state";

export interface DeferredToolStateSnapshot {
	discoveredToolNames: string[];
}

interface DeferredToolStateEntryLike {
	customType?: string;
	data?: unknown;
	details?: unknown;
}

export interface DeferredToolSearchPlan {
	mode: "native" | "fallback";
	message: string;
	matchedToolNames: string[];
	missingToolNames: string[];
	discoveredToolNames: string[];
	referenceBlocks: DeferredToolReferenceBlock[];
	guidelineBlocks: DeferredToolGuidelineBlock[];
	activateToolNames: string[];
	cacheMayBust: boolean;
	capabilities?: DeferredToolCapabilities;
}

export interface DeferredToolSearchRuntimeActions {
	getActiveToolNames(): string[];
	setActiveTools(toolNames: string[]): void;
}

interface MessageLike {
	content?: unknown;
	deferredToolState?: DeferredToolStateSnapshot;
}

export function isDeferredTool(definition: ToolDefinition): boolean {
	return definition.deferLoading === true && definition.alwaysLoad !== true;
}

export function searchDeferredTools(definitions: Iterable<ToolDefinition>, query: string): ToolDefinition[] {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.map((term) => term.trim())
		.filter(Boolean);
	if (terms.length === 0) return [];

	return Array.from(definitions).filter((definition) => {
		if (!isDeferredTool(definition)) return false;
		const haystack = [definition.name, definition.description, definition.searchHint]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		return terms.some((term) => haystack.includes(term));
	});
}

export function discoverDeferredTools(
	definitions: Iterable<ToolDefinition>,
	toolNames: Iterable<string>,
	previouslyDiscovered: Iterable<string> = [],
): DeferredToolDiscoveryResult {
	const byName = new Map(Array.from(definitions).map((definition) => [definition.name, definition]));
	const discovered = new Set(filterAvailableDeferredToolNames(previouslyDiscovered, byName));
	const matches: ToolDefinition[] = [];
	const missing: string[] = [];

	for (const name of toolNames) {
		const definition = byName.get(name);
		if (!definition || !isDeferredTool(definition)) {
			missing.push(name);
			continue;
		}
		if (!discovered.has(name)) {
			discovered.add(name);
			matches.push(definition);
		}
	}

	const discoveredToolNames = Array.from(discovered);
	return {
		matches,
		missing,
		discoveredToolNames,
		referenceBlocks: matches.map((definition) => ({ type: "tool_reference", name: definition.name })),
		guidelineBlocks: matches
			.map(buildDeferredToolGuidelineBlock)
			.filter((block): block is DeferredToolGuidelineBlock => block !== undefined),
	};
}

export function planDeferredToolSearchResult(
	definitions: Iterable<ToolDefinition>,
	toolNames: Iterable<string>,
	options: { nativeDeferredTools: boolean; previouslyDiscovered?: Iterable<string> },
): DeferredToolSearchPlan {
	const discovery = discoverDeferredTools(definitions, toolNames, options.previouslyDiscovered);
	const matchedToolNames = discovery.matches.map((tool) => tool.name);
	const mode = options.nativeDeferredTools ? "native" : "fallback";

	return {
		mode,
		message: formatDeferredToolSearchMessage(matchedToolNames, discovery.missing, mode),
		matchedToolNames,
		missingToolNames: discovery.missing,
		discoveredToolNames: discovery.discoveredToolNames,
		referenceBlocks: options.nativeDeferredTools ? discovery.referenceBlocks : [],
		// Guidelines ship in BOTH modes: fallback activations also need the prose
		// that no longer lives in the system prompt.
		guidelineBlocks: discovery.guidelineBlocks,
		activateToolNames: options.nativeDeferredTools ? [] : matchedToolNames,
		cacheMayBust: !options.nativeDeferredTools && matchedToolNames.length > 0,
	};
}

export function planDeferredToolSearchForModel(
	definitions: Iterable<ToolDefinition>,
	toolNames: Iterable<string>,
	model: Model<Api> | undefined,
	previouslyDiscovered: Iterable<string> = [],
): DeferredToolSearchPlan {
	const capabilities = getDeferredToolCapabilities(model);
	const plan = planDeferredToolSearchResult(definitions, toolNames, {
		nativeDeferredTools: capabilities.nativeDeferredTools && capabilities.toolReferenceResults,
		previouslyDiscovered,
	});
	return {
		...plan,
		capabilities,
		message: capabilities.fallbackReason ? `${plan.message} ${capabilities.fallbackReason}` : plan.message,
	};
}

export function executeDeferredToolSearchForModel(
	definitions: Iterable<ToolDefinition>,
	toolNames: Iterable<string>,
	model: Model<Api> | undefined,
	actions: DeferredToolSearchRuntimeActions,
	previouslyDiscovered: Iterable<string> = [],
): DeferredToolSearchPlan {
	const plan = planDeferredToolSearchForModel(definitions, toolNames, model, previouslyDiscovered);
	if (plan.activateToolNames.length > 0) {
		actions.setActiveTools(mergeFallbackActiveToolNames(actions.getActiveToolNames(), plan.activateToolNames));
	}
	return plan;
}

export function mergeFallbackActiveToolNames(
	currentActiveToolNames: Iterable<string>,
	activateToolNames: Iterable<string>,
): string[] {
	return Array.from(new Set([...currentActiveToolNames, ...activateToolNames]));
}

export function filterAvailableDeferredToolNames(
	discoveredToolNames: Iterable<string>,
	definitions: Iterable<ToolDefinition> | Map<string, ToolDefinition>,
): string[] {
	const byName =
		definitions instanceof Map
			? definitions
			: new Map(Array.from(definitions).map((definition) => [definition.name, definition]));
	return Array.from(new Set(discoveredToolNames)).filter((name) => {
		const definition = byName.get(name);
		return definition ? isDeferredTool(definition) : false;
	});
}

export function snapshotDeferredToolState(discoveredToolNames: Iterable<string>): DeferredToolStateSnapshot {
	return { discoveredToolNames: Array.from(new Set(discoveredToolNames)) };
}

export function createDeferredToolStateEntryData(discoveredToolNames: Iterable<string>): DeferredToolStateSnapshot {
	return snapshotDeferredToolState(discoveredToolNames);
}

export function scanDeferredToolStateEntries(entries: Iterable<unknown>): string[] {
	const discovered = new Set<string>();
	for (const rawEntry of entries) {
		const entry = rawEntry as DeferredToolStateEntryLike;
		if (entry.customType !== DEFERRED_TOOL_STATE_CUSTOM_TYPE) continue;
		const snapshot = parseDeferredToolStateSnapshot(entry.data ?? entry.details);
		for (const name of snapshot?.discoveredToolNames ?? []) discovered.add(name);
	}
	return Array.from(discovered);
}

export function scanDiscoveredDeferredToolNames(messages: Iterable<unknown>): string[] {
	const discovered = new Set<string>();
	for (const name of scanDeferredToolStateEntries(messages)) discovered.add(name);
	for (const rawMessage of messages) {
		const message = rawMessage as MessageLike;
		for (const name of message.deferredToolState?.discoveredToolNames ?? []) discovered.add(name);
		for (const name of scanPromptVisibleDeferredToolNames([message])) discovered.add(name);
	}
	return Array.from(discovered);
}

export function scanPromptVisibleDeferredToolNames(messages: Iterable<unknown>): string[] {
	const discovered = new Set<string>();
	for (const rawMessage of messages) {
		const message = rawMessage as MessageLike;
		for (const block of contentBlocks(message.content)) {
			if (isDeferredToolReferenceBlock(block)) discovered.add(block.name);
		}
	}
	return Array.from(discovered);
}

function formatDeferredToolSearchMessage(matched: string[], missing: string[], mode: "native" | "fallback"): string {
	const parts: string[] = [];
	if (matched.length > 0) {
		parts.push(
			mode === "native"
				? `Loaded deferred tool reference${matched.length === 1 ? "" : "s"}: ${matched.join(", ")}.`
				: `Activated deferred tool${matched.length === 1 ? "" : "s"}: ${matched.join(", ")}. Cache may bust once on fallback providers.`,
		);
	}
	if (missing.length > 0)
		parts.push(`Unavailable deferred tool${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
	return parts.join(" ") || "No deferred tools matched.";
}

function parseDeferredToolStateSnapshot(value: unknown): DeferredToolStateSnapshot | undefined {
	if (
		!value ||
		typeof value !== "object" ||
		!Array.isArray((value as DeferredToolStateSnapshot).discoveredToolNames)
	) {
		return undefined;
	}
	return snapshotDeferredToolState(
		(value as DeferredToolStateSnapshot).discoveredToolNames.filter(
			(name): name is string => typeof name === "string",
		),
	);
}

function contentBlocks(content: unknown): unknown[] {
	if (Array.isArray(content)) return content;
	if (content && typeof content === "object" && "content" in content)
		return contentBlocks((content as { content: unknown }).content);
	return [];
}

function isDeferredToolReferenceBlock(value: unknown): value is DeferredToolReferenceBlock {
	return (
		value !== null &&
		typeof value === "object" &&
		(value as { type?: unknown }).type === "tool_reference" &&
		typeof (value as { name?: unknown }).name === "string"
	);
}
