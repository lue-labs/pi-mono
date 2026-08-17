# anti-slop install and sweep report

Branch `chore/anti-slop-oxlint`, on top of `main`.

| Commit | What |
|---|---|
| `b2d2b3d05` | Vendored the anti-slop Oxlint plugin, scoped to fork-added source |
| `97cff2fe0` | Fixed the duplicated silent `catch` in `bash-output.ts` |
| `e15361ef2` | Cleared prose violations in ten fork-owned docs |
| `bb8709c70` | Built cache-split blocks explicitly, typed the schema walker |
| `8784ef514` | Assigned optional fields instead of spreading empty objects |
| `84c72217d` | Renamed a flag for the condition it records |
| `5d21ad86b` | Read server-tool results through one typed boundary |
| `a57ba9234` | Named the thinking-strip result type |

Per-finding register: [`findings.md`](findings.md). Scope and triage records:
[`scope.md`](scope.md), [`triage.md`](triage.md).

## What was installed

Plugin copied to `tools/oxlint/anti-slop/`, which holds `index.ts` plus the
`rules/` and `shared/` directories, by
running the upstream `install.mjs` from dmmulroy's `install-anti-slop` skill.

Dependency versions came from live `npm view`, not from memory:

- `oxlint` pinned to `1.78.0`
- `@oxlint/plugins` pinned to `1.78.0`

`.oxlintrc.json` registers the plugin through `jsPlugins` with all 15 rules at
`error`. Ignores cover `.agents/**`, `.pi/**`, `.claude/**`, `.entire/**`, and
`tools/oxlint/anti-slop/**`.

Two scripts were added:

- `lint:slop` runs `oxlint .` across the repository.
- `lint:slop:fork-delta` runs `scripts/lint-slop-fork-delta.mjs`, which narrows
  the run to fork-added files.

The plugin was confirmed firing against a deliberate probe before any triage.

## Scope boundary

`.artifacts/anti-slop/SCOPE.md` records the boundary against `upstream/main`
tip `6db110e6`: 337 fork-added and 699 fork-modified files. Only fork-added
files are actionable, because they cannot produce an upstream merge conflict.
That is the same rationale the repo's own `scripts/check-fork-delta-static.mjs`
already uses.

Actionable surface: 225 code files and 12 living prose docs.

### Why fork-modified files were excluded

The 699 fork-modified files are files the fork edits but upstream also owns.
Rewriting upstream-authored lines inside them creates merge conflicts on every
future upstream sync, and the fork's whole maintenance model is built on
keeping that sync cheap. The repo already encodes this split in
`scripts/check-fork-delta-static.mjs`.

The cost of the exclusion is real and worth stating plainly: findings on
upstream-authored lines inside fork-modified files are not addressed here, and
the ratchet does not gate them.

`CONTRIBUTING.md` is the clearest case. It carries 2 prose violations, and it
is byte-identical to `upstream/main` (`git diff upstream/main -- CONTRIBUTING.md`
is empty). Editing it would hand the fork a permanent conflict on a file it has
never modified, to fix two em-dashes in someone else's prose. Left alone
deliberately.

## Findings

Oxlint reports 5,635 violations repository-wide and 1,216 inside fork scope
(379 in `src`, 833 in tests). The 4,419 upstream-scope findings are recorded
and deliberately left alone.

`slop-scan delta` against a clean upstream base worktree moved 291 to 338, so
47 net new occurrences, of which 72 occurrences fall in fork scope.

All 34 in-scope defensive findings were read individually: 19 are documented
false positives (listener isolation, cross-process filesystem races), 2 were
real, 1 was withdrawn after reading the code (`core/tasks/sort.ts` is a
deliberate tombstone), and 29 pass-through-wrapper findings are advisory.

## Why this landed as a ratchet rather than a mass rewrite

Rewriting 1,216 instances would touch most of the fork's delta in a single
sweep, and the majority of those instances are `require-safety-comment-for-type-assertion`
in tests. Adding 800-odd `SAFETY:` comments in bulk would be laundering: the
comment is supposed to state a checked invariant, and a generated one states
nothing. `anti-slop/code.md` treats that as the failure mode, not the fix.

So the rules are registered at `error` with a fork-delta gate available, and
the findings that could be fixed without laundering were fixed properly.

Every remaining fork-source finding is listed at line granularity in
[`findings.md`](findings.md), with the rule-level disposition that came out of
reading the sites. Two results from that pass are worth surfacing here:

- `no-unknown-parameters` cannot be satisfied at a parser entry point. A
  function that validates untyped input has to accept `unknown`. The rule fires
  on `fields(value: unknown)`, which this sweep wrote in order to *fix* 17 other
  findings.
- The boundary-parsing rules are pointing at one real architectural gap. The
  fork hand-rolls `typeof` validation for agent definitions and provider
  payloads while already depending on TypeBox. Converting those sites changes
  which malformed input is accepted, so it is a behavior-carrying project and
  not part of a lint sweep.

## Fixed

`packages/coding-agent/src/core/tools/bash-output.ts` had the same bare
`} catch {}` duplicated twice around a log `stat`. Both were replaced by a
single documented `bashBgLogSize()` helper that states the invariant once.

Verified: `tsc` clean, 34 bash-bg tests pass, `npm run check` exit 0, build
clean, `dist/cli.js --version` reports `0.84.4`, and both the log-present and
log-missing paths were exercised live.

Ten prose docs were brought to zero violations under `check-prose.py`:
`AGENTS.md`, `CLAUDE.md`, `VISION.md`, `docs/RELEASING.md`,
`docs/merge-conflict-reduction.md`, the four files under `docs/agents/`, and
`packages/coding-agent/docs/fork-cache-architecture.md`.

## Recorded and not fixed

**`bash-output.ts:172`, `as unknown as BashOutputToolDetails`** breaks
`no-chained-type-assertions`. It is a real defect. Fixing it changes a
published exported type, which is outside this goal's no-behavior-change
boundary.

**`FORK-CHANGELOG.md`, 81 violations.** The file is an append-only history.
Editing past entries would falsify the record. Only new entries are written
clean.

**`packages/agent/docs/harness-v2.md`, 111 violations.** This is a
29,965-word normative specification, so the density is about 3.7 per thousand
words. Two things make a sweep here a net loss:

- 21 of the violations are manually numbered headings, and 105 places in the
  document cross-reference those section numbers. Removing the numbers breaks
  every one of those references.
- The document carries 24 normative `MUST`/`MAY` statements. Restructuring
  semicolon chains inside normative clauses risks changing what the spec
  requires, which is a worse outcome than the slop it removes.

The document-level budgets that fire here (for example "budget 1 em dash per
document") are calibrated for short documents and do not scale to a 30k-word
specification. This one needs its own pass with its own review, not a tail-end
sweep.

**4,419 upstream-scope Oxlint findings.** Out of scope by construction.

## Verification

- `npm run check` exit 0, including biome, changelog, pinned deps, TS imports,
  shrinkwrap, install-lock, `tsc --noEmit`, and browser smoke.
- `npm run lint:fork-delta` unchanged from the recorded baseline: knip
  4 files / 1 unlisted / 25 exports / 25 types, dependency-cruiser 0.
- `npm run build` clean; `dist/cli.js --version` and `--list-models` both work.
- No repository anchor link points at any heading renamed in `RELEASING.md`.

One test fails, `fork-agent.test.ts > preserves a parent-only deferred tool
handler in fork mode`. It is not mine. Stashing only the pre-existing foreign
working-tree changes makes the whole file pass 21/21, and restoring them brings
the failure back. My commits touch none of the forkAgent, deferred-tool, or system-prompt code
that test exercises.

## Foreign working tree

The uncommitted changes present before this work (`.entire/settings.json`,
`packages/ai/src/utils/typebox-helpers.ts` plus a new test,
`packages/coding-agent/src/core/agent-session.ts`, `system-prompt.ts`, two
tests, and a deleted `node_modules` symlink) were snapshotted to
`.artifacts/anti-slop/foreign-tree-baseline.patch` and diffed against that
baseline after every gate. They are byte-identical now and were never staged.

## Self-audit against anti-slop/reasoning

Places where the pass could have been made to look cleaner than it is, and what
happened instead:

- **Bulk `SAFETY:` comments** would have cleared roughly 800 findings. Not
  done. It is the laundering the rule exists to catch.
- **Rule suppression or severity downgrade** would have zeroed the count. Not
  done. All 15 rules sit at `error`.
- **Table cells in `fork-cache-architecture.md`**: a mechanical `;` to `.`
  swap passed the checker while leaving lowercase sentence starts. That was
  degraded prose written to satisfy a checker, so it was caught on re-read and
  rewritten into real sentences.
- **`AGENTS.md`**: the first rewrite cleared one violation and pushed the
  labeled-bullet ratio from 33% to 66%. Caught on re-sweep and corrected. This
  is why every file was re-checked after every revision rather than once at the
  end.
- **Detector artifacts were diagnosed, not assumed.** Two "exactly-three list"
  hits came from six- and four-item technical lists whose inline code spans the
  detector collapses. The cause was established by line-by-line bisection
  before either was touched, and both were restructured into nested lists that
  read better regardless of the detector.
- **`harness-v2.md` is the weakest point in this report.** It is genuinely
  in-scope, fork-owned, and living, and it is being deferred. The 105
  cross-references and the normative-clause risk are real, but the honest
  summary is that it is unfinished work with a stated reason, not a clean file.
- **One test failure is being handed over red.** It was proven foreign by
  stashing rather than argued away.
