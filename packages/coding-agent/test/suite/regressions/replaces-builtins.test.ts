/**
 * Regression test for `ToolDefinition.replacesBuiltins`.
 *
 * native-tool-overrides registers capitalized aliases (Read/Edit/...) and
 * TaskOutput/TaskStop that fully supersede core base builtins (read/edit/...,
 * bash_output/bash_kill). Before this seam the lowercase originals stayed in
 * the registry as inactive duplicates — harmless in the daily driver (default
 * active set is the capitalized list) but resurrected by any consumer that
 * force-activates getAllTools() (e.g. rusty-wa), producing duplicate
 * Read/read schemas in the prompt.
 *
 * Fix: an override declares `replacesBuiltins: ["read"]`; _refreshToolRegistry
 * drops the named base builtins from the registry entirely. No declaration ⇒
 * base tools stay (upstream/vanilla unaffected). Deterministic per build, so
 * the tools[] prefix stays cache-stable.
 */
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

function registerReadOverride(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "Read",
		label: "Read",
		description: "Read override",
		parameters: Type.Object({}),
		alwaysLoad: true,
		replacesBuiltins: ["read"],
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});
}

describe("replacesBuiltins — overrides drop superseded core base builtins", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("removes the lowercase base builtin from the registry when an override declares it", async () => {
		const harness = await createHarness({ extensionFactories: [registerReadOverride] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		const allNames = harness.session.getAllTools().map((tool) => tool.name);
		expect(allNames).toContain("Read");
		expect(allNames).not.toContain("read");

		// Force-activating the whole registry must not resurrect the lowercase twin.
		harness.session.setActiveToolsByName(allNames);
		const active = harness.session.getActiveToolNames();
		expect(active).toContain("Read");
		expect(active).not.toContain("read");
	});

	it("keeps base builtins that nothing declares a replacement for", async () => {
		const harness = await createHarness({ extensionFactories: [] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		const allNames = harness.session.getAllTools().map((tool) => tool.name);
		expect(allNames).toContain("read");
	});
});
