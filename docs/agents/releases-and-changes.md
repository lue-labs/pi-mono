# Releases and change records

Read when adding release metadata or preparing/publishing a release. Releases require explicit maintainer approval.

## Current release path

The canonical automation is [`.github/workflows/release.yml`](../../.github/workflows/release.yml):

1. A publishable change includes a Changeset.
2. A push to `main` lets `changesets/action` create or update the version-packages PR.
3. Merging that PR publishes restricted `@lue-labs/pi-*` packages to GitHub Packages through `npm run publish:changesets`.
4. When `@lue-labs/pi-coding-agent` is published, the workflow invokes `build-binaries.yml` to build release binaries.

Do not follow the legacy local tag/WebAuthn/public-npm flow in `scripts/release.mjs`. Do not run `release:patch`, `release:minor`, `release:major`, or `npm publish` unless the maintainer explicitly chooses the legacy path after reviewing it.

## Current package set

The Changesets fixed group must exactly match the nine publishable workspaces: AI, agent core, TUI, telemetry, protocol, client, server, SQLite session backend, and coding agent. Their package identities use the `@lue-labs` organization scope and publish in lockstep. The removed orchestrator workspace is historical and must not be reintroduced.

## Change records

- Add a Changeset for publishable package behavior unless the established Changesets tooling marks the change exempt.
- Fork-owned release notes belong in [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md) when required by `npm run check:changelog`.
- Do not edit package `CHANGELOG.md` files; this fork preserves them through merge policy, [`CONTRIBUTING.md`](../../CONTRIBUTING.md) reserves their updates for maintainers, and Changesets is configured with `"changelog": false`.
- Released history is immutable.
