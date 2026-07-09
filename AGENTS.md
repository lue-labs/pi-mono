# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before making wide-ranging changes, before editing files you have not already fully inspected, and when the user asks you to investigate or audit something. Do not rely only on search snippets for broad changes.
- Add custom Pi functionality as a `my-pi` extension or pi package first. Modify `packages/coding-agent` core only when documented extension/package APIs cannot achieve the behavior.
- Use the extension hook/action/filter surfaces for fork-only composition before editing core: `pi.hooks.removeAction("load", id)`, `addAction`, `addFilter`, and `applyFilters`. Keep environment/tool aliases in extensions such as `~/Projects/personal/my-pi/extensions/native-tool-aliases/` unless core lacks the seam.
- For Pi behavior changes, read only the relevant local docs/examples first, then implement through hooks, filters, actions, or a `my-pi` extension when the documented extension/package API can express it. Edit `packages/coding-agent` core only after recording the missing extension seam.
- When upstream changes a built-in tool that a local extension wraps or aliases (for example `read` → `Read`), compare `upstream/main:packages/coding-agent/src/core/tools/<tool>.ts` with the extension wrapper and port improvements in the extension first.
- Before core changes, read the local Pi docs for the touched surface and record why core is required.
- For every `pi-mono-fork` or `my-pi` modification/update, run Matt Pocock's architecture lens: `~/Projects/agent-scripts/skills/matt-pocock/references/improve-codebase-architecture.md`; apply only local, incremental simplifications unless Luke asks for a larger refactor.
- No `any` types unless absolutely necessary
- Single-line helper functions with a single call site are forbidden; inline them instead.
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports. **Sole exception:** the lazy mode-dispatch imports in `packages/coding-agent/src/main.ts` (interactive/rpc/export/session-picker/startup-ui) are intentionally dynamic to keep the TUI tree out of the headless boot path — do not "clean up" these back to static imports (boot-perf regression).
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Use only erasable TypeScript syntax compatible with Node strip-only mode in TypeScript checked by the root config (`packages/*/src`, `packages/*/test`, and `packages/coding-agent/examples`). Do not use constructor parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other TypeScript constructs that require JavaScript emit. Use explicit fields and constructor assignments instead of parameter properties.
- Always ask before removing functionality or code that appears to be intentional
- Do not preserve backward compatibility unless the user explicitly asks for it
- Never hardcode key checks with, eg. `matchesKey(keyData, "ctrl+x")`. All keybindings must be configurable. Add default to matching object (`DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`)
- NEVER modify `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts` instead.

## Pi Setup Registry

Canonical setup registry lives in `~/Projects/personal/my-pi/docs/pi-setup/`, not this fork. Runtime/provider/cache/tool/fork-patch changes here should update the my-pi catalog/governed docs; generated registry files are refreshed from my-pi scanners and must not be hand-edited here.

- TEMP 2026-05-20: Claude Code 2.1.145 read-truncation handoff lives at `packages/coding-agent/docs/claude-code-2.1.145-read-truncation-handoff.md`; delete this AGENTS.md line after seen/triaged.

## Mac resource pressure

If work changes child agents, tool loading, MCP adapters, monitors, background commands, session storage, prompt/cache behavior, or local runtime cleanup, read `~/Projects/personal/mac-resource-ops/VISION.md` and `~/Projects/personal/mac-resource-ops/docs/resource-graph.md` first. Prefer cheap child context where safe, lazy/deferred tools, bounded jobs, and explicit reaping/cleanup paths.

## Local Pi Docs

Read local docs before changing the matching surface:

- Extensions: `packages/coding-agent/docs/extensions.md` and `packages/coding-agent/examples/extensions/`.
- Packages: `packages/coding-agent/docs/packages.md` and `packages/coding-agent/examples/README.md`.
- SDK: `packages/coding-agent/docs/sdk.md` and `packages/coding-agent/examples/sdk/`.
- Core/source development: `packages/coding-agent/docs/development.md`, `packages/coding-agent/docs/index.md`, `packages/coding-agent/docs/tui.md`, and `packages/coding-agent/src/`.
- Fork-mode sub-agent cache (`context: "fork"`, `worker` agent, sibling fan-out cache parity, placeholder tool_results): `packages/coding-agent/docs/fork-cache-architecture.md`. Read before touching `core/agents/context.ts`, `core/agents/executor.ts` fork branch, or anything that captures parent's system prompt / active tools at turn-start.

## PR Review Gate

**Gate (run order):** `codex-review` → `code-craft-pr` → `matt-pocock/improve-codebase-architecture` → `docs-freshness-pr` (wire through `pr-pipeline-orchestrator`); resolve all Tier 1/2 findings and file Tier 3 as GitHub issues. This gate is the `.github/pull_request_template.md` checklist (mirrored in `my-pi`).

Flag P1 in local review when:

- Custom behavior is implemented in core without evidence that extension/package APIs are insufficient.
- A Pi setup/runtime change skips the `my-pi` catalog YAML or governed docs.
- The architecture lens above was skipped for a `my-pi` or `pi-mono-fork` modification/update.
- A PR misses a nearby safe simplification or duplicates extension/package glue that should be consolidated.

## Commands

- After code changes (not documentation changes): `npm run check` (get full output, no tail). Fix all errors, warnings, and infos before committing.
- Note: `npm run check` does not run tests.
- After changing core/package `src`, rebuild that package's dist so the change is live at runtime (pi runs built `dist`, not source): `npm --prefix packages/<pkg> run build`. Do NOT run the root `npm run build` casually — it chains `test:build-gate` → `test:e2e`, which hits real provider APIs and burns paid tokens. Use the root build (or `npm run release:local`) only when a cross-package release-style verification is intended.
- NEVER run: `npm test` (runs workspace e2e against real provider APIs / paid tokens).
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- Run tests from the package root, not the repo root.
- If you create or modify a test file, you MUST run that test file and iterate until it passes.
- When writing tests, run them, identify issues in either the test or implementation, and iterate until fixed.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` plus the faux provider. Do not use real provider APIs, real API keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` and name them `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, write the script to a temporary file (for example under `/tmp`) using `write`, run that file, edit it if needed, and remove it when it is no longer needed. Do not embed multi-line scripts directly in `bash` commands.
- NEVER commit unless user asks

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

## GitHub Actions Governance

When triaging GitHub checks, workflow failures, or branch status:

- Review `.github/workflows/*` and recent run history before assuming a check is required.
- Identify workflow ownership with `git log --follow -- .github/workflows/<file>`: upstream-inherited, fork-owned, or third-party automation.
- Keep only workflows that protect this fork's actual release/triage paths; disable noisy inherited workflows that do not serve `valkyriweb/pi-mono`.
- Check whether branch protection requires a status before disabling it. This fork currently has no protected `main` branch unless GitHub settings say otherwise.
- For scheduled workflows, verify they short-circuit before expensive/write work when there is nothing to do.
- ClawSweeper/CI agents should audit Actions from outside the workflow they are reviewing; a workflow should not be the sole authority on its own health.

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels to indicate which package(s) the issue affects
  - Available labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`
- If an issue spans multiple packages, add all relevant labels

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

Before pushing package code changes, update the matching `packages/*/CHANGELOG.md` under `## [Unreleased]`. The repo's `npm run check` enforces this via `check:changelog`. Workflow-only, docs-only, tests-only, and lockfile-only changes do not need package changelog entries.

Fork-wide operational changes that do not belong to a package changelog can also go in root `FORK-CHANGELOG.md`, but package code changes should include package changelog entries so releases ship usable notes.

For native-agent A/B testing, the installed `pi-subagents` extension manager command is locally aliased from `/agents` to `/subagents` so native `/agents` remains reachable. This patch lives in `~/.pi/agent/git/github.com/nicobailon/pi-subagents/src/slash/slash-commands.ts` and may need reapplying after `pi update`.

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

> Full human runbook: [`docs/RELEASING.md`](docs/RELEASING.md). The steps below are the agent-facing copy; keep both in sync.

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Verify npm authentication**: run `npm whoami` before starting the release script. If it fails, stop and tell the user to run `npm login` manually first, then retry after they confirm `npm whoami` succeeds.

4. **Brief the user on the WebAuthn flow before running anything**. Print exactly the following message and then stop and wait for the user to confirm in their next message:

   ```
   Before the release publish step, read this carefully:

   - `npm publish` uses WebAuthn 2FA.
   - The safest flow is for you to run the publish command yourself, because you can see and open the npm authentication URL immediately.
   - I will tell you the exact command to run.
   - When npm prints an auth URL, cmd/ctrl-click it, log in in the browser, and select the "don't ask again for N minutes" option if available.
   - This may happen more than once during publish.
   - Do not rerun `npm run release:patch` or `npm run release:minor` after a failed publish; only rerun the publish command I give you.

   Reply "ready" once you have read this and are ready to run the command locally.
   ```

   Do not proceed to step 5 until the user explicitly confirms.

The release script handles: version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.

5. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes npm packages**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

5. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
