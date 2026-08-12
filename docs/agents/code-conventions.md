# Code conventions

Read when changing Pi behavior or TypeScript code in this fork.

## Extension-first architecture

- Add custom Pi functionality as a `my-pi` extension or Pi package first. Modify `packages/coding-agent` core only when documented extension/package APIs cannot express the behavior.
- Prefer extension hooks, actions, and filters—`removeAction`, `addAction`, `addFilter`, and `applyFilters`—for fork-only composition. Keep environment and tool overrides in `~/Projects/personal/my-pi/extensions/native-tool-overrides/` unless core lacks the seam.
- Read only the relevant local docs and examples before a behavior change. Record the missing extension seam before changing core.
- When upstream changes a built-in tool wrapped by a local extension, compare the upstream tool with the wrapper and port improvements into the extension first.
- Load skill `matt-pocock` and use its `improve-codebase-architecture` reference; apply only local, incremental simplifications unless the task requests a larger refactor.

## TypeScript and APIs

- Avoid `any`; inspect external API definitions in `node_modules` instead of guessing.
- Inline single-line helpers that have one call site.
- Use top-level imports. Dynamic imports are allowed only where laziness is an intentional runtime or boot-performance boundary; preserve the mode-dispatch imports in `packages/coding-agent/src/main.ts`.
- Use erasable TypeScript syntax compatible with Node strip-only mode. Avoid parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, and syntax that requires JavaScript emit.
- Do not remove or downgrade intentional functionality to fix dependency type errors; update the dependency instead.
- Ask before removing functionality or code that appears intentional.
- Fork-only API backward compatibility is required only when the task asks for it. Preserve practical upstream behavioral compatibility.
- Keybindings must be configurable. Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`; do not hardcode key checks.
- Never edit `packages/ai/src/models.generated.ts` or `packages/ai/src/image-models.generated.ts` directly; use the corresponding generator.

## Setup registry and resource pressure

Runtime, provider, cache, tool, or fork-patch changes update the canonical registry in `~/Projects/personal/my-pi/docs/pi-setup/`. Never hand-edit its generated files.

For child agents, tool/MCP loading, monitors, background commands, session storage, cache behavior, or cleanup, first read `~/Projects/personal/mac-resource-ops/VISION.md` and `~/Projects/personal/mac-resource-ops/docs/resource-graph.md`. Prefer bounded jobs, lazy/deferred tools, and explicit cleanup.
