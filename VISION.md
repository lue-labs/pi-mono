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
  (generic, upstreamable), or **behavior delta** (forbidden as an inline core
  patch — must live in an extension).
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
- **No behavior delta in core.** Opinions about what Pi *does* (prompts, tool
  logic, routing) live in extensions and ride the hooks/filters layer, never
  inline in `packages/coding-agent`.
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
   (deterministic ordering, error isolation, chain test harness).
3. Shrink the rebase surface: upstream the generic platform primitives;
   replace remaining inline core patches with extension seams + hooks.
4. Keep the prompt-cache contract enforced by `test:build-gate`; keep CI
   honest and fast (fork-safety-check, workflow sanity, changelog guard).

## Non-goals

- Becoming a permanently divergent hard fork with bespoke behavior baked into
  core.
- Inline behavior patches in `packages/coding-agent` when an extension seam
  exists or can be added.
- Shipping the maintainer's personal extensions, routing, or memory stack in
  this repo — that is `my-pi`'s job.
- Publishing under or impersonating the upstream `@earendil-works/*` scope.

## Release and operations posture

- **Versioning:** lockstep across the four publishable `@valkyriweb/pi-*`
  packages — one shared version, bumped together. `patch` = fixes + additions,
  `minor` = breaking; no major releases.
- **Release gate:** local `npm run check` + `test:build-gate`, then a tag-driven
  CI release (`build-binaries.yml`) that publishes to npm via GitHub Actions
  OIDC trusted publishing. Full runbook: [`docs/RELEASING.md`](docs/RELEASING.md).
- **Smoke evidence:** Node and Bun startup, `--version`/`--list-models`,
  interactive boot, and a real prompt against the default provider
  (`npm run release:local`). Add a fresh-environment install smoke as part of
  onboarding hardening.
- **Rollback posture:** the publish helper is idempotent and skips versions
  already on npm; re-run the tag workflow rather than re-running the release
  script for the same version.

## Agent guidance

- May do without asking: behavior-preserving refactors of fork-owned code, docs,
  tests, CI hygiene, and changelog updates — committing only files changed in
  this session via explicit paths.
- Requires approval: new runtime dependencies, core behavior changes, releases,
  force-pushes, and anything that mutates the GitHub repo or upstream.
- Direction and runbooks: this file, root `AGENTS.md`, `CONTRIBUTING.md`,
  `docs/RELEASING.md`, and the sibling `my-pi/docs/` (fork-patch inventory,
  cache strategy, platform program).

## Open questions

- Which platform primitives are ready to PR upstream next (owner: @valkyriweb)
  — tracked in `my-pi/docs/pi-fork-patch-inventory.md`.
- What the minimum viable quickstart covers (providers, extension install,
  binary vs npm) and where it lives (README vs docs site).
