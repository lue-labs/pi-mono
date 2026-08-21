# Code conventions

Read when changing Pi behavior or TypeScript code in this fork.

## Extension-first architecture

- Add custom Pi functionality as a `my-pi` extension or Pi package first. Modify `packages/coding-agent` core only when documented extension/package APIs cannot express the behavior.
- Compose fork-only behavior through the documented extension seams (`removeAction`, `addAction`, `addFilter`, `applyFilters`). Keep environment and tool overrides in `~/Projects/personal/my-pi/extensions/native-tool-overrides/` unless core lacks the seam.
- Read only the relevant local docs and examples before a behavior change. Record the missing extension seam before changing core.
- When upstream changes a built-in tool wrapped by a local extension, compare the upstream tool with the wrapper and port improvements into the extension first.
- Load skill `matt-pocock` and use its `improve-codebase-architecture` reference. Keep simplifications local and incremental unless the task asks for a larger refactor.

## TypeScript and APIs

- Avoid `any`. Inspect external API definitions in `node_modules` instead of guessing at them.
- Inline single-line helpers that have one call site.
- Use top-level imports. Dynamic imports are allowed only where laziness is an intentional runtime or boot-performance boundary, and the mode-dispatch imports in `packages/coding-agent/src/main.ts` must stay as they are.
- Use erasable TypeScript syntax compatible with Node strip-only mode, which rules out anything requiring JavaScript emit:
	- parameter properties
	- `enum`
	- `namespace` and `module`
	- `import =` and `export =`
- Update the dependency rather than removing or downgrading intentional functionality to silence its type errors.
- Ask before removing functionality or code that appears intentional.
- Fork-only API backward compatibility is required only when the task asks for it. Preserve practical upstream behavioral compatibility.
- Keybindings must be configurable. Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` instead of hardcoding key checks.
- Never edit `packages/ai/src/models.generated.ts` or `packages/ai/src/image-models.generated.ts` by hand. Run the matching generator.

## Setup registry and resource pressure

Runtime, provider, cache, tool, or fork-patch changes update the canonical registry in `~/Projects/personal/my-pi/docs/pi-setup/`. Never hand-edit its generated files.

For child agents, tool/MCP loading, monitors, background commands, session storage, cache behavior, or cleanup, first read `~/Projects/personal/mac-resource-ops/VISION.md` and `~/Projects/personal/mac-resource-ops/docs/resource-graph.md`. Keep every job bounded and load tools lazily, then clean up explicitly once the work finishes.
