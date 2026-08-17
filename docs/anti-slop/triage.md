# Anti-slop triage

Two independent checkers, both scoped per `SCOPE.md`.

## Oxlint (dmmulroy/anti-slop, 15 rules)

Repo-wide, via `npm run lint:slop`, oxlint reports **5,635** findings. Inside
fork-added scope, via `npm run lint:slop:fork-delta` over 225 files, it reports

**1,216**. That leaves **4,419 upstream-scope findings recorded here and left
alone**, because restyling an upstream file guarantees sync conflicts for no
fork value.

Fork-scope split: 379 in fork `src/`, 833 in fork `test/`, 4 elsewhere.

| Rule | Fork-scope | Fork `src` only |
|---|---|---|
| require-safety-comment-for-type-assertion | 718 | 138 |
| no-runtime-typeof | 126 | 103 |
| no-chained-type-assertions | 108 | 6 |
| no-unsafe-dictionary-type | 88 | 34 |
| no-unknown-parameters | 70 | 39 |
| no-known-value-widening | 56 | 44 |
| no-conditional-empty-object-spread | 22 | 7 |
| no-shape-in-symbol-names | 11 | 6 |
| no-module-mocking | 10 | 0 |
| no-unknown-returns | 7 | 2 |

### Verdict: ratchet, not a 1,216-instance rewrite

`anti-slop/code.md` is explicit: "A defect that keeps reappearing across a
codebase is a generator problem, not an output problem. Fix the prompt, the
convention doc, or the lint rule that lets it through; hand-fixing instances
guarantees recurrence."

That is the governing call here, and it is not a cost dodge:

- These 1,216 findings are **pre-existing shipped fork code**, not introduced by
  this change. `anti-slop/tooling.md` reserves blocker status for findings
  pointing at "a real in-scope bug, hidden control flow, a swallowed error, an
  unsafe fallback, or duplicated code **the change introduced**".
- The dominant classes demand *architectural* change, not tidying.
  `no-unknown-parameters` and `no-unsafe-dictionary-type` are satisfied by
  parsing at the I/O boundary and threading domain types through call graphs,
  which is hundreds of signature changes across working, tested features. The goal
  forbids behavior changes and refactors beyond what a rule requires.
- `require-safety-comment` (718, the largest class) cannot be honestly bulk-fixed
  at all. The rule wants a *stated checked invariant*. Emitting 718 `SAFETY:`
  comments to silence a linter is precisely the laundering both
  `install-anti-slop` step 5 and `anti-slop/reasoning.md` prohibit. A real fix is
  per-assertion judgment.

So the ratchet is the deliverable: the rules are at `error` and
`lint:slop:fork-delta` gates fork-added code, so **new** instances are caught at
authoring time, while the existing population is recorded rather than laundered.
Hand-fixing is reserved for findings that point at real defects (below).

## slop-scan delta (base = `upstream/main` @ `6db110e6`)

`findings 291 -> 338 (+47)`; repo score `942.04 -> 1075.42`. Per
`anti-slop/tooling.md` the delta is the meaningful number and the blended score
gates nothing.

256 added occurrences repo-wide; **72 fall inside fork-added scope**. The rest
are upstream files whose fingerprints moved, not fork-authored, so not
actionable.

| Rule | In fork-added scope |
|---|---|
| structure.pass-through-wrappers | 29 |
| defensive.empty-catch | 22 |
| defensive.error-obscuring | 12 |
| tests.duplicate-mock-setup | 6 |
| structure.barrel-density | 1 |
| defensive.async-noise | 1 |
| structure.duplicate-function-signatures | 1 |

### The swallowed-error class, read individually

34 in-scope defensive findings. Read one by one rather than by count:

**False positives, real invariant, already documented (leave):**

| File | Findings | Why the catch is correct |
| --- | ---: | --- |
| `core/bash-bg-jobs.ts` | 11 | Every `catch` wraps a third-party listener invocation at an observer boundary, each with a comment stating the invariant ("A listener must never break the watchdog"). A throwing subscriber must not corrupt job lifecycle bookkeeping. This is isolation rather than swallowing |
| `core/session-liveness.ts` | 6 | Cross-process filesystem races on marker and tombstone files, each documented ("Another process may have handled it already"). `ENOENT` from a concurrent reaper is the expected path |
| `core/agents/status.ts` | 2 | UI refresh hooks with documented listener isolation |

The heuristic cannot see that a `catch` sits at an observer or multi-process
boundary. Converting these to loud failures would be a behavior change and a
regression.

**Real findings (fixed in the next commit):**

`core/tools/bash-output.ts:42` and `:111` hold bare `} catch {}` with **no**
stated invariant, and the surrounding five lines are duplicated verbatim
between the two call sites. This is both an undocumented swallow and the
`duplicate-function-signatures` hit. Fixed by extracting one helper that
states the invariant once.

**Real finding, deferred to a user decision (NOT advisory):**

- `core/tools/bash-output.ts:172`, which reads
  `{ bgId, fullOutputPath } as unknown as BashOutputToolDetails`. The object
  carries two fields; the asserted type extends `BashBgJob` and promises ~15.
  The double assertion exists solely to defeat the compiler, so any consumer
  reading `details.status` or `details.exitCode` on the orphaned-job path gets
  `undefined` with the type system asserting otherwise. This is a real defect,
  not a style nit.

  Not fixed here because `BashOutputToolDetails` is exported from a published
  package (re-exported via `bash.ts`), so the honest repair: a discriminated
  union for the orphaned shape: changes a public type and would force
  downstream consumers to narrow. That is an API decision, and the goal forbids
  behavior changes. Flagged for a follow-up rather than laundered with a
  `SAFETY:` comment, which would assert an invariant that does not hold.

**Withdrawn on a second read:**

In `core/tasks/sort.ts`, oxlint's `unicorn(no-empty-file)` flagged it and nothing
imports it, so my first pass listed it as a dead file to delete. Reading it
instead of its finding: it is a deliberate tombstone documenting that task
sorting moved to the `pi-agent-ui` extension package, deliberately kept so the
extraction stays explicit. Deleting it would override another author's stated
decision to satisfy a linter. Left in place.

**Advisory, not fixed:** `structure.pass-through-wrappers` (29), thin
delegations, several of which are deliberate seams the fork maintains for
upstream compatibility (`extension-api-fork.ts`). Judging each needs the
fork-seam context in `docs/agents/code-conventions.md`; collapsing them risks
the exact merge surface the fork exists to preserve.
