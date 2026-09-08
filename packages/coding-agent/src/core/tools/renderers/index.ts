/**
 * Built-in tool renderers, without the tools themselves.
 *
 * A presentation displays tool calls and results; it does not execute them and does not need their
 * typebox parameter schemas. Importing this instead of `core/tools/index.ts` keeps ~17 MB of module
 * graph out of a process that only renders.
 */

import type { ToolDefinition } from "../../extensions/types.ts";
import type { ToolName } from "../index.ts";
import { createShellRenderers } from "./bash.ts";
import { editRenderers } from "./edit.ts";
import { createGlobRenderers, globRenderers } from "./glob.ts";
import { grepRenderers } from "./grep.ts";
import { lsRenderers } from "./ls.ts";
import { readRenderers } from "./read.ts";
import { writeRenderers } from "./write.ts";

export type ToolRenderers = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;

export {
	createGlobRenderers,
	createShellRenderers,
	editRenderers,
	globRenderers,
	grepRenderers,
	lsRenderers,
	readRenderers,
	writeRenderers,
};

/**
 * Renderers for the built-in tools that ship one here, keyed by tool name.
 *
 * Partial by design: tools registered under more than one name (`bash`/`Bash`) share an entry, and
 * tools whose renderer still lives beside the implementation (the agent tools, whose renderers close
 * over live parent-session accessors) have none. `withBuiltInRenderers` treats a miss as "the
 * definition already renders itself".
 */
export function createAllToolRenderers(): Partial<Record<ToolName, ToolRenderers>> {
	return {
		read: readRenderers,
		bash: createShellRenderers("$"),
		Bash: createShellRenderers("$"),
		powershell: createShellRenderers("PS>"),
		edit: editRenderers,
		write: writeRenderers,
		grep: grepRenderers,
		Glob: globRenderers,
		ls: lsRenderers,
	};
}

/**
 * Merge built-in renderers into a tool definition that does not supply its own.
 *
 * `ToolExecutionComponent` used to do this lookup itself, which forced every presentation to import
 * the tool implementations. Callers do it now, so a process that renders can import renderers alone.
 */
export function withBuiltInRenderers<TDefinition extends ToolRenderers>(
	toolName: string,
	definition: TDefinition | undefined,
): TDefinition | ToolRenderers | undefined {
	const builtIn = createAllToolRenderers()[toolName as ToolName];
	if (!definition) return builtIn;
	if (!builtIn) return definition;
	return {
		...definition,
		renderCall: definition.renderCall ?? builtIn.renderCall,
		renderResult: definition.renderResult ?? builtIn.renderResult,
	};
}
