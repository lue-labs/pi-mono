# Releasing

Canonical release runbook for `valkyriweb/pi-mono`. The root `AGENTS.md`
"Releasing" section is the agent-facing copy; this document is the human-facing
source of truth. Keep the two in sync — if a step changes, change it here first.

## Model

Releases are driven by **Changesets** and published by
`.github/workflows/release.yml`. There is no local publish step in the normal
flow: a maintainer never runs `npm publish`, `npm whoami`, OIDC, or WebAuthn.

**Lockstep versioning.** The five publishable packages are a Changesets `fixed`
group — they share one version and are versioned/published together:

- `@valkyriweb/pi-ai`
- `@valkyriweb/pi-agent-core`
- `@valkyriweb/pi-tui`
- `@valkyriweb/pi-coding-agent`
- `@valkyriweb/pi-orchestrator`

Bump type is set by the changeset: `patch` = fixes + additions, `minor` =
breaking changes. No major releases.

Packages publish to **GitHub Packages** (`npm.pkg.github.com`, `restricted`
access), authenticated with the workflow `GITHUB_TOKEN` — not npmjs.com.

## How a release happens

### 1. Land a changeset with your change

Every PR that changes a publishable package includes a changeset committed
alongside the code:

```bash
npm run changeset      # interactive: pick bump (patch/minor), write a summary
```

This writes a markdown file under `.changeset/`. Because the packages are a
`fixed` group, choosing a bump for any one of them versions all five together.
`changelog` generation is disabled (`.changeset/config.json` → `changelog:
false`), so keep human-facing notes in each package's `CHANGELOG.md`
`[Unreleased]` section and fork-wide operational notes in root
`FORK-CHANGELOG.md`. Run `/cl` against the latest `main` if changelogs are
stale.

Check what is pending at any time:

```bash
npm run changeset:status
```

### 2. Push to `main` → Version Packages PR

When commits with unreleased changesets reach `main`,
`.github/workflows/release.yml` runs the release gate
(`test:system-prompt`, `test:cache-stability`, `test:e2e`, `npm run check`) and
then `changesets/action`, which opens or updates the
**`chore(release): version fork packages`** PR. That PR runs
`npm run version-packages` (`changeset version` + lockfile/shrinkwrap refresh)
to consume the changesets, bump all five package versions, and update
changelogs.

The PR is authored with the `valkyriweb-clawsweeper` GitHub App token
(`CLAWSWEEPER_APP_PRIVATE_KEY` secret) so it triggers required PR checks instead
of needing `--admin`. Review it like any other PR.

### 3. Merge the Version Packages PR → publish

Merging the Version PR pushes the bumped versions to `main`, which re-runs
`release.yml`. With no pending changesets, `changesets/action` now runs
`npm run publish:changesets` (`changeset publish`) and publishes the five
packages to GitHub Packages. The workflow then:

- runs `.github/scripts/create-github-releases.mjs` to cut a bounded GitHub
  Release per published package (body points at `FORK-CHANGELOG.md`, never the
  400KB upstream changelog);
- if `@valkyriweb/pi-coding-agent` (the CLI) was bumped, calls the reusable
  `build-binaries.yml` to build the 6-platform compiled binaries and a
  `v<version>` GitHub Release in the same trusted run.

Support-package-only releases (no coding-agent bump) skip the binary build.

### 4. If the publish run fails

Inspect the failed `release` (or `binaries`) job in the Release workflow.
`changeset publish` is idempotent and skips versions already present on the
registry, so re-run the workflow (`workflow_dispatch` or re-push) after fixing
CI or a transient registry issue. Do not hand-publish.

## Local smoke test (optional, pre-merge)

To validate a build before releasing, build an unpublished release and smoke
test it from outside the repo so it cannot resolve workspace files:

```bash
npm run release:local -- --out /tmp/pi-local-release --force
cd /tmp

# Node package
/tmp/pi-local-release/node/pi --help
/tmp/pi-local-release/node/pi --version
/tmp/pi-local-release/node/pi --list-models
/tmp/pi-local-release/node/pi -p "Say exactly: ok"
/tmp/pi-local-release/node/pi        # interactive — run in tmux, submit a prompt, await reply

# Bun binary
/tmp/pi-local-release/bun/pi --help
/tmp/pi-local-release/bun/pi --version
/tmp/pi-local-release/bun/pi --list-models
/tmp/pi-local-release/bun/pi -p "Say exactly: ok"
/tmp/pi-local-release/bun/pi          # interactive — same check
```

`release:local` only builds a local artifact; it never publishes.

## Deprecated: local `release:patch` / `release:minor`

The `scripts/release.mjs` tag-and-push flow (`npm run release:patch|minor`) is
superseded by the Changesets workflow above and is **not** an authorized release
path — the old `push: tags: v*` trigger it relied on is gone, so the tags it
pushes no longer build binaries or publish. Do not run it as part of a release.

## Gates that must be green before release

The Release workflow enforces these itself; run them locally when preparing a
change:

- `npm run check` (full output; fix all errors, warnings, infos).
- `npm run test:system-prompt`, `npm run test:cache-stability`,
  `npm run test:e2e` (the workflow's release gate).
- `./test.sh` for touched packages.
- The sibling `my-pi` extension gate when extension/harness contracts changed.
