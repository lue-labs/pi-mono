import type { ExtensionFactory, ExtensionHookFilterMap, ExtensionHookName } from "./types.ts";

export const load = "load";

/** Named core filter hooks. The string overloads below preserve arbitrary extension hook names. */
export const extensionHookNames = {
	systemPromptBuild: "systemPrompt:build",
	modelResolve: "model:resolve",
	messageEnd: "message:end",
	providerBeforeRequest: "provider:beforeRequest",
} as const;

export interface Hook {
	name: string;
	description?: string;
}

export interface Action {
	hook: string;
	id: string;
	callback: ExtensionFactory;
	priority: number;
	order: number;
}

export type FilterCallback<T = unknown> = (value: T, ...args: unknown[]) => T | Promise<T>;

export interface Filter<T = unknown> {
	hook: string;
	id: string;
	callback: FilterCallback<T>;
	priority: number;
	order: number;
}

export type FilterErrorPolicy = "throw" | "continue";

export interface FilterChainDiagnostics {
	hook: string;
	filters: Array<Pick<Filter, "id" | "priority" | "order"> & { errorPolicy: FilterErrorPolicy }>;
}

interface FilterEntry {
	filter: Filter;
	errorPolicy: FilterErrorPolicy;
}

class FilterChain {
	readonly hook: string;
	private entries: FilterEntry[] = [];

	constructor(hook: string) {
		this.hook = hook;
	}

	add(filter: Filter, errorPolicy: FilterErrorPolicy = "throw"): void {
		const entry = { filter, errorPolicy };
		const existingIndex = this.entries.findIndex((candidate) => candidate.filter.id === filter.id);
		if (existingIndex === -1) {
			this.entries.push(entry);
		} else {
			this.entries[existingIndex] = entry;
		}
		this.entries.sort(
			(left, right) => left.filter.priority - right.filter.priority || left.filter.order - right.filter.order,
		);
	}

	remove(id: string): boolean {
		const next = this.entries.filter((entry) => entry.filter.id !== id);
		if (next.length === this.entries.length) return false;
		this.entries = next;
		return true;
	}

	isEmpty(): boolean {
		return this.entries.length === 0;
	}

	getFilters(): Filter[] {
		return this.entries.map((entry) => entry.filter);
	}

	getDiagnostics(): FilterChainDiagnostics {
		return {
			hook: this.hook,
			filters: this.entries.map(({ filter, errorPolicy }) => ({
				id: filter.id,
				priority: filter.priority,
				order: filter.order,
				errorPolicy,
			})),
		};
	}

	async apply<T>(value: T, args: unknown[]): Promise<T> {
		let current = value;
		for (const { filter, errorPolicy } of this.entries) {
			try {
				current = await (filter.callback as FilterCallback<T>)(current, ...args);
			} catch (error) {
				if (errorPolicy === "continue") continue;
				throw error;
			}
		}
		return current;
	}
}

const DEFAULT_PRIORITY = 10;
const hooks = new Map<string, Hook>();
const actions = new Map<string, Action[]>();
const filters = new Map<string, FilterChain>();
let nextActionOrder = 0;
let nextFilterOrder = 0;

export function registerHook<Name extends ExtensionHookName>(name: Name, options?: { description?: string }): Hook;
export function registerHook(name: string, options?: { description?: string }): Hook;
export function registerHook(name: string, options?: { description?: string }): Hook {
	const existing = hooks.get(name);
	if (existing) return existing;
	const hook = { name, description: options?.description };
	hooks.set(name, hook);
	return hook;
}

export function removeHook(name: string): void {
	hooks.delete(name);
	actions.delete(name);
	filters.delete(name);
}

export function hasHook(name: string): boolean {
	return hooks.has(name);
}

export function addAction(
	hook: string,
	id: string,
	callback: ExtensionFactory,
	options?: { priority?: number },
): () => void {
	if (!hasHook(hook)) registerHook(hook);
	const action = {
		hook,
		id,
		callback,
		priority: options?.priority ?? DEFAULT_PRIORITY,
		order: nextActionOrder++,
	};
	const hookActions = actions.get(hook) ?? [];
	const existingIndex = hookActions.findIndex((candidate) => candidate.id === id);
	if (existingIndex === -1) {
		hookActions.push(action);
	} else {
		hookActions[existingIndex] = action;
	}
	actions.set(hook, sortActions(hookActions));
	return () => removeAction(hook, id);
}

export function removeAction(hook: string, id: string): void {
	const hookActions = actions.get(hook);
	if (!hookActions) return;
	const next = hookActions.filter((action) => action.id !== id);
	if (next.length === 0) {
		actions.delete(hook);
		return;
	}
	actions.set(hook, next);
}

export function getActions(hook: string): Action[] {
	return [...(actions.get(hook) ?? [])];
}

export function addFilter<Name extends ExtensionHookName>(
	hook: Name,
	id: string,
	callback: FilterCallback<ExtensionHookFilterMap[Name]>,
	options?: { priority?: number },
): () => void;
export function addFilter<T = unknown>(
	hook: string,
	id: string,
	callback: FilterCallback<T>,
	options?: { priority?: number },
): () => void;
export function addFilter<T = unknown>(
	hook: string,
	id: string,
	callback: FilterCallback<T>,
	options?: { priority?: number },
): () => void {
	// CACHE CRITICAL: filter ids, priorities, and registration order affect
	// cache-bearing seams such as systemPrompt:build, provider:beforeRequest,
	// and message:end. Keep registrations deterministic across turns.
	if (!hasHook(hook)) registerHook(hook);
	const filter: Filter = {
		hook,
		id,
		callback: callback as FilterCallback,
		priority: options?.priority ?? DEFAULT_PRIORITY,
		order: nextFilterOrder++,
	};
	const chain = filters.get(hook) ?? new FilterChain(hook);
	chain.add(filter);
	filters.set(hook, chain);
	return () => removeFilter(hook, id);
}

export function removeFilter(hook: string, id: string): void {
	const chain = filters.get(hook);
	if (!chain) return;
	chain.remove(id);
	if (chain.isEmpty()) filters.delete(hook);
}

export function getFilters(hook: string): Filter[] {
	return filters.get(hook)?.getFilters() ?? [];
}

export function getFilterChainDiagnostics(hook: string): FilterChainDiagnostics | undefined {
	return filters.get(hook)?.getDiagnostics();
}

export function applyFilters<Name extends ExtensionHookName>(
	hook: Name,
	value: ExtensionHookFilterMap[Name],
	...args: unknown[]
): Promise<ExtensionHookFilterMap[Name]>;
export function applyFilters<T>(hook: string, value: T, ...args: unknown[]): Promise<T>;
export async function applyFilters<T>(hook: string, value: T, ...args: unknown[]): Promise<T> {
	const chain = filters.get(hook);
	return chain ? chain.apply(value, args) : value;
}

export function actionSource(action: Action): string {
	// `<builtin:hook:...>` makes SourceInfo.source resolve to "builtin" via
	// createExtension's synthetic-path parser, so noTools:"builtin" and default
	// activation rules still treat these action-registered tools as built-ins.
	return `<builtin:hook:${action.hook}:${action.id}>`;
}

export function isHookPath(extensionPath: string): boolean {
	return extensionPath.startsWith("<builtin:hook:");
}

function sortActions(hookActions: Action[]): Action[] {
	return [...hookActions].sort((left, right) => left.priority - right.priority || left.order - right.order);
}

registerHook(load, {
	description: "Attach Pi's default extension behavior before sessions start.",
});
