/**
 * Native deferred-tool path tests.
 *
 * Goal coverage: native deferred-tool support must match Claude Code and Codex mechanics:
 *   - `isDeferredTool(definition)` = `deferLoading === true && alwaysLoad !== true`
 *   - `discoverDeferredTools(...)` emits `tool_reference` blocks ONLY for newly-matched names (delta)
 *   - `scanDiscoveredDeferredToolNames(history)` reconstructs the discovered set from
 *     either custom session entries (DEFERRED_TOOL_STATE_CUSTOM_TYPE) or `tool_reference`
 *     content blocks embedded in tool results — i.e. discovered state is recoverable
 *     from transcript history without session-only state
 *   - `planDeferredToolSearchForModel(...)` picks native mode for anthropic-messages
 *     (non-haiku) and fallback mode otherwise
 *   - Active-list mutation only happens on the fallback path (`cacheMayBust` true)
 *   - Native path returns `referenceBlocks` and `activateToolNames: []` (no mutation)
 */
import type { Api, Model } from "@valkyriweb/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	createDeferredToolStateEntryData,
	DEFERRED_TOOL_STATE_CUSTOM_TYPE,
	discoverDeferredTools,
	executeDeferredToolSearchForModel,
	filterAvailableDeferredToolNames,
	isDeferredTool,
	planDeferredToolSearchForModel,
	planDeferredToolSearchResult,
	scanDeferredToolStateEntries,
	scanDiscoveredDeferredToolNames,
	searchDeferredTools,
	snapshotDeferredToolState,
} from "../src/core/deferred-tools.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";

function makeDefinition(name: string, options: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		label: name,
		description: options.description ?? `${name} description`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: name }] }),
		...options,
	} as ToolDefinition;
}

function anthropicModel(id = "claude-sonnet-4-5"): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function codexModel(id = "gpt-5.5"): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 32000,
	};
}

describe("isDeferredTool", () => {
	it("returns true only when deferLoading is true and alwaysLoad is not true", () => {
		expect(isDeferredTool(makeDefinition("plain"))).toBe(false);
		expect(isDeferredTool(makeDefinition("a", { deferLoading: true }))).toBe(true);
		expect(isDeferredTool(makeDefinition("b", { deferLoading: true, alwaysLoad: true }))).toBe(false);
		expect(isDeferredTool(makeDefinition("c", { alwaysLoad: true }))).toBe(false);
		expect(isDeferredTool(makeDefinition("d", { deferLoading: false }))).toBe(false);
	});
});

describe("discoverDeferredTools — delta semantics", () => {
	const definitions = [
		makeDefinition("alpha", { deferLoading: true }),
		makeDefinition("beta", { deferLoading: true }),
		makeDefinition("gamma", { deferLoading: true }),
		makeDefinition("eager", {}),
	];

	it("returns reference blocks only for newly-discovered names", () => {
		const result = discoverDeferredTools(definitions, ["alpha", "beta"], []);
		expect(result.matches.map((d) => d.name)).toEqual(["alpha", "beta"]);
		expect(result.referenceBlocks).toEqual([
			{ type: "tool_reference", name: "alpha" },
			{ type: "tool_reference", name: "beta" },
		]);
		expect(result.discoveredToolNames).toEqual(expect.arrayContaining(["alpha", "beta"]));
	});

	it("omits already-discovered tools from the matches/blocks (delta only)", () => {
		const result = discoverDeferredTools(definitions, ["alpha", "beta", "gamma"], ["alpha"]);
		expect(result.matches.map((d) => d.name)).toEqual(["beta", "gamma"]);
		expect(result.referenceBlocks).toEqual([
			{ type: "tool_reference", name: "beta" },
			{ type: "tool_reference", name: "gamma" },
		]);
		// Discovered set carries forward alpha plus the new names.
		expect(result.discoveredToolNames.sort()).toEqual(["alpha", "beta", "gamma"]);
	});

	it("flags non-existent or non-deferred names as missing", () => {
		const result = discoverDeferredTools(definitions, ["alpha", "eager", "ghost"], []);
		expect(result.matches.map((d) => d.name)).toEqual(["alpha"]);
		expect(result.missing.sort()).toEqual(["eager", "ghost"]);
	});

	it("calling twice with no new names yields zero matches and no blocks", () => {
		const first = discoverDeferredTools(definitions, ["alpha", "beta"], []);
		const second = discoverDeferredTools(definitions, ["alpha", "beta"], first.discoveredToolNames);
		expect(second.matches).toEqual([]);
		expect(second.referenceBlocks).toEqual([]);
		expect(second.discoveredToolNames.sort()).toEqual(["alpha", "beta"]);
	});
});

describe("scanDiscoveredDeferredToolNames — history-based reconstruction", () => {
	it("reads tool_reference blocks embedded in tool-result message content", () => {
		const history = [
			{ role: "user", content: "do work" },
			{
				role: "tool",
				content: [
					{ type: "tool_reference", name: "alpha" },
					{ type: "text", text: "Loaded alpha." },
					{ type: "tool_reference", name: "beta" },
				],
			},
		];
		const discovered = scanDiscoveredDeferredToolNames(history);
		expect(discovered.sort()).toEqual(["alpha", "beta"]);
	});

	it("reads DEFERRED_TOOL_STATE_CUSTOM_TYPE custom entries", () => {
		const history = [
			{
				customType: DEFERRED_TOOL_STATE_CUSTOM_TYPE,
				data: createDeferredToolStateEntryData(["alpha", "beta"]),
			},
		];
		const discovered = scanDeferredToolStateEntries(history);
		expect(discovered.sort()).toEqual(["alpha", "beta"]);
	});

	it("merges custom entries and tool_reference blocks across the whole history", () => {
		const history = [
			{
				customType: DEFERRED_TOOL_STATE_CUSTOM_TYPE,
				data: createDeferredToolStateEntryData(["alpha"]),
			},
			{
				role: "tool",
				content: [{ type: "tool_reference", name: "beta" }],
			},
			{
				role: "tool",
				content: [
					{ type: "tool_reference", name: "alpha" },
					{ type: "tool_reference", name: "gamma" },
				],
			},
		];
		const discovered = scanDiscoveredDeferredToolNames(history).sort();
		expect(discovered).toEqual(["alpha", "beta", "gamma"]);
	});

	it("ignores unrelated content blocks and custom entries", () => {
		const history = [
			{ customType: "pi.unrelated.snapshot", data: { discoveredToolNames: ["should_not_load"] } },
			{ role: "tool", content: [{ type: "text", text: "no tools here" }] },
		];
		expect(scanDiscoveredDeferredToolNames(history)).toEqual([]);
	});
});

describe("filterAvailableDeferredToolNames", () => {
	it("drops names that don't exist or aren't deferrable", () => {
		const definitions = [
			makeDefinition("alpha", { deferLoading: true }),
			makeDefinition("eager", {}),
			makeDefinition("locked", { deferLoading: true, alwaysLoad: true }),
		];
		const filtered = filterAvailableDeferredToolNames(["alpha", "eager", "locked", "ghost"], definitions);
		expect(filtered).toEqual(["alpha"]);
	});
});

describe("searchDeferredTools — keyword scoring restricted to deferred set", () => {
	const definitions = [
		makeDefinition("browser_click", {
			deferLoading: true,
			description: "Click an element in the browser",
			searchHint: "ui interaction click element",
		}),
		makeDefinition("notes_search", {
			deferLoading: true,
			description: "Search obsidian notes by keyword",
			searchHint: "notes search obsidian",
		}),
		makeDefinition("always_on", { alwaysLoad: true, description: "Always-on helper" }),
		makeDefinition("plain", {}),
	];

	it("matches against name, description, and searchHint", () => {
		const matches = searchDeferredTools(definitions, "click").map((d) => d.name);
		expect(matches).toEqual(["browser_click"]);
	});

	it("never returns alwaysLoad or non-deferred tools", () => {
		const matches = searchDeferredTools(definitions, "helper plain always").map((d) => d.name);
		expect(matches).toEqual([]);
	});

	it("returns an empty list for empty query", () => {
		expect(searchDeferredTools(definitions, "")).toEqual([]);
		expect(searchDeferredTools(definitions, "   ")).toEqual([]);
	});
});

describe("planDeferredToolSearchForModel — native vs fallback decision", () => {
	const definitions = [makeDefinition("alpha", { deferLoading: true })];

	it("uses native mode for anthropic-messages non-haiku models", () => {
		const plan = planDeferredToolSearchForModel(definitions, ["alpha"], anthropicModel("claude-sonnet-4-5"), []);
		expect(plan.mode).toBe("native");
		expect(plan.referenceBlocks).toEqual([{ type: "tool_reference", name: "alpha" }]);
		expect(plan.activateToolNames).toEqual([]);
		expect(plan.cacheMayBust).toBe(false);
		expect(plan.capabilities?.nativeDeferredTools).toBe(true);
	});

	it("uses fallback mode for haiku (no tool_reference support)", () => {
		const plan = planDeferredToolSearchForModel(definitions, ["alpha"], anthropicModel("claude-haiku-4-5"), []);
		expect(plan.mode).toBe("fallback");
		expect(plan.referenceBlocks).toEqual([]);
		expect(plan.activateToolNames).toEqual(["alpha"]);
		expect(plan.cacheMayBust).toBe(true);
		expect(plan.capabilities?.fallbackReason).toMatch(/haiku/i);
	});

	it("uses fallback mode when no model is selected", () => {
		const plan = planDeferredToolSearchForModel(definitions, ["alpha"], undefined, []);
		expect(plan.mode).toBe("fallback");
		expect(plan.capabilities?.fallbackReason).toMatch(/no model/i);
	});

	it("uses fallback mode when model.compat disables deferred tools", () => {
		const model = anthropicModel("claude-sonnet-4-5");
		(model as { compat?: { supportsDeferredTools?: boolean } }).compat = { supportsDeferredTools: false };
		const plan = planDeferredToolSearchForModel(definitions, ["alpha"], model, []);
		expect(plan.mode).toBe("fallback");
		expect(plan.cacheMayBust).toBe(true);
	});

	it("uses native mode for openai-codex Responses models", () => {
		const plan = planDeferredToolSearchForModel(definitions, ["alpha"], codexModel(), []);
		expect(plan.mode).toBe("native");
		expect(plan.referenceBlocks).toEqual([{ type: "tool_reference", name: "alpha" }]);
		expect(plan.activateToolNames).toEqual([]);
		expect(plan.cacheMayBust).toBe(false);
		expect(plan.capabilities?.nativeDeferredTools).toBe(true);
	});

	it("uses fallback mode when openai-codex model.compat disables deferred tools", () => {
		const model = codexModel();
		(model as { compat?: { supportsDeferredTools?: boolean } }).compat = { supportsDeferredTools: false };
		const plan = planDeferredToolSearchForModel(definitions, ["alpha"], model, []);
		expect(plan.mode).toBe("fallback");
		expect(plan.cacheMayBust).toBe(true);
		expect(plan.capabilities?.fallbackReason).toMatch(/codex/i);
	});

	it("uses fallback mode for non-anthropic-messages APIs", () => {
		const openai: Model<Api> = {
			id: "gpt-x",
			name: "GPT-X",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		};
		const plan = planDeferredToolSearchForModel(definitions, ["alpha"], openai, []);
		expect(plan.mode).toBe("fallback");
		expect(plan.capabilities?.nativeDeferredTools).toBe(false);
	});
});

describe("planDeferredToolSearchResult — delta semantics across two turns", () => {
	const definitions = [
		makeDefinition("alpha", { deferLoading: true }),
		makeDefinition("beta", { deferLoading: true }),
	];

	it("turn 1 returns alpha block; turn 2 returns only beta block (no re-emission)", () => {
		const turn1 = planDeferredToolSearchResult(definitions, ["alpha"], { nativeDeferredTools: true });
		expect(turn1.referenceBlocks).toEqual([{ type: "tool_reference", name: "alpha" }]);

		const turn2 = planDeferredToolSearchResult(definitions, ["alpha", "beta"], {
			nativeDeferredTools: true,
			previouslyDiscovered: turn1.discoveredToolNames,
		});
		expect(turn2.referenceBlocks).toEqual([{ type: "tool_reference", name: "beta" }]);
		expect(turn2.discoveredToolNames.sort()).toEqual(["alpha", "beta"]);
	});
});

describe("executeDeferredToolSearchForModel — mutates active list only on fallback", () => {
	const definitions = [makeDefinition("alpha", { deferLoading: true })];

	it("native mode does not call setActiveTools", () => {
		let activeWrites = 0;
		const actions = {
			getActiveToolNames: () => ["existing"],
			setActiveTools: (_: string[]) => {
				activeWrites++;
			},
		};
		const plan = executeDeferredToolSearchForModel(definitions, ["alpha"], anthropicModel(), actions, []);
		expect(plan.mode).toBe("native");
		expect(activeWrites).toBe(0);
	});

	it("openai-codex native mode does not call setActiveTools", () => {
		let activeWrites = 0;
		const actions = {
			getActiveToolNames: () => ["existing"],
			setActiveTools: (_: string[]) => {
				activeWrites++;
			},
		};
		const plan = executeDeferredToolSearchForModel(definitions, ["alpha"], codexModel(), actions, []);
		expect(plan.mode).toBe("native");
		expect(activeWrites).toBe(0);
	});

	it("fallback mode calls setActiveTools with merged set", () => {
		const writes: string[][] = [];
		const actions = {
			getActiveToolNames: () => ["existing"],
			setActiveTools: (toolNames: string[]) => writes.push(toolNames),
		};
		const plan = executeDeferredToolSearchForModel(
			definitions,
			["alpha"],
			anthropicModel("claude-haiku-4-5"),
			actions,
			[],
		);
		expect(plan.mode).toBe("fallback");
		expect(writes).toHaveLength(1);
		expect(writes[0].sort()).toEqual(["alpha", "existing"]);
	});
});

describe("snapshotDeferredToolState — compact, timestamp-free persistence", () => {
	it("yields only the discoveredToolNames list, deduplicated", () => {
		const snapshot = snapshotDeferredToolState(["alpha", "beta", "alpha", "gamma"]);
		expect(Object.keys(snapshot).sort()).toEqual(["discoveredToolNames"]);
		expect(snapshot.discoveredToolNames.sort()).toEqual(["alpha", "beta", "gamma"]);
	});
});

describe("deferred-tool discovery loop — native mode across turns", () => {
	const definitions = [
		makeDefinition("alpha", { deferLoading: true }),
		makeDefinition("beta", { deferLoading: true }),
		makeDefinition("gamma", { deferLoading: true }),
	];
	const model = anthropicModel("claude-sonnet-4-5");

	it("reconstructs discovered set from history alone (no session-only state) and announces only new names per turn", () => {
		// Simulated transcript that grows turn-by-turn. Each tool_search
		// result block is appended to history, mirroring how Pi persists
		// the native tool_reference content blocks emitted by the
		// deferred-tool-search-tool.
		const history: Array<{ role: string; content: unknown[] }> = [];

		const noopActions = { getActiveToolNames: () => [], setActiveTools: () => undefined };

		// Turn 1: model asks for alpha. Previously discovered is reconstructed from empty history.
		let previouslyDiscovered = scanDiscoveredDeferredToolNames(history);
		expect(previouslyDiscovered).toEqual([]);
		let plan = executeDeferredToolSearchForModel(definitions, ["alpha"], model, noopActions, previouslyDiscovered);
		expect(plan.mode).toBe("native");
		expect(plan.referenceBlocks).toEqual([{ type: "tool_reference", name: "alpha" }]);
		history.push({ role: "tool", content: plan.referenceBlocks });

		// Turn 2: model asks for alpha + beta. Discovered set is rebuilt from history
		// (no session-only state); only beta is new, so only beta is announced.
		previouslyDiscovered = scanDiscoveredDeferredToolNames(history);
		expect(previouslyDiscovered).toEqual(["alpha"]);
		plan = executeDeferredToolSearchForModel(
			definitions,
			["alpha", "beta"],
			model,
			noopActions,
			previouslyDiscovered,
		);
		expect(plan.referenceBlocks).toEqual([{ type: "tool_reference", name: "beta" }]);
		history.push({ role: "tool", content: plan.referenceBlocks });

		// Turn 3: model asks for gamma; alpha+beta carry forward via history scan.
		previouslyDiscovered = scanDiscoveredDeferredToolNames(history);
		expect(previouslyDiscovered.sort()).toEqual(["alpha", "beta"]);
		plan = executeDeferredToolSearchForModel(definitions, ["gamma"], model, noopActions, previouslyDiscovered);
		expect(plan.referenceBlocks).toEqual([{ type: "tool_reference", name: "gamma" }]);
		history.push({ role: "tool", content: plan.referenceBlocks });

		// Final discovered set scanned from history covers everything that was announced.
		expect(scanDiscoveredDeferredToolNames(history).sort()).toEqual(["alpha", "beta", "gamma"]);
	});

	it("native mode never appends to the active tool list across the loop", () => {
		let activeCalls = 0;
		const actions = {
			getActiveToolNames: () => ["existing"],
			setActiveTools: (_: string[]) => {
				activeCalls++;
			},
		};
		executeDeferredToolSearchForModel(definitions, ["alpha"], model, actions, []);
		executeDeferredToolSearchForModel(definitions, ["alpha", "beta"], model, actions, ["alpha"]);
		executeDeferredToolSearchForModel(definitions, ["gamma"], model, actions, ["alpha", "beta"]);
		expect(activeCalls).toBe(0);
	});
});
