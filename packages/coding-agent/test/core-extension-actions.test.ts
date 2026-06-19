import { describe, expect, test } from "vitest";
import "../src/core/extensions/core-extension-actions.ts";
import { getActions, load } from "../src/core/extensions/extension-hooks.ts";

describe("core extension actions", () => {
	test("registers the built-in background tasks UI hook", () => {
		expect(getActions(load).map((action) => action.id)).toContain("backgroundTasksUi");
	});
});
