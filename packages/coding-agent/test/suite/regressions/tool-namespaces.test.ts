import { type Context, fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

function registerTool(pi: ExtensionAPI, name: string, opts: { deferLoading?: boolean } = {}): void {
	pi.registerTool({
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({}),
		deferLoading: opts.deferLoading,
		execute: async () => ({ content: [{ type: "text", text: `${name} ok` }] }),
	});
}

describe("setToolNamespaces (post-registration namespace seam)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup(): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					registerTool(pi, "ctx_search", { deferLoading: true });
					registerTool(pi, "ctx_index", { deferLoading: true });
					registerTool(pi, "plain_read");
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("stamps the namespace label onto named tool definitions; unnamed tools untouched", async () => {
		const harness = await setup();
		const session = harness.session;
		expect(session.getToolDefinition("ctx_search")?.namespace).toBeUndefined();

		session.setToolNamespaces({ ctx_search: "context", ctx_index: "context" });

		expect(session.getToolDefinition("ctx_search")?.namespace).toBe("context");
		expect(session.getToolDefinition("ctx_index")?.namespace).toBe("context");
		expect(session.getToolDefinition("plain_read")?.namespace).toBeUndefined();
	});

	it("does not change deferLoading or any other tool behavior (pure metadata)", async () => {
		const harness = await setup();
		const session = harness.session;
		session.setToolNamespaces({ ctx_search: "context" });
		expect(session.getToolDefinition("ctx_search")?.deferLoading).toBe(true);
		expect(session.getToolDefinition("plain_read")?.deferLoading).toBeFalsy();
	});

	it("surfaces the namespace on the serialized provider request tools[]", async () => {
		const harness = await setup();
		harness.session.setToolNamespaces({ ctx_search: "context" });

		let captured: Array<{ name: string; namespace?: string }> = [];
		harness.setResponses([
			(context: Context) => {
				captured = (context.tools ?? []).map((tool) => ({
					name: tool.name,
					namespace: (tool as { namespace?: string }).namespace,
				}));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("go");

		const entry = captured.find((tool) => tool.name === "ctx_search");
		expect(entry, "ctx_search should be present in serialized tools[]").toBeDefined();
		expect(entry?.namespace).toBe("context");
	});

	it("ignores empty-string namespaces and names that do not resolve to a tool", async () => {
		const harness = await setup();
		const session = harness.session;
		session.setToolNamespaces({ ctx_search: "", does_not_exist: "ghost" });
		expect(session.getToolDefinition("ctx_search")?.namespace).toBeUndefined();
	});

	it("is idempotent — an unchanged map does not rebuild the registry (cache-critical)", async () => {
		const harness = await setup();
		const session = harness.session;
		session.setToolNamespaces({ ctx_search: "context" });
		const definitionBefore = session.getToolDefinition("ctx_search");

		session.setToolNamespaces({ ctx_search: "context" });

		// A refresh rebuilds _toolDefinitions with fresh shallow-copied objects; an
		// unchanged map must NOT refresh, so the reference stays identical.
		expect(session.getToolDefinition("ctx_search")).toBe(definitionBefore);
	});

	it("clears the namespace when a name is dropped from the map", async () => {
		const harness = await setup();
		const session = harness.session;
		session.setToolNamespaces({ ctx_search: "context" });
		expect(session.getToolDefinition("ctx_search")?.namespace).toBe("context");

		session.setToolNamespaces({});

		expect(session.getToolDefinition("ctx_search")?.namespace).toBeUndefined();
	});
});
