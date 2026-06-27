/**
 * Test mirror of `my-pi/extensions/native-tool-overrides`.
 *
 * Registers production-style names for Read/Edit/Write/Grep/Glob/Ls so tests that
 * depend on these tools as builtins (the production reality, via my-pi-full)
 * can run without the on-disk extension being installed.
 *
 * Marked `alwaysLoad: true` to survive `_refreshToolRegistry`'s builtin-preservation
 * after the names were removed from core `allToolNames` in PR #1C.
 */
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import {
	createEditToolDefinition,
	createGlobToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "../src/core/tools/index.ts";

const factories = [
	{ name: "Read", make: createReadToolDefinition },
	{ name: "Edit", make: createEditToolDefinition },
	{ name: "Write", make: createWriteToolDefinition },
	{ name: "Grep", make: createGrepToolDefinition },
	{ name: "Glob", make: createGlobToolDefinition },
	{ name: "Ls", make: createLsToolDefinition },
] as const;

export const nativeToolAliasesFactory: ExtensionFactory = (pi) => {
	for (const { name, make } of factories) {
		// Tool definitions are heterogeneous (different schemas/detail types).
		// Cast each to the registerTool parameter type to register them through
		// one code path.
		const def = make(process.cwd()) as unknown as Parameters<typeof pi.registerTool>[0];
		pi.registerTool({ ...def, name, label: name, alwaysLoad: true });
	}
};
