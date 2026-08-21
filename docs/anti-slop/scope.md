# Anti-slop sweep scope boundary

Computed against `upstream/main` tip (`6db110e6`), matching the precedent in
`scripts/check-fork-delta-static.mjs`.

## Why fork-ADDED, not merge-base-changed

The goal said "changed vs merge-base". The repo's own fork-delta script uses
fork-ADDED files instead, and its reasoning applies harder to a slop sweep than
to a lint gate:

- A fork-**added** file has no upstream counterpart. Editing it can never
  produce a merge conflict.
- A fork-**modified** file is an upstream file. Editing it for style guarantees
  conflict churn on every sync merge, for zero fork value: exactly what the
  goal forbids.

So the actionable scope is fork-added files. Fork-modified files are
report-only.

## Counts

| Set | Files |
|---|---|
| Fork-added (all) | 337 |
| Fork-modified (all, upstream-owned) | 699 |
| Fork-added code (ts/tsx/js/mjs/cjs, no node_modules) | 232 |
| **Code scope after exclusions** | **225** |
| Fork-added markdown | 76 |
| **Prose scope after exclusions** | **12** (see below) |
| Upstream-modified code, report-only | 602 |

## Code scope

`scope-code-final.txt`: 225 fork-added source files. Excluded from the 232:

| Excluded | Count | Reason |
| --- | ---: | --- |
| `experiments/` | 7 | Out of scope per goal boundaries |
| `packages/coding-agent/test/fixtures/` | | Fixtures encode deliberately odd shapes, so "fixing" them breaks the tests that assert on them |

## Prose scope

Of 76 fork-added markdown files, only living docs are rewritable. Excluded:

| Excluded | Count | Reason |
| --- | ---: | --- |
| `docs/goals/` | 30 | Archival goal records; rewriting a historical log falsifies the record |
| `.changeset/` | 8 | Published changelog fragments, already consumed |
| `*/CHANGELOG.upstream.md` | 4 | Verbatim upstream changelog copies |
| Dated audit and log artifacts | | Point-in-time records; includes `docs/fork-merge-conflict-log-*`, `docs/fork-divergence-audit-*`, `docs/tool-inventory-*`, `docs/*-scar.md`, `docs/openclaw-pi-harness-debug.md`, `docs/research/*`, `docs/specs/*`, and `docs/adr/*`, where ADRs are immutable by convention |
| `GOAL-finish-autoresearch-wip.md` | | Transient WIP note |
| `packages/coding-agent/docs/claude-code-2.1.14*` | | Dated handoff notes |

Rewritable living docs:

1. `AGENTS.md` *(upstream-named but fork-rewritten: 14 insertions / 164
   deletions vs upstream, so already fully divergent: editing adds no new
   conflict risk)*
2. `CLAUDE.md`
3. `VISION.md`
4. `FORK-CHANGELOG.md`, headings//prose only, never past entries
5. `docs/agents/code-conventions.md`
6. `docs/agents/github-workflow.md`
7. `docs/agents/releases-and-changes.md`
8. `docs/agents/testing-and-dependencies.md`
9. `docs/RELEASING.md`
10. `docs/merge-conflict-reduction.md`
11. `packages/agent/docs/harness-v2.md`
12. `packages/coding-agent/docs/fork-cache-architecture.md`

`CONTRIBUTING.md` is byte-identical to upstream and `README.md` differs by 9
lines; both stay out.

## Baselines (branch `chore/anti-slop-oxlint`)

| Check | Result |
| --- | --- |
| `npx biome check .` | exit 0, no fixes applied |
| `npx tsc --noEmit` | exit 0 |
| `npm run check` | exit 0 |
| `npm run lint:fork-delta` | exit 0. knip files 4 / unlisted 1 / exports 25 / types 25. dependency-cruiser 0 violations |
| Foreign uncommitted tree | Snapshotted to `foreign-tree-baseline.patch`, verified identical after `biome --write` |
