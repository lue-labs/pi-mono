import { type Context, fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.js";
import { createHarness, type Harness } from "../harness.js";

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
						name: "ToolSearch",
						label: "Tool Search",
						description: "Activate deferred tools",
						parameters: Type.Object({ query: Type.String() }),
						execute: async () => {
							pi.setActiveTools(["ToolSearch", "fake_deferred_echo"]);
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
		harness.session.setActiveToolsByName(["ToolSearch"]);
		expect(harness.session.getActiveToolNames()).toEqual(["ToolSearch"]);

		harness.setResponses([
			(context: Context) => {
				seenToolNames.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage(fauxToolCall("ToolSearch", { query: "fake echo" }));
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

		expect(seenToolNames[0]).toEqual(["ToolSearch"]);
		expect(seenToolNames[1]).toEqual(["ToolSearch", "fake_deferred_echo"]);
		expect(seenToolNames[2]).toEqual(["ToolSearch", "fake_deferred_echo"]);
		expect(harness.session.getActiveToolNames()).toEqual(["ToolSearch", "fake_deferred_echo"]);
	});

	it("handles grouped activation without duplicate active tools", async () => {
		const seenToolNames: string[][] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					registerFakeTool(pi, "fake_deferred_one");
					registerFakeTool(pi, "fake_deferred_two");
					pi.registerTool({
						name: "ToolSearch",
						label: "Tool Search",
						description: "Activate deferred tools",
						parameters: Type.Object({ query: Type.String() }),
						execute: async () => {
							pi.setActiveTools(["ToolSearch", "fake_deferred_one", "fake_deferred_two", "fake_deferred_one"]);
							return { content: [{ type: "text", text: "Activated 2 tools" }] };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.session.setActiveToolsByName(["ToolSearch"]);

		harness.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("ToolSearch", { query: "select:fake_deferred_one,fake_deferred_two" })),
			(context: Context) => {
				seenToolNames.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("activate both fake tools");

		expect(seenToolNames[0]).toEqual(["ToolSearch", "fake_deferred_one", "fake_deferred_two"]);
		expect(harness.session.getActiveToolNames()).toEqual(["ToolSearch", "fake_deferred_one", "fake_deferred_two"]);
	});
});
