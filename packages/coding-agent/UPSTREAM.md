# Imported code provenance

This package remains a fork of `earendil-works/pi-mono`. The records below cover code imported from other sources into the fork; they do not describe the package's full origin.

## prime-agent tool panel

- Upstream: <https://github.com/PrimeIntellect-ai/prime-agent>
- Package: `prime-agent`
- Forked from: `v0.7.0` (`be9e2fa0714e7cd1c6bd9bdb1b554d2cc6550387`)
- License: MIT, Copyright (c) 2025 Mario Zechner and Copyright (c) 2026 Prime Intellect — kept in the repository `LICENSE`
- Why forked: adapt prime-agent's compact default-shell tool panel without replacing the fork's newer tool lifecycle and extension renderers
- Core seam: tool extensions control `renderCall`, `renderResult`, and `renderShell`, but no extension hook can replace the generic shell that composes every default-shell renderer. Implementing the layout in an extension would require wrapping each tool renderer and would miss unknown and fallback tools.
- Package placement: keep the panel in coding-agent rather than add clamping options and reset handling to the shared TUI `Box`. One tool shell needs this behavior; a shared primitive change would widen the fork delta and affect unrelated message, preview, and extension boxes.
- Divergence: light — width-safe padding and cached panel composition adapted to the fork's lifecycle backgrounds
- Upstream source files inspected and adapted:
  - `packages/coding-agent/src/modes/interactive/components/tool-panel.ts`
  - `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- Adapted target:
  - `src/modes/interactive/components/tool-panel.ts`
  - `src/modes/interactive/components/tool-execution.ts`
- Scope: compact default-shell tool panel layout, width clamping, and padding. The fork keeps its newer tool lifecycle, grouping, image, disposal, extension-renderer, and expansion behavior.

## Refresh from upstream

```sh
git fetch https://github.com/PrimeIntellect-ai/prime-agent.git tag v0.7.0
git diff v0.7.0 -- packages/coding-agent/src/modes/interactive/components/tool-panel.ts
```
