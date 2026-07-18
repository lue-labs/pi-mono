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
 * A tool's full JSON schema delivered inside the tool-result transcript as a
 * `<functions>` block. On transports that cannot use native tool_reference
 * blocks but can receive message-delivered schemas (issue #348), this is how an
 * activated deferred tool becomes callable WITHOUT mutating the request tools[]
 * (which would bust the whole cached prefix). The shape matches the harness
 * system-prompt convention: each function is a JSONSchema object, and a tool
 * whose schema appears here is "immediately callable exactly like any tool
 * defined here".
 */
export interface DeferredToolSchemaBlock {
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

/**
 * Serialize the given deferred tool definitions into a single `<functions>`
 * block for message-delivered hydration. Returns undefined when there is
 * nothing to deliver.
 */
export function buildDeferredToolSchemaBlock(definitions: ToolDefinition[]): DeferredToolSchemaBlock | undefined {
	const functions = definitions.map((definition) => {
		const schema = {
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
		};
		return `<function>${JSON.stringify(schema)}</function>`;
	});
	if (functions.length === 0) return undefined;
	return {
		type: "text",
		text: `<functions>\n${functions.join("\n")}\n</functions>`,
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
	mode: "native" | "fallback" | "hydrate";
	message: string;
	matchedToolNames: string[];
	missingToolNames: string[];
	discoveredToolNames: string[];
	referenceBlocks: DeferredToolReferenceBlock[];
	guidelineBlocks: DeferredToolGuidelineBlock[];
	/**
	 * `<functions>` schema blocks delivered in the tool result. Populated only in
	 * `hydrate` mode; empty otherwise.
	 */
	schemaBlocks: DeferredToolSchemaBlock[];
	/** Names to add to the active/serialized tools[] (fallback mutation path). */
	activateToolNames: string[];
	/**
	 * Names to hydrate append-only via message-delivered schema: register the
	 * executor without touching the serialized tools[]. Populated in `hydrate`
	 * mode; empty otherwise.
	 */
	hydrateToolNames: string[];
	cacheMayBust: boolean;
	capabilities?: DeferredToolCapabilities;
}

export interface DeferredToolSearchRuntimeActions {
	getActiveToolNames(): string[];
	setActiveTools(toolNames: string[]): void;
	/**
	 * Register message-delivered tools so their executor resolves from
	 * `context.tools` while the serialized wire tools[] stays byte-stable
	 * (issue #348). Optional: transports without message-delivery never call it.
	 */
	hydrateTools?(toolNames: string[]): void;
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
	options: {
		nativeDeferredTools: boolean;
		messageDeliveredSchemas?: boolean;
		previouslyDiscovered?: Iterable<string>;
	},
): DeferredToolSearchPlan {
	const discovery = discoverDeferredTools(definitions, toolNames, options.previouslyDiscovered);
	const matchedToolNames = discovery.matches.map((tool) => tool.name);
	// Message-delivered hydration only applies on the non-native fallback lane.
	const hydrate = !options.nativeDeferredTools && options.messageDeliveredSchemas === true;
	const mode = options.nativeDeferredTools ? "native" : hydrate ? "hydrate" : "fallback";
	const schemaBlock = hydrate ? buildDeferredToolSchemaBlock(discovery.matches) : undefined;

	return {
		mode,
		message: formatDeferredToolSearchMessage(matchedToolNames, discovery.missing, mode),
		matchedToolNames,
		missingToolNames: discovery.missing,
		discoveredToolNames: discovery.discoveredToolNames,
		referenceBlocks: options.nativeDeferredTools ? discovery.referenceBlocks : [],
		// Guidelines ship in ALL modes: fallback/hydrate activations also need the
		// prose that no longer lives in the system prompt.
		guidelineBlocks: discovery.guidelineBlocks,
		schemaBlocks: schemaBlock ? [schemaBlock] : [],
		// Hydrate keeps tools[] byte-stable — no active-list mutation.
		activateToolNames: options.nativeDeferredTools || hydrate ? [] : matchedToolNames,
		hydrateToolNames: hydrate ? matchedToolNames : [],
		cacheMayBust: !options.nativeDeferredTools && !hydrate && matchedToolNames.length > 0,
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
		messageDeliveredSchemas: capabilities.messageDeliveredSchemas,
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
	if (plan.hydrateToolNames.length > 0) {
		// Append-only hydration: register executors without mutating tools[].
		actions.hydrateTools?.(plan.hydrateToolNames);
	} else if (plan.activateToolNames.length > 0) {
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
	for (const rawMessage of messages) {
		const stateEntry = rawMessage as DeferredToolStateEntryLike;
		if (stateEntry.customType === DEFERRED_TOOL_STATE_CUSTOM_TYPE) {
			const snapshot = parseDeferredToolStateSnapshot(stateEntry.data ?? stateEntry.details);
			for (const name of snapshot?.discoveredToolNames ?? []) discovered.add(name);
		}

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

function formatDeferredToolSearchMessage(
	matched: string[],
	missing: string[],
	mode: "native" | "fallback" | "hydrate",
): string {
	const parts: string[] = [];
	if (matched.length > 0) {
		const plural = matched.length === 1 ? "" : "s";
		parts.push(
			mode === "native"
				? `Loaded deferred tool reference${plural}: ${matched.join(", ")}.`
				: mode === "hydrate"
					? `Loaded deferred tool schema${plural}: ${matched.join(", ")}. The schema${plural} above ${matched.length === 1 ? "is" : "are"} now callable.`
					: `Activated deferred tool${plural}: ${matched.join(", ")}. Cache may bust once on fallback providers.`,
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
