# Releasing

> **Current automation:** releases run through `.github/workflows/release.yml`
> and Changesets on `main`, publishing the restricted `@valkyriweb/*` scope to
> GitHub Packages. The older local tag, public-npm OIDC, and WebAuthn paths below
> are not canonical. Do not run them unless a maintainer explicitly selects the
> legacy fallback after reviewing it.
>
> **Blocked:** the workflow and `.changeset/config.json` still reference the
> removed `packages/orchestrator`, and the documented/fixed package set does not
> match all publishable workspaces. Reconcile those surfaces before the next
> release; do not infer a lockstep package set.

Canonical release runbook for `valkyriweb/pi-mono`. The root `AGENTS.md`
"Releasing" section is the agent-facing copy; this document is the human-facing
source of truth. Keep the two in sync, and when a step changes, change it here first.

## Model

**Lockstep versioning.** All four publishable packages share one version and are
released together:

- `@valkyriweb/pi-ai`
- `@valkyriweb/pi-agent-core`
- `@valkyriweb/pi-tui`
- `@valkyriweb/pi-coding-agent`

`patch` = fixes + additions. `minor` = breaking changes. There are no major
releases.

## Steps

### Update changelogs

Each package's `[Unreleased]` section must reflect what shipped. Run the `/cl`
prompt against the latest commit on `main` first if it has not been run; it
audits and updates every package's `[Unreleased]` section. Fork-wide
operational changes that do not belong to a package go in root
`FORK-CHANGELOG.md`.

### Local smoke test

Build an unpublished release and smoke test it from outside the repo so it
cannot resolve workspace files:

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

Verify Node and Bun startup, model/account listing, interactive startup, and at
least one real prompt against the intended default provider. Failures are
release blockers unless the maintainer explicitly accepts the risk.

### Run the release script

CI publishes to npm; the local script handles version bump, changelog
finalization, commit, tag, and push.

```bash
PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch   # fixes + additions
PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor   # breaking changes
```

`npm_config_min_release_age=0` belongs to the release command alone, where it lets the
release lockfile refresh proceed when a workspace package version was published
recently. Review any lockfile or shrinkwrap diff the release creates before the
push.

The script bumps all package versions, finalizes changelogs, regenerates release
artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds
fresh `## [Unreleased]` sections, commits `Add [Unreleased] section for next
cycle`, then pushes `main` and the tag. **Do not re-run the release script after
a tag has been pushed.**

### CI publishes the packages

Pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The
`publish-npm` job uses npm trusted publishing via GitHub Actions OIDC
(environment `npm-publish`). No local `npm publish`, `npm whoami`, OTP, or
WebAuthn flow is required for the OIDC path.

### When CI publish fails

Inspect the failed `publish-npm` job. The publish helper is idempotent and skips
versions already present on npm, so re-run the tag workflow after fixing CI or a
transient npm issue. Do not re-run `npm run release:patch` / `release:minor` for
the same version.

## Local manual-publish fallback (WebAuthn)

Only if the OIDC path is unavailable and you must publish locally:

1. `npm whoami` must succeed first (`npm login` if not).
2. `npm publish` uses WebAuthn 2FA. Prefer running the publish command yourself
   so you can open the npm auth URL immediately.
3. When npm prints an auth URL, cmd/ctrl-click it, log in, and pick
   "don't ask again for N minutes" if offered. This can happen more than once.
4. After a failed publish, only re-run the publish command, never
   `npm run release:patch` / `release:minor`.

## Gates that must be green before release

- `npm run check` (full output; fix all errors, warnings, infos).
- `npm run build` → includes `test:build-gate` (prompt-cache / system-prompt
  boundary tests).
- `./test.sh` for touched packages.
- The sibling `my-pi` extension gate when extension/harness contracts changed.
