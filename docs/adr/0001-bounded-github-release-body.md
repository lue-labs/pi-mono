# 1. Bound the GitHub Release body instead of slimming upstream-owned changelogs

Date: 2026-06-09

Status: Accepted

## Context

The `Release` workflow publishes the fork's `@lue-labs/*` packages with
`changesets/action`. Its default `createGithubReleases: true` builds each
package's GitHub Release body from that package's `CHANGELOG.md`, by matching a
heading whose text **equals** the version (`## 0.31.0`).

In this fork the package `CHANGELOG.md` files are **upstream-owned**: they carry
`earendil-works/pi-mono`'s full Keep-a-Changelog history (`## [0.31.0] - 2026-01-02`),
accumulate via `.gitattributes` `*CHANGELOG.md merge=union` on every upstream
sync (`coding-agent` is 400KB+), and Changesets is configured `changelog: false`
so it never writes them. The fork's own release notes live in `FORK-CHANGELOG.md`.
This split is a deliberate prior decision (see `FORK-CHANGELOG.md`) made to stop
changesets and upstream's manual changelog hard-conflicting on every sync.

Consequence: the bracket+date heading never matches the version, so
`changesets/action` falls back to dumping the **entire** `CHANGELOG.md` as the
Release body. That exceeds GitHub's 125000-char Release-body cap, the create
`422`s ("body is too long"), and the whole publish job reds — sometimes after
packages are already on the registry but before every Release is cut.

## Decision

Fix the failure at the **release step**, not by rewriting the changelogs:

- Set `createGithubReleases: false` on `changesets/action`.
- Add `.github/scripts/create-github-releases.mjs`, a post-publish step that cuts
  one GitHub Release per just-published package with a small, bounded body that
  points at `FORK-CHANGELOG.md` — never the upstream changelog. Idempotent.

Leave the upstream-owned `CHANGELOG.md` files and `merge=union` **untouched**, so
the prior changelog-ownership decision stands.

## Consequences

- Publishing never reds on changelog size again; a Release is always created.
- Release bodies no longer contain per-version notes — they link to
  `FORK-CHANGELOG.md`. Acceptable: that file is already the fork's source of truth.
- Mirrors the identical fix in the sibling `my-pi` repo (#139), keeping both
  release pipelines consistent.

## Deferred alternative — slim the upstream changelogs

A more invasive option was considered and **deferred**: archive each
`packages/*/CHANGELOG.md` to `CHANGELOG.upstream.md` (frozen reference), reset the
live file to a fork-owned stub, and flip `merge=union → merge=ours` so upstream
syncs stop re-bloating it (~400KB → ~400B). This reverses the upstream-ownership
model, so it should be done deliberately as its own change with a follow-up ADR —
not bundled with the release hotfix. A draft branch exists
(`fix/changelog-archive-reset`, PR closed) as a starting point.
