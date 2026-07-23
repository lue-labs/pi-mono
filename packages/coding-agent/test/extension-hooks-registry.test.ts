import { afterEach, describe, expect, it } from "vitest";
import {
	addAction,
	addFilter,
	applyFilters,
	getActions,
	getFilterChainDiagnostics,
	getFilters,
	removeHook,
} from "../src/core/extensions/extension-hooks.ts";

const hookNames = new Set<string>();

function createHookName(): string {
	const name = `test:extension-hooks:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	hookNames.add(name);
	return name;
}

afterEach(() => {
	for (const hookName of hookNames) removeHook(hookName);
	hookNames.clear();
});

describe("extension hook registry", () => {
	it("orders filters by ascending priority, then registration order", async () => {
		const hookName = createHookName();
		addFilter(hookName, "first-default", (value: string) => `${value}A`);
		addFilter(hookName, "earlier-priority", (value: string) => `${value}B`, { priority: 5 });
		addFilter(hookName, "second-default", (value: string) => `${value}C`);

		expect(getFilterChainDiagnostics(hookName)?.filters.map((filter) => [filter.id, filter.errorPolicy])).toEqual([
			["earlier-priority", "throw"],
			["first-default", "throw"],
			["second-default", "throw"],
		]);
		expect(getFilters(hookName).map((filter) => filter.id)).toEqual([
			"earlier-priority",
			"first-default",
			"second-default",
		]);
		expect(await applyFilters(hookName, "")).toBe("BAC");
	});

	it("replaces duplicate action ids with a newly ordered registration", async () => {
		const hookName = createHookName();
		const called: string[] = [];
		addAction(hookName, "replace", () => {
			called.push("first");
		});
		addAction(hookName, "peer", () => {
			called.push("peer");
		});
		addAction(hookName, "replace", () => {
			called.push("replacement");
		});

		const actions = getActions(hookName);
		expect(actions.map((action) => action.id)).toEqual(["peer", "replace"]);
		for (const action of actions) await action.callback({} as never);
		expect(called).toEqual(["peer", "replacement"]);
	});

	it("replaces duplicate filter ids with a newly ordered registration", async () => {
		const hookName = createHookName();
		addFilter(hookName, "replace", (value: string) => `${value}first`);
		addFilter(hookName, "peer", (value: string) => `${value}peer`);
		addFilter(hookName, "replace", (value: string) => `${value}replacement`);

		expect(getFilters(hookName).map((filter) => filter.id)).toEqual(["peer", "replace"]);
		expect(await applyFilters(hookName, "")).toBe("peerreplacement");
	});

	it("disposes only the registration returned by addFilter", async () => {
		const hookName = createHookName();
		const disposeFirst = addFilter(hookName, "first", (value: string) => `${value}first`);
		addFilter(hookName, "second", (value: string) => `${value}second`);

		disposeFirst();

		expect(getFilters(hookName).map((filter) => filter.id)).toEqual(["second"]);
		expect(await applyFilters(hookName, "")).toBe("second");
	});

	it("awaits each filter before starting the next one", async () => {
		const hookName = createHookName();
		const events: string[] = [];
		addFilter(hookName, "first", async (value: string) => {
			events.push("first:start");
			await Promise.resolve();
			events.push("first:end");
			return `${value}first`;
		});
		addFilter(hookName, "second", (value: string) => {
			events.push("second");
			return `${value}second`;
		});

		expect(await applyFilters(hookName, "")).toBe("firstsecond");
		expect(events).toEqual(["first:start", "first:end", "second"]);
	});

	it("uses the registrations that existed when the chain started", async () => {
		const hookName = createHookName();
		addFilter(hookName, "first", (value: string) => {
			addFilter(hookName, "added-during-apply", (next: string) => `${next}B`);
			return `${value}A`;
		});

		expect(await applyFilters(hookName, "")).toBe("A");
		expect(await applyFilters(hookName, "")).toBe("AB");
	});

	it("preserves an explicit undefined result from a filter", async () => {
		const hookName = createHookName();
		addFilter<string | undefined>(hookName, "undefined", () => undefined);

		expect(await applyFilters<string | undefined>(hookName, "value")).toBeUndefined();
	});

	it("fails fast and does not run later filters", async () => {
		const hookName = createHookName();
		const error = new Error("filter failed");
		let laterFilterRan = false;
		addFilter(hookName, "failing", () => {
			throw error;
		});
		addFilter(hookName, "later", (value: string) => {
			laterFilterRan = true;
			return value;
		});

		await expect(applyFilters(hookName, "value")).rejects.toBe(error);
		expect(laterFilterRan).toBe(false);
	});
});
