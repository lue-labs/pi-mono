# Merge Conflict Reduction Plan

Luke's Pi fork currently carries enough local divergence that upstream syncs can explode into large conflict sets. The 2026-05-20 update attempt hit 115 conflicted files, including cache/tool/prompt surfaces. Treat that as a structural smell rather than a one-off merge chore.

## Goal

Reduce recurring upstream merge conflicts by moving Luke-specific behavior out of core fork files and into extension/package surfaces over time.

## Major conflict culprits to audit

Start with the files that repeatedly collide with upstream changes:

- Provider request shaping and cache behavior:
  - `packages/ai/src/providers/anthropic.ts`
  - `packages/ai/src/providers/*`
  - `packages/ai/src/types.ts`
- Prompt/cache/tool surfaces:
  - `packages/coding-agent/src/core/system-prompt.ts`
  - `packages/coding-agent/src/core/agent-session.ts`
  - `packages/coding-agent/src/core/extensions/types.ts`
  - `packages/coding-agent/src/core/extensions/runner.ts`
  - `packages/coding-agent/src/core/resource-loader.ts`
  - `packages/coding-agent/src/core/tools/*`
- Local packaging/update changes:
  - `package.json`
  - `package-lock.json`
  - `packages/coding-agent/package.json`
  - `packages/coding-agent/npm-shrinkwrap.json`
  - `.npmrc`
- UI/footer/custom editor surfaces:
  - `packages/coding-agent/src/modes/interactive/**`
  - `packages/tui/src/index.ts`
- Retired deleted-or-diverged upstream packages:
  - `packages/web-ui/**` — removed from the fork on 2026-05-21 after audit confirmed zero live consumers

## Refactor direction

For each recurring conflict, ask:

1. Can Luke-specific behavior move to `~/Projects/personal/my-pi` as an extension or Pi package?
2. Can core expose a small stable hook instead of carrying a large local patch?
3. Can provider/cache behavior be represented as metadata/config instead of editing provider request builders?
4. Can tests live with the extension/package that owns the behavior?
5. Can generated/package-manager artifacts be regenerated after merge instead of hand-merged?

Prefer upstreamable seams over fork-only logic:

- extension APIs for tools, renderers, commands, events, startup resources;
- provider compat flags for request-shaping differences;
- package metadata for optional extensions;
- stable cache contracts (`defer_loading`, `tool_reference`, `context: "slim" | "none"`) instead of patching prompt/tool arrays directly.

## Update workflow going forward

Do not merge upstream directly into daily `main` for large syncs.

1. Start from clean `main`.
2. Create an update branch, e.g. `lue/pi-upstream-0.75.4`.
3. Merge/rebase upstream there.
4. Resolve conflicts with `pi-cache-stability` loaded.
5. Run health checks before touching daily `main`:
   - source build chain: `tui → ai → agent → coding-agent`;
   - relevant core tests for touched packages;
   - my-pi extension checks for cache/tool surfaces;
   - launch `pi` from the branch once.
6. Open a PR or keep the branch for review.
7. Merge to daily `main` only after checks pass and cache-sensitive diffs are reviewed.

## Cache review requirement

Any upstream sync that touches prompt/tool/provider/agent surfaces must explicitly review cache blast radius:

- native tools array stability;
- deferred tool semantics (`defer_loading`, `tool_reference`);
- system prompt static-before-dynamic ordering;
- child/fork context policy;
- provider beta/header/request changes;
- cache diagnostics or real session usage when behavior changes.
