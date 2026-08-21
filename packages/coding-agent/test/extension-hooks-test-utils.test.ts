import { describe, expect, it } from "vitest";
import { createFakeHooksAPI } from "./extension-hooks-test-utils.ts";

describe("createFakeHooksAPI", () => {
	it("isolates extension filter registration while preserving priority and composition", async () => {
		const first = createFakeHooksAPI();
		const second = createFakeHooksAPI();
		first.hooks.addFilter("systemPrompt:build", "later", (value) => `${value}B`, { priority: 20 });
		first.hooks.addFilter("systemPrompt:build", "earlier", (value) => `${value}A`, { priority: 5 });
		second.hooks.addFilter("systemPrompt:build", "other", (value) => `${value}C`);

		expect(first.filters("systemPrompt:build").map((filter) => filter.id)).toEqual(["earlier", "later"]);
		expect(await first.hooks.applyFilters("systemPrompt:build", "")).toBe("AB");
		expect(await second.hooks.applyFilters("systemPrompt:build", "")).toBe("C");
	});
});
