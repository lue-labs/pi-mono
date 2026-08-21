import { type Context, fauxAssistantMessage, fauxToolCall } from "@lue-labs/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

function registerFakeTool(pi: ExtensionAPI, name: string): void {
	pi.registerTool({
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: `${name} ok` }],
		}),
	});
}

describe("deferred tool activation refresh", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("exposes a tool activated by another tool to the next provider request in the same run", async () => {
		const seenToolNames: string[][] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					registerFakeTool(pi, "fake_deferred_echo");
					pi.registerTool({
						name: "tool_search",
						label: "Tool Search",
						description: "Activate deferred tools",
						parameters: Type.Object({ query: Type.String() }),
						execute: async () => {
							pi.setActiveTools(["tool_search", "fake_deferred_echo"]);
							return {
								content: [{ type: "text", text: "Activated 1 tool: fake_deferred_echo" }],
							};
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// setActiveToolsByName preserves previously-active builtin tools per
		// Fix #3 (cache-break-investigation-2026-05-16.md). Assert on the
		// extension-tool surface, not exact set, so the test reflects the
		// production-correct cache-stable spec.
		harness.session.setActiveToolsByName(["tool_search"]);
		expect(harness.session.getActiveToolNames()).toContain("tool_search");

		harness.setResponses([
			(context: Context) => {
				seenToolNames.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "fake echo" }));
			},
			(context: Context) => {
				seenToolNames.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage(fauxToolCall("fake_deferred_echo", {}));
			},
			(context: Context) => {
				seenToolNames.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("activate and use fake echo");

		// The activation behaviour under test: tool_search is exposed turn 1;
		// fake_deferred_echo becomes exposed from turn 2 onwards. Builtins
		// (preserved by Fix #3) may also be present — not asserted here.
		expect(seenToolNames[0]).toContain("tool_search");
		expect(seenToolNames[0]).not.toContain("fake_deferred_echo");
		expect(seenToolNames[1]).toContain("tool_search");
		expect(seenToolNames[1]).toContain("fake_deferred_echo");
		expect(seenToolNames[2]).toContain("tool_search");
		expect(seenToolNames[2]).toContain("fake_deferred_echo");
		expect(harness.session.getActiveToolNames()).toContain("tool_search");
		expect(harness.session.getActiveToolNames()).toContain("fake_deferred_echo");
	});

	it("handles grouped activation without duplicate active tools", async () => {
		const seenToolNames: string[][] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					registerFakeTool(pi, "fake_deferred_one");
					registerFakeTool(pi, "fake_deferred_two");
					pi.registerTool({
						name: "tool_search",
						label: "Tool Search",
						description: "Activate deferred tools",
						parameters: Type.Object({ query: Type.String() }),
						execute: async () => {
							pi.setActiveTools(["tool_search", "fake_deferred_one", "fake_deferred_two", "fake_deferred_one"]);
							return { content: [{ type: "text", text: "Activated 2 tools" }] };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.session.setActiveToolsByName(["tool_search"]);

		harness.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "select:fake_deferred_one,fake_deferred_two" })),
			(context: Context) => {
				seenToolNames.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("activate both fake tools");

		// The grouped-activation behaviour under test: both deferred tools end
		// up active without duplication. Builtins (preserved by Fix #3) may
		// also be present — not asserted here.
		expect(seenToolNames[0]).toContain("tool_search");
		expect(seenToolNames[0]).toContain("fake_deferred_one");
		expect(seenToolNames[0]).toContain("fake_deferred_two");
		const activeAfter = harness.session.getActiveToolNames();
		expect(activeAfter).toContain("tool_search");
		expect(activeAfter).toContain("fake_deferred_one");
		expect(activeAfter).toContain("fake_deferred_two");
		// No duplicates (Set-shaped result).
		expect(new Set(activeAfter).size).toBe(activeAfter.length);
	});
});
