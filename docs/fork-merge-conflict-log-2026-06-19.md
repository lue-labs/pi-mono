# Merge conflict log — upstream/main → main (2026-06-19)

Upstream brought 20 commits; fork was 399 ahead. `git merge --no-edit upstream/main`
produced **49 conflicted files**; 67 auto-merged cleanly (`.gitattributes` drivers handled
all `*CHANGELOG.md` (union), `packages/*/CHANGELOG.md` (ours), and `*.generated.ts` (ours)
with zero conflicts).

The feared "DANGER ZONE" compaction/agent-loop merge **did not materialize**: the only
upstream commits touching `packages/agent/src` this window were the #5348 selective-entrypoint
split (`0d89a3337`) and the WSL-bash stdin fix (`1287b69fe`). Upstream's compaction work landed
in `coding-agent` or was already synced. All 12 `agent/src` conflicts were import-path noise.

## Conflicts by category (49 files)

| # | Files | Conflict | Resolution |
|---|-------|----------|-----------|
| 1 | `packages/{agent,ai,coding-agent,tui}/package.json` + `tsconfig.json` (5) | Scope (`@valkyriweb` vs `@earendil-works`), version, internal pins, vitest bump, new `openrouter-images` path | Kept `@valkyriweb` scope, version `0.79.7`, exact internal pins, `publishConfig`. **Adopted upstream vitest `4.1.9`** (security bump; `@vitest/coverage-v8@4.1.9` already merged forces v4 — fork's 3.2.4 was inherited, not an intentional pin). Added `@valkyriweb/pi-ai/openrouter-images` tsconfig path (new #5348 selective entrypoint). |
| 2 | `packages/{ai,coding-agent}/README.md` (2) | Fork `@valkyriweb` framing vs upstream base.ts guidance + pi.dev/exe.dev promo | Kept `@valkyriweb` framing + upstream's factual base.ts note; **dropped** pi.dev/exe.dev promo block (private fork). |
| 3 | `scripts/generate-coding-agent-shrinkwrap.mjs` (1) | Install-script allowlist (`koffi`, `protobufjs`) | Kept fork's `koffi@2.16.2` entry (Windows VT input optional dep); `protobufjs@7.6.4` (matches adopted upstream bump — see #7). |
| 4 | `packages/ai/test/*.test.ts` (25) | #5348 entrypoint split: fork imports `../src/stream.ts`/`models.ts`, upstream moved to `../src/index.ts` (triggers built-in registration) | Adopted upstream's `../src/index.ts` path (canonical post-#5348, cuts future conflicts). Stripped the `getModel` import the fork deliberately dropped where the body no longer uses it (20 line-deletes; 2 `getModel,getModels`→`getModels`). **Special cases:** `anthropic-thinking-disable` kept fork adaptive-reasoning consts + `./helpers/models` import, dropped now-redundant `streamSimple` from `stream.ts`; `openai-completions-tool-choice` dropped redundant `streamSimple` then dropped unused `stream` (a local `const stream` shadows the import); `openai-completions-empty-tools` + `openrouter-cache-write-repro` **restored** the `pickModel` helper import that accept-theirs dropped while the body still calls it (tsgo caught this). |
| 5 | `packages/agent/src/**` (12) | 100% #5348 import-path conflicts: `@valkyriweb/pi-ai` (full) vs `@earendil-works/pi-ai/base` (selective) | Kept `@valkyriweb` scope, **adopted `/base`** (side-effect-free entrypoint — keeps provider registration out of the agent core, matches upstream architecture, cuts future conflicts). `index.ts` → adopted upstream thin-wrapper (`import "@valkyriweb/pi-ai"; export * from "./base.ts"`). **Critical fork-preservation catch:** the fork-only `export * from "./harness/progressive-disclosure.ts"` is absent from upstream's new `base.ts` — **added it to `packages/agent/src/base.ts`** (auto-merged file) so the export is not silently dropped. `harness/types.ts` kept `ToolReferenceContent` (used L582/697), adopted `/base` + the direct `../types.ts` import (avoids the circular dep through `index.ts`). |
| 6 | `packages/coding-agent/test/{agent-session-auto-compaction-queue, suite/agent-session-compaction}.test.ts` (2) | Import-set divergence | Queue test: kept upstream's seeded faux helpers (`createAssistantMessageEventStream`, `fauxAssistantMessage`), dropped unused `getModel`, `@valkyriweb` scope. Suite compaction: kept **both** fork `getMessageText` and upstream `estimateTokens` imports (both used). |
| 7 | `package-lock.json` + `packages/coding-agent/npm-shrinkwrap.json` (2) | Lockfile divergence | Took fork's (`--ours`) as base → `npm install --ignore-scripts` reconciled to merged `package.json` (vitest 3→4 churn). **Adopted upstream's `protobufjs@7.6.4`** security bump via `npm update protobufjs` (transitive via `@google/genai ^7.5.4`; fork lockfile lagged at 7.5.9). Regenerated coding-agent shrinkwrap (140 pkgs; `koffi@2.16.2` + `protobufjs@7.6.4` allowlist). |

## Follow-up fixes (auto-merged/clean-compiling, but broke at runtime)

These three passed the merge, `tsgo --noEmit`, and `npm run check` but were caught later by
gates/tests. All are #5348 scope/entrypoint fallout that type-checking cannot see.

1. **`scripts/check-browser-smoke.mjs`** auto-merged, but #5348 added base + selective-entrypoint
   smoke blocks that **hardcode `@earendil-works/...`** in esbuild stdin strings. The fork lacks
   that scope, so `check:browser-smoke` failed to resolve. Rescoped the 5 specifiers
   (`pi-ai/base`, `pi-agent-core/base`, `pi-ai/anthropic`, `pi-ai/openai-completions`,
   `pi-ai/openrouter-images`) to `@valkyriweb`. (Caught by `npm run check`.)
2. **`packages/coding-agent/vitest.config.ts` — missing `@valkyriweb` `/base` aliases (61 test failures).**
   #5348 made `@valkyriweb/pi-ai/base` side-effect-free; provider registration now only fires via
   the package-root `index.ts` (`register-builtins.ts` top-level `registerBuiltInApiProviders()`).
   The auto-merge kept the fork's pre-#5348 `@valkyriweb` alias block (root + oauth only) and added
   upstream's NEW `/base` + `/openrouter-images` aliases **only under `@earendil-works`/`@mariozechner`**.
   Result: in the coding-agent suite the harness registered the faux provider via `@valkyriweb/pi-ai`
   (aliased to **src** `api-registry`), but agent-core runtime (`agent-loop.ts` et al.) imports
   `@valkyriweb/pi-ai/base` which fell through to **dist** `api-registry` — a second, empty registry.
   Lookups hung (30s timeouts) or threw "No API provider registered"/"No API key found". Fixed by
   mirroring the full `@earendil-works` alias set under `@valkyriweb` (added `pi-ai/base`,
   `pi-ai/openrouter-images`, `pi-agent-core/base` → src). The shipped `pi` binary was never affected
   (all-dist, single registry); this was test-resolution-only. (Caught by `./test.sh`.)
3. **`packages/ai/test/{anthropic-thinking-modified-recovery,openai-responses-parallel-tool-calls}.test.ts`
   (3 failures).** These fork-only tests import `streamSimple` from `../src/stream.ts`, which after
   #5348 no longer triggers `register-builtins.ts` — so `resolveApiProvider` found an empty registry.
   Repointed both imports to `../src/index.ts` (the registering entrypoint, matching the passing
   `context-overflow.test.ts`). (Caught by `./test.sh`.)
4. **`packages/coding-agent/test/session-id-readonly.test.ts` (1 failure) — PRE-EXISTING, not caused by
   this merge.** After fixes #2/#3 the suite had exactly one failure: `rejects an existing fork target
   session id` expected `Session already exists with id 'existing-id'` but got `No API key found for
   the selected model.`. Root cause: the test (from upstream PR #5076, `52dc08c1f`) persists
   `session.cwd` as the raw `mkdtemp` path (`/var/folders/…`), but the spawned CLI's `process.cwd()`
   resolves the macOS `/var`→`/private/var` symlink. `SessionManager.list` filters by
   `sessionCwdMatches` (exact `resolvePath` string compare, no symlink normalization), so the fixture
   session is dropped → `findLocalSessionByExactId` returns undefined → the fork collision check is
   skipped → the CLI proceeds to model resolution and reports the missing key. The entire path
   (`main.ts:482` `process.cwd()`, `sessionCwdMatches`, `SessionManager.list`, the test) is
   byte-identical to `origin/main` (`git diff origin/main` empty), so it fails the same way on
   `origin/main` locally and **passes in CI** (Linux `/tmp` is not a symlink). Fixed by realpath'ing
   the temp dir in the test's `createTempDir` (`realpathSync(mkdtempSync(…))`) so the persisted cwd
   matches `process.cwd()` on both platforms — a no-op on Linux. Product code untouched (real usage
   always reads/writes cwd from the same realpath'd `process.cwd()`). Candidate to upstream. (Surfaced,
   not caused, by `./test.sh`.)

## Gates

- `npm run check` → exit 0 (biome, changelog, pinned-deps, ts-imports, shrinkwrap `--check`,
  tsgo `--noEmit` 0 errors, browser-smoke).
- Built all four workspaces (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`) — required so
  the new `dist/base.js` exists for the browser-smoke `/base` resolution.
- `./test.sh` (auth stripped, all keys unset, `PI_NO_LOCAL_LLM=1`) — non-e2e suite. First run
  surfaced 64 failures (61 coding-agent + 3 ai) that all traced to the two registration gaps in
  Follow-up fixes #2/#3; second run had 1 pre-existing macOS-only failure (Follow-up fix #4). After
  all four fixes there are no deterministic failures: agent 171, ai 424, coding-agent 2009, tui 698
  all pass.
- **Two pre-existing load-induced flaky tests** can fail when the whole suite runs concurrently on a
  busy machine: `coding-agent test/footer-data-provider.test.ts > debounces rapid reftable updates`
  (git-backed, 8s `waitFor` timeout) and `tui test/markdown.test.ts:712 > should not leak styles …`
  (`markdownLineCount > 0` measured as 0). Both **pass in isolation** (8/8 and 63/63) and both their
  test files and source are byte-identical to `origin/main`, so they are environmental flakiness, not
  merge regressions. They passed in the second full run and failed in the third with no relevant
  change in between.

## Lessons

- **#5348 entrypoint split is the dominant conflict driver** — 37 of 49 files (25 `ai/test` +
  12 `agent/src`) were `@valkyriweb/pi-ai` → `/base` import churn. Adopting `/base` everywhere
  *now* should make the next sync near-zero for these surfaces.
- **The compaction "danger zone" was a false alarm this window.** Always re-derive which upstream
  commits actually touch a feared path (`git log origin/main..upstream/main -- <path>`) before
  treating a conflict as semantic — these were all import-path noise.
- **Fork-only exports silently vanish when upstream restructures the package entrypoint.**
  `progressive-disclosure` was missing from upstream's new `base.ts`; caught only by diffing the
  fork's old `index.ts` export list against upstream's `base.ts` line-by-line. Track
  `progressive-disclosure` in `pi-fork-patch-inventory.md` so future entrypoint refactors check
  for it.
- **`accept-theirs` on import conflicts is unsafe when the fork's body diverged.** It dropped the
  `pickModel` helper import in 2 files whose bodies still call `pickModel`. `tsgo --noEmit` caught
  it — *always* run the typecheck after bulk import resolution; never trust accept-theirs blind.
- **`check-browser-smoke.mjs` is a new latent scope-conflict surface** — it bakes the package
  scope into esbuild stdin strings, so every #5348-style entrypoint addition upstream reintroduces
  `@earendil-works` refs. Candidate for a single `SCOPE` constant at the top of the script.
- **Side-effect-free `/base` + a scoped alias list = a registry-split trap that only tests catch.**
  After #5348, provider registration is a side effect of the package *root*, not `/base`. Any path
  that reaches `@valkyriweb/pi-ai/base` without the root being loaded into the same module graph gets
  an empty `api-registry`. `tsgo --noEmit` and `check:browser-smoke` both passed while 64 tests were
  red, because the failure is runtime module identity, not types. **`./test.sh` is mandatory after
  any entrypoint-touching sync** — `npm run check` is necessary but not sufficient.
- **Every fork-scoped alias block must mirror the full upstream alias set.** The fork maintains a
  parallel `@valkyriweb/*` block in `vitest.config.ts` alongside upstream's `@earendil-works`/
  `@mariozechner` blocks; when upstream adds a new subpath alias (`/base`, `/openrouter-images`),
  the auto-merge adds it only to the upstream blocks. After a sync, diff the `@valkyriweb` alias
  list against `@earendil-works` and add any missing subpaths. Long-term: derive all three scope
  blocks from one list mapped over `["@valkyriweb", "@earendil-works", "@mariozechner"]`.
- **Fork-only tests that import `../src/stream.ts` (or any non-registering submodule) for streaming
  break silently on entrypoint refactors.** Prefer `../src/index.ts` (the registering entrypoint) in
  fork tests that call `streamSimple`/`complete`, matching upstream's own provider tests.
- **`./test.sh` on macOS surfaces pre-existing cross-platform test bugs CI never sees.** Subprocess
  tests that persist `process.cwd()`-derived paths under `mkdtemp` must realpath the temp dir — macOS
  resolves `/var`→`/private/var`, and any exact-string cwd compare (e.g. `sessionCwdMatches`) then
  mismatches. CI (Linux) hides it. When a single failure survives the real fixes, confirm whether it
  is byte-identical to `origin/main` before treating it as a merge regression.
- **The `FORK-CHANGELOG.md` entry MUST be staged into the merge commit itself, never a follow-up.**
  `scripts/check-changelog-updated.mjs` diffs *committed* `origin/main...HEAD`. During the merge
  commit's own pre-commit hook, HEAD is still the pre-merge parent (= `origin/main`), so the range is
  empty and the check passes trivially — then CI (`check` / `fork-safety-check`), which runs after the
  merge lands, sees all the synced code with no changelog touch and fails. A follow-up commit cannot
  fix it (its pre-commit sees the merge's code without the still-only-staged changelog and fails too,
  and `--no-verify` is forbidden). Fix: include the FORK-CHANGELOG.md entry in the merge commit. To
  repair after the fact without re-resolving conflicts, `git reset --soft origin/main` (keeps the
  resolved tree staged), `git add FORK-CHANGELOG.md`, restore `.git/MERGE_HEAD` to the upstream tip,
  and recommit — the hook's changelog diff is empty again because HEAD is back at `origin/main`.
