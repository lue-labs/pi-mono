import type { Api, Model, ToolReferenceContent } from "@mariozechner/pi-ai";
import { type DeferredToolCapabilities, getDeferredToolCapabilities } from "./deferred-tool-capabilities.js";
import type { ToolDefinition } from "./extensions/types.js";

export type DeferredToolReferenceBlock = ToolReferenceContent;

export interface DeferredToolDiscoveryResult {
	matches: ToolDefinition[];
	missing: string[];
	discoveredToolNames: string[];
	referenceBlocks: DeferredToolReferenceBlock[];
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

const SELECT_PREFIX = "select:";

/**
 * Search deferred tools using the three-mode DSL (mirrors extension search.ts):
 *
 *   1. `select:Name1,Name2`  — direct selection by exact name, no ranking
 *   2. `+required-term ...`  — keyword search; `+token` must appear somewhere
 *   3. plain keywords        — substring + position scoring
 *
 * Ranking weights (per token):
 *   exact name match     +12
 *   name starts-with     +6
 *   name contains        +4
 *   description contains +2
 *
 * Tie-break: alphabetic by name.
 */
export function getDeferredToolSearchToolNames(
	definitions: Iterable<ToolDefinition>,
	query: string,
	maxResults = 5,
): string[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [];

	// Mode 1: direct selection — preserve listed names so missing selections can be reported.
	if (trimmed.toLowerCase().startsWith(SELECT_PREFIX)) {
		return trimmed
			.slice(SELECT_PREFIX.length)
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
			.slice(0, maxResults);
	}

	return searchDeferredTools(definitions, query, maxResults).map((definition) => definition.name);
}

export function searchDeferredTools(
	definitions: Iterable<ToolDefinition>,
	query: string,
	maxResults = 5,
): ToolDefinition[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [];

	const all = Array.from(definitions).filter(isDeferredTool);

	// Mode 1: direct selection — return in listed order, no ranking
	if (trimmed.toLowerCase().startsWith(SELECT_PREFIX)) {
		const wanted = getDeferredToolSearchToolNames(definitions, query, maxResults);
		const byName = new Map(all.map((d) => [d.name, d]));
		const out: ToolDefinition[] = [];
		for (const name of wanted) {
			const def = byName.get(name);
			if (def) out.push(def);
		}
		return out;
	}

	// Modes 2/3: keyword search with optional `+required` tokens
	const tokens = trimmed.toLowerCase().split(/\s+/);
	const required: string[] = [];
	const ranking: string[] = [];
	for (const tok of tokens) {
		if (tok.startsWith("+") && tok.length > 1) {
			required.push(tok.slice(1));
		} else {
			ranking.push(tok);
		}
	}

	const allTokens = [...required, ...ranking];
	if (allTokens.length === 0) return [];

	const scored: Array<{ def: ToolDefinition; score: number }> = [];
	for (const def of all) {
		const nameLc = def.name.toLowerCase();
		const descLc = (def.description ?? "").toLowerCase();
		const searchBlob = [nameLc, descLc, (def.searchHint ?? "").toLowerCase()].join(" ");

		// Required-term gate
		if (required.some((r) => !searchBlob.includes(r))) continue;

		let score = 0;
		for (const t of allTokens) {
			if (nameLc === t) score += 12;
			else if (nameLc.startsWith(t)) score += 6;
			else if (nameLc.includes(t)) score += 4;
			if (descLc.includes(t)) score += 2;
		}
		if (score > 0) scored.push({ def, score });
	}

	scored.sort((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name));
	return scored.slice(0, maxResults).map((s) => s.def);
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

export function scanDiscoveredDeferredToolNames(messages: Iterable<MessageLike>): string[] {
	const discovered = new Set<string>();
	for (const name of scanDeferredToolStateEntries(messages)) discovered.add(name);
	for (const message of messages) {
		for (const name of message.deferredToolState?.discoveredToolNames ?? []) discovered.add(name);
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
