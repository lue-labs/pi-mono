import { describe, expect, test } from "vitest";
import { TOOL_SEARCH_NAME } from "../src/core/deferred-tool-search-tool.js";
import { getDeferredToolSearchToolNames, searchDeferredTools } from "../src/core/deferred-tools.js";
import type { ToolDefinition } from "../src/core/extensions/types.js";

function deferredTool(name: string, description: string, searchHint?: string): ToolDefinition {
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

const catalog = [
	deferredTool("screenshot", "Capture screenshots of macOS windows and browser UI", "screen capture window"),
	deferredTool("click", "Click in the current window using coordinates or AX targets", "mouse ui browser"),
	deferredTool("list_windows", "List controllable macOS windows", "window ui"),
	deferredTool("list_apps", "List running macOS apps", "applications windows"),
	deferredTool("subagent", "Delegate work to configured subagents", "agent delegation"),
	deferredTool("intercom", "Send a message to another pi session", "coordinate session message"),
	deferredTool("log_experiment", "Record an experiment result", "autoresearch metric"),
	deferredTool("init_experiment", "Initialize an experiment session", "autoresearch metric"),
	deferredTool("context_checkout", "Return to a saved conversation checkpoint", "context checkpoint"),
	deferredTool("context_tag", "Save a conversation checkpoint", "context checkpoint"),
	deferredTool("type_text", "Type text into the focused control", "keyboard input"),
	deferredTool("set_text", "Replace a text control value", "keyboard input"),
	deferredTool("drag", "Drag the pointer along a path", "mouse move pointer"),
];

describe("native ToolSearch eval parity", () => {
	test.each([
		["exact-select-screenshot", "select:screenshot", ["screenshot"]],
		["keyword-browser-ui", "browser ui screenshots clicking windows", ["click", "screenshot", "list_windows"]],
		["no-match-query", "definitely_not_a_real_tool_90210", []],
		["duplicate-activation-idempotent", "select:screenshot", ["screenshot"]],
		["prompt-shape-deferred-block", "capturing screen", ["screenshot"]],
		["screenshot-direct", "screenshot active window", ["screenshot"]],
		["click-direct", "click coordinates window", ["click"]],
		["subagent-delegation", "select:subagent", ["subagent"]],
		["intercom-coordinate", "message other pi session", ["intercom"]],
		["experiment-log", "select:log_experiment", ["log_experiment"]],
		["context-checkout", "select:context_checkout", ["context_checkout"]],
		["context-tag", "select:context_tag", ["context_tag"]],
		["type-text-window", "type text focused text field", ["type_text", "set_text"]],
		["list-windows", "list macOS windows", ["list_windows", "list_apps"]],
		["drag-ui", "select:drag", ["drag"]],
	])("%s", (_id, query, acceptableActivations) => {
		const results = getDeferredToolSearchToolNames(catalog, query, 5);
		if (acceptableActivations.length === 0) {
			expect(results).toEqual([]);
		} else {
			expect(results.some((name) => acceptableActivations.includes(name))).toBe(true);
		}
	});

	test("direct select reports missing tools in requested order", () => {
		expect(getDeferredToolSearchToolNames(catalog, "select:missing,screenshot,drag", 5)).toEqual([
			"missing",
			"screenshot",
			"drag",
		]);
	});

	test("required token gate, max_results, and alphabetic tie-break match native DSL", () => {
		expect(searchDeferredTools(catalog, "+window ui", 2).map((tool) => tool.name)).toEqual([
			"list_windows",
			"screenshot",
		]);
	});

	test("native tool name is PascalCase ToolSearch", () => {
		expect(TOOL_SEARCH_NAME).toBe("ToolSearch");
	});
});
