/**
 * Message-delivered schema hydration (fork issue #348).
 *
 * On transports with `compat.supportsDeferredTools === false` (CC-adapter /
 * bridge-OAuth lane), activating a deferred tool must NOT mutate the request
 * tools[] (a full-prefix cache bust). Instead the activated tool's full schema
 * is delivered inside the tool-result as a `<functions>` block, and the executor
 * is registered append-only via `hydrateTools`.
 *
 * Coverage:
 *   - `messageDeliveredSchemas` capability is set only for the anthropic
 *     compat-disabled lane.
 *   - `planDeferredToolSearchForModel` picks `hydrate` mode: no active-list
 *     mutation (`activateToolNames: []`, `cacheMayBust: false`), emits
 *     `<functions>` schema blocks, and lists `hydrateToolNames`.
 *   - `executeDeferredToolSearchForModel` calls `hydrateTools`, never
 *     `setActiveTools` (proves tools[] byte-stability on activation).
 *   - The delivered schema block is in the documented `<functions>` shape and
 *     carries the tool's JSON schema, so the model can call it.
 */
import type { Api, Model } from "@valkyriweb/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getDeferredToolCapabilities } from "../src/core/deferred-tool-capabilities.ts";
import {
	buildDeferredToolSchemaBlock,
	executeDeferredToolSearchForModel,
	planDeferredToolSearchForModel,
} from "../src/core/deferred-tools.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";

function makeDefinition(name: string, options: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		label: name,
		description: options.description ?? `${name} description`,
		parameters: Type.Object({ query: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: name }] }),
		...options,
	} as ToolDefinition;
}

function ccAdapterModel(id = "claude-opus-4-8"): Model<Api> {
	const model: Model<Api> = {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "claude-bridge",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
	(model as { compat?: { supportsDeferredTools?: boolean } }).compat = { supportsDeferredTools: false };
	return model;
}

const definitions = [makeDefinition("Workflow", { deferLoading: true, description: "Run a dynamic workflow" })];

describe("getDeferredToolCapabilities — messageDeliveredSchemas flag", () => {
	it("is true for anthropic compat.supportsDeferredTools === false", () => {
		const caps = getDeferredToolCapabilities(ccAdapterModel());
		expect(caps.messageDeliveredSchemas).toBe(true);
		expect(caps.nativeDeferredTools).toBe(false);
	});

	it("is false for a native anthropic model", () => {
		const model: Model<Api> = { ...ccAdapterModel() };
		(model as { compat?: unknown }).compat = undefined;
		const caps = getDeferredToolCapabilities(model);
		expect(caps.messageDeliveredSchemas).toBe(false);
		expect(caps.nativeDeferredTools).toBe(true);
	});
});

describe("planDeferredToolSearchForModel — hydrate mode", () => {
	it("returns hydrate mode with schema blocks and no active-list mutation", () => {
		const plan = planDeferredToolSearchForModel(definitions, ["Workflow"], ccAdapterModel(), []);
		expect(plan.mode).toBe("hydrate");
		expect(plan.activateToolNames).toEqual([]);
		expect(plan.hydrateToolNames).toEqual(["Workflow"]);
		expect(plan.cacheMayBust).toBe(false);
		expect(plan.schemaBlocks).toHaveLength(1);

		const text = plan.schemaBlocks[0].text;
		expect(text).toContain("<functions>");
		expect(text).toContain("</functions>");
		expect(text).toContain("<function>");
		// The delivered function carries the tool's callable JSON schema.
		const json = text.slice(text.indexOf("<function>") + "<function>".length, text.indexOf("</function>"));
		const parsed = JSON.parse(json) as { name: string; parameters: unknown };
		expect(parsed.name).toBe("Workflow");
		expect(parsed.parameters).toEqual(expect.objectContaining({ type: "object" }));
	});
});

describe("executeDeferredToolSearchForModel — activation is cache-stable", () => {
	it("hydrates via hydrateTools and NEVER calls setActiveTools (tools[] byte-stable)", () => {
		const setActiveWrites: string[][] = [];
		const hydrateWrites: string[][] = [];
		const actions = {
			getActiveToolNames: () => ["Read", "Bash"],
			setActiveTools: (toolNames: string[]) => setActiveWrites.push(toolNames),
			hydrateTools: (toolNames: string[]) => hydrateWrites.push(toolNames),
		};
		const plan = executeDeferredToolSearchForModel(definitions, ["Workflow"], ccAdapterModel(), actions, []);
		expect(plan.mode).toBe("hydrate");
		// Acceptance (a): tools[] is not mutated on activation.
		expect(setActiveWrites).toEqual([]);
		// Acceptance (c): the tool is registered so it becomes callable.
		expect(hydrateWrites).toEqual([["Workflow"]]);
	});

	it("falls back to setActiveTools when the transport lacks message delivery (haiku)", () => {
		const setActiveWrites: string[][] = [];
		const hydrateWrites: string[][] = [];
		const model = ccAdapterModel("claude-haiku-4-5");
		const actions = {
			getActiveToolNames: () => ["Read"],
			setActiveTools: (toolNames: string[]) => setActiveWrites.push(toolNames),
			hydrateTools: (toolNames: string[]) => hydrateWrites.push(toolNames),
		};
		const plan = executeDeferredToolSearchForModel(definitions, ["Workflow"], model, actions, []);
		expect(plan.mode).toBe("fallback");
		expect(hydrateWrites).toEqual([]);
		expect(setActiveWrites).toHaveLength(1);
	});
});

describe("buildDeferredToolSchemaBlock", () => {
	it("wraps multiple tools in a single <functions> block", () => {
		const block = buildDeferredToolSchemaBlock([makeDefinition("a", { deferLoading: true }), makeDefinition("b")]);
		expect(block?.text.match(/<function>/g)).toHaveLength(2);
		expect(block?.text.startsWith("<functions>")).toBe(true);
	});

	it("returns undefined when there is nothing to deliver", () => {
		expect(buildDeferredToolSchemaBlock([])).toBeUndefined();
	});
});
