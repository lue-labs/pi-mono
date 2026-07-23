import type {
	ExtensionFactory,
	ExtensionFilter,
	ExtensionHookHandle,
	ExtensionHooksAPI,
} from "../src/core/extensions/types.ts";

type TestAction = { id: string; action: ExtensionFactory; priority: number; order: number };
type TestFilter = { id: string; filter: ExtensionFilter; priority: number; order: number };

export interface FakeHooksAPI {
	hooks: ExtensionHooksAPI;
	actions(name: string): readonly TestAction[];
	filters(name: string): readonly TestFilter[];
}

/** Isolated hook registry for extension tests that do not need an ExtensionRunner. */
export function createFakeHooksAPI(): FakeHooksAPI {
	const actions = new Map<string, TestAction[]>();
	const filters = new Map<string, TestFilter[]>();
	let nextActionOrder = 0;
	let nextFilterOrder = 0;

	const sort = <T extends { priority: number; order: number }>(entries: T[]): T[] =>
		[...entries].sort((left, right) => left.priority - right.priority || left.order - right.order);
	const remove = <T extends { id: string }>(registry: Map<string, T[]>, name: string, id: string): void => {
		const entries = registry.get(name);
		if (!entries) return;
		const next = entries.filter((entry) => entry.id !== id);
		if (next.length === 0) registry.delete(name);
		else registry.set(name, next);
	};
	const handle = <Name extends string>(name: Name): ExtensionHookHandle<Name> => ({
		name,
		action(id, action, options) {
			return hooks.addAction(name, id, action, options);
		},
		filter(id, filter, options) {
			return hooks.addFilter(name, id, filter, options);
		},
		removeAction(id) {
			hooks.removeAction(name, id);
		},
		removeFilter(id) {
			hooks.removeFilter(name, id);
		},
		unregister() {
			actions.delete(name);
			filters.delete(name);
		},
	});
	const hooks: ExtensionHooksAPI = {
		register<Name extends string>(name: Name, _options?: { description?: string }): ExtensionHookHandle<Name> {
			return handle(name);
		},
		get<Name extends string>(name: Name): ExtensionHookHandle<Name> {
			return handle(name);
		},
		unregister(name) {
			actions.delete(name);
			filters.delete(name);
		},
		addAction(name, id, action, options) {
			const entry = { id, action, priority: options?.priority ?? 10, order: nextActionOrder++ };
			const existing = actions.get(name) ?? [];
			const index = existing.findIndex((candidate) => candidate.id === id);
			if (index === -1) existing.push(entry);
			else existing[index] = entry;
			actions.set(name, sort(existing));
			return () => remove(actions, name, id);
		},
		removeAction(name, id) {
			remove(actions, name, id);
		},
		addFilter<T = unknown>(name: string, id: string, filter: ExtensionFilter<T>, options?: { priority?: number }) {
			const entry: TestFilter = {
				id,
				filter: filter as ExtensionFilter,
				priority: options?.priority ?? 10,
				order: nextFilterOrder++,
			};
			const existing = filters.get(name) ?? [];
			const index = existing.findIndex((candidate) => candidate.id === id);
			if (index === -1) existing.push(entry);
			else existing[index] = entry;
			filters.set(name, sort(existing));
			return () => remove(filters, name, id);
		},
		removeFilter(name, id) {
			remove(filters, name, id);
		},
		async applyFilters<T = unknown>(name: string, value: T, ...args: unknown[]): Promise<T> {
			let current = value;
			for (const entry of [...(filters.get(name) ?? [])]) current = (await entry.filter(current, ...args)) as T;
			return current;
		},
	};

	return {
		hooks,
		actions(name) {
			return actions.get(name) ?? [];
		},
		filters(name) {
			return filters.get(name) ?? [];
		},
	};
}
