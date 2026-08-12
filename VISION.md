# VISION.md — valkyriweb/pi-mono

## Purpose

A public-friendly fork of [`earendil-works/pi-mono`](https://github.com/earendil-works/pi-mono)
(the Pi coding agent) that anyone can install and run in minutes. The fork
ships a small set of platform capabilities Pi does not have upstream yet — a
hooks/filters extension layer, prompt-cache splitting, an agent/sub-agent
subsystem, deferred tool loading, and Claude-Code-parity tool surfaces — while
staying close enough to upstream that it keeps rebasing cleanly.

The fork has grown up as a personal tinkering ground. The next phase is
productization: a stranger with npm and an API key should get a working,
documented, batteries-included `pi` without needing any of the maintainer's
private setup. Everything operator-specific lives in the sibling
[`my-pi`](https://github.com/valkyriweb/my-pi) extension suite, not here.

## Who this serves

- **Anyone** who wants a Pi with the fork's extra platform seams: install from
  npm, add a provider key, run.
- Extension authors who build on the hooks/filters layer, deferred tools, and
  `forkAgent` — with documented, stable, typed seams.
- The maintainer (@valkyriweb) and the `my-pi` extension stack as the first —
  but no longer the only — consumers.
- Agents running on `pi` that rely on stable tool schemas and a cache-stable
  system prompt.

## What good looks like

- **Clean install path:** `npm install -g @valkyriweb/pi-coding-agent` (or the
  release binary) works on a fresh machine with zero repo-local knowledge; a
  quickstart doc covers provider auth, first run, and extension loading.
- **No hidden dependencies on the maintainer's environment:** default config,
  prompts, and tools work without `my-pi`, claude-bridge, clawrouter, or any
  private service. Those remain optional layers.
- Every fork commit is classifiable as **upstream-native**, **platform delta**
  (generic, upstreamable), or **behavior delta**. Behavior deltas are kept
  explicit, documented, and as small as practical; extension seams remain the
  preferred home when they can express the behavior cleanly.
- The fork rebases onto `upstream/main` with a shrinking, well-understood
  conflict set; the weekly `upstream-sync` workflow stays green or produces a
  clear conflict PR.
- The system-prompt prefix and `tools[]` array stay byte-stable within a
  session (prompt-cache is never burst by a fork change).
- `npm run check`, `test:build-gate`, and the my-pi extension gate are green
  before any release.

## Product / system principles

- **Works out of the box.** Sensible defaults for someone who has never seen
  this repo; power features are discoverable, not required.
- **Minimize behavior delta in core.** Opinions about what Pi *does* (prompts,
  tool logic, routing) should live in extensions and ride the hooks/filters
  layer. Core behavior patches require a clear platform-level reason and must
  stay documented so they can be reconsidered as extension seams improve.
- **Platform primitives are written to be upstream-PR-able.** Each one that
  lands upstream shrinks the fork's rebase surface.
- **Cache stability is sacred.** Never add/remove/reorder skills or `tools[]`
  mid-session; deliver mid-task changes as trailing user blocks.
- **Documented seams over tribal knowledge.** Every extension-facing hook,
  filter, and API the fork adds gets docs and tests in this repo.
- **Erasable TypeScript only** in checked sources (Node strip-only mode): no
  enums, namespaces, parameter properties, or `import =`.
- **Fork-owned artifacts are intentional.** Upstream-provenance files and the
  upstream remote are kept on purpose; don't "clean them up."

## Current priorities

1. **Onboarding hardening:** fresh-machine install/run path verified in CI;
   quickstart + extension-author docs; remove or gate any code path that
   assumes the maintainer's local stack.
2. **Seam quality:** typed, tested, documented hooks/filters registry
   (deterministic ordering, explicit error policy with fail-fast defaults,
   chain test harness).
3. Shrink the rebase surface: upstream the generic platform primitives;
   replace remaining inline core patches with extension seams + hooks.
4. Keep the prompt-cache contract enforced by `test:build-gate`; keep CI
   honest and fast (fork-safety-check, workflow sanity, changelog guard).

## Non-goals

- Becoming a permanently divergent hard fork with bespoke behavior baked into
  core.
- Undocumented inline behavior patches in `packages/coding-agent`, especially
  when an existing extension seam can express the behavior cleanly.
- Shipping the maintainer's personal extensions, routing, or memory stack in
  this repo — that is `my-pi`'s job.
- Publishing under or impersonating the upstream `@earendil-works/*` scope.

## Release and operations posture

- **Versioning:** Changesets owns package versioning. The fixed package group is
  currently inconsistent with the workspaces and must be reconciled before the
  next release; do not infer a lockstep package set.
- **Release gate:** local `npm run check` + `test:build-gate`, then the
  Changesets workflow on `main` publishes restricted `@valkyriweb/*` packages to
  GitHub Packages and invokes binary builds when coding-agent ships. Full
  runbook: [`docs/RELEASING.md`](docs/RELEASING.md).
- **Smoke evidence:** Node and Bun startup, `--version`/`--list-models`,
  interactive boot, and a real prompt against the default provider
  (`npm run release:local`). Add a fresh-environment install smoke as part of
  onboarding hardening.
- **Rollback posture:** fix the release workflow or package metadata and rerun
  the failed Changesets workflow; never create a second version to mask a
  partial release without maintainer approval.

## Agent guidance

- May do without asking: behavior-preserving refactors of fork-owned code, docs,
  tests, CI hygiene, and changelog updates — committing only files changed in
  this session via explicit paths.
- Requires approval: new runtime dependencies, core behavior changes, releases,
  force-pushes, and anything that mutates the GitHub repo or upstream.
- Public direction and runbooks: this file, root `AGENTS.md`,
  `CONTRIBUTING.md`, and `docs/RELEASING.md`. Maintainer-only planning and
  operator-stack records live outside this public repository and are not
  required to install, use, or contribute to the fork.

## Open questions

- Which platform primitives are ready to PR upstream next (owner: @valkyriweb)
  — tracked in the maintainer's private planning system; public candidates
  should become issues in this repository before external contributors need
  to act on them.
- What the minimum viable quickstart covers (providers, extension install,
  binary vs npm) and where it lives (README vs docs site).
