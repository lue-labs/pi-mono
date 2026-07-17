import { describe, expect, test } from "vitest";
import {
	discoverDeferredTools,
	getDeferredToolSearchToolNames,
	searchDeferredTools,
} from "../src/core/deferred-tools.js";
import type { ToolDefinition } from "../src/core/extensions/types.js";

function tool(name: string, description: string, searchHint?: string): ToolDefinition {
	return {
		name,
		label: name,
		description,
		searchHint,
		deferLoading: true,
		parameters: {} as ToolDefinition["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}

describe("searchDeferredTools", () => {
	test("select: returns exact deferred tools in requested order", () => {
		const results = searchDeferredTools(
			[tool("Read", "read files"), tool("Screenshot", "capture windows"), tool("Click", "click UI")],
			"select:Click,Screenshot",
		);
		expect(results.map((result) => result.name)).toEqual(["Click", "Screenshot"]);
	});

	test("select: preserves missing requested names for clear unavailable reporting", () => {
		const definitions = [tool("Screenshot", "capture windows")];
		const requestedNames = getDeferredToolSearchToolNames(definitions, "select:Missing,Screenshot");
		const discovery = discoverDeferredTools(definitions, requestedNames);

		expect(requestedNames).toEqual(["Missing", "Screenshot"]);
		expect(discovery.matches.map((result) => result.name)).toEqual(["Screenshot"]);
		expect(discovery.missing).toEqual(["Missing"]);
	});

	test("+tokens gate matches before ranked scoring", () => {
		const results = searchDeferredTools(
			[
				tool("Screenshot", "capture macOS windows"),
				tool("Click", "click UI elements", "mouse ui"),
				tool("ListApps", "list running macOS apps"),
			],
			"+ui macOS",
		);
		expect(results.map((result) => result.name)).toEqual(["Click"]);
	});

	test("scores name matches above description matches and tie-breaks alphabetically", () => {
		const results = searchDeferredTools(
			[tool("Beta", "alpha helper"), tool("Alpha", "generic helper"), tool("Alphard", "generic helper")],
			"alpha",
			2,
		);
		expect(results.map((result) => result.name)).toEqual(["Alpha", "Alphard"]);
	});
});
