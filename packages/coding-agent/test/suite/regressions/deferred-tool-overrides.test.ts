import { type Context, fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

function registerTool(
	pi: ExtensionAPI,
	name: string,
	opts: { alwaysLoad?: boolean; deferLoading?: boolean } = {},
): void {
	pi.registerTool({
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({}),
		alwaysLoad: opts.alwaysLoad,
		deferLoading: opts.deferLoading,
		execute: async () => ({ content: [{ type: "text", text: `${name} ok` }], details: {} }),
	});
}

describe("setDeferredToolOverrides (post-registration deferral seam)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup(): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					registerTool(pi, "fake_overridable");
					registerTool(pi, "fake_always", { alwaysLoad: true });
					registerTool(pi, "fake_native_defer", { deferLoading: true });
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("forces deferLoading on named tools, skipping alwaysLoad and already-deferred tools", async () => {
		const harness = await setup();
		const session = harness.session;
		expect(session.getToolDefinition("fake_overridable")?.deferLoading).toBeFalsy();

		session.setDeferredToolOverrides(["fake_overridable", "fake_always", "fake_native_defer"]);

		// Plain tool is forced into a deferred stub.
		expect(session.getToolDefinition("fake_overridable")?.deferLoading).toBe(true);
		// alwaysLoad tools are never overridden.
		expect(session.getToolDefinition("fake_always")?.deferLoading).toBeFalsy();
		expect(session.getToolDefinition("fake_always")?.alwaysLoad).toBe(true);
		// Tools already deferLoading on their own stay deferred (left untouched).
		expect(session.getToolDefinition("fake_native_defer")?.deferLoading).toBe(true);
	});

	it("serializes the overridden tool as a defer_loading stub in the provider request", async () => {
		const harness = await setup();
		harness.session.setDeferredToolOverrides(["fake_overridable"]);

		let captured: Array<{ name: string; deferLoading?: boolean }> = [];
		harness.setResponses([
			(context: Context) => {
				captured = (context.tools ?? []).map((tool) => ({ name: tool.name, deferLoading: tool.deferLoading }));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("go");

		const entry = captured.find((tool) => tool.name === "fake_overridable");
		expect(entry, "fake_overridable should be present in the serialized tools[]").toBeDefined();
		expect(entry?.deferLoading).toBe(true);
	});

	it("is idempotent — an unchanged override set does not rebuild the registry (cache-critical)", async () => {
		const harness = await setup();
		const session = harness.session;
		session.setDeferredToolOverrides(["fake_overridable"]);
		const definitionBefore = session.getToolDefinition("fake_overridable");

		session.setDeferredToolOverrides(["fake_overridable"]);

		// A refresh rebuilds _toolDefinitions with fresh shallow-copied objects;
		// an unchanged set must NOT refresh, so the reference stays identical.
		expect(session.getToolDefinition("fake_overridable")).toBe(definitionBefore);
	});

	it("restores the original deferLoading when a name is dropped from the override", async () => {
		const harness = await setup();
		const session = harness.session;
		session.setDeferredToolOverrides(["fake_overridable"]);
		expect(session.getToolDefinition("fake_overridable")?.deferLoading).toBe(true);

		session.setDeferredToolOverrides([]);

		expect(session.getToolDefinition("fake_overridable")?.deferLoading).toBeFalsy();
	});
});
