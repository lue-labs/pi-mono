# Fork upstream sync 2026-06-23 — 0.79.8 → 0.80.2 (model-runtime migration)

Worktree: `pi-mono-fork-update-0801`, branch `lue/pi-upstream-20260623-0801`.
Base (fork): `origin/main` = 558518b5b. Upstream tip: 0201806ad (v0.80.2; carries v0.80.0/0.80.1). merge-base: 1287b69fe.

## What changed upstream (the big one)
0.80 ran the **model-runtime migration**: every provider *implementation* moved
`packages/ai/src/providers/<x>.ts` → `packages/ai/src/api/<y>.ts`, leaving
`providers/<x>.ts` as a thin `createProvider()` factory. A large new provider
catalog (`cerebras`, `deepseek`, `groq`, `xai`, `together`, `zai`, `minimax`,
`moonshotai`, `nvidia`, `huggingface`, `vercel-ai-gateway`, …) was added, each
with a `<x>.models.ts`. The old global API (`streamSimple`, `resetApiProviders`,
…) is now re-exported from `@earendil-works/pi-ai/compat` — the **sanctioned
migration bridge** (README §"Migrating from the Old Global API"). Upstream's OWN
coding-agent/agent still import from `/compat`; the fork mirrors that (no shims).

Renames: `providers/anthropic.ts` impl → `api/anthropic-messages.ts` (export
`streamAnthropic`→`stream`, `streamSimpleAnthropic`→`streamSimple`);
`amazon-bedrock`→`api/bedrock-converse-stream`; `google`→`api/google-generative-ai`;
`mistral`→`api/mistral-conversations`; `google-vertex`/`azure-openai-responses`
keep stems but move to `api/`. `@earendil-works/pi-ai/base` export **removed** in
0.80 → agent imports that used `/base` move to `/compat`.

## Method (no shims; proper re-port)
Reset `packages/ai/src` to upstream wholesale, then re-apply each genuine fork
patch via 3-way `git merge-file --diff3 -p <upstream-new> <base-old> <fork-old>`
(base/ours from old `providers/` path, theirs from new `api/` path). ~8 conflicts
on anthropic, fewer elsewhere — resolved by hand. Caller code (agent/coding-agent)
gets upstream's `/compat` imports + symbol moves via per-file 3-way too.

## Fork ai patches to preserve (genuine, fork-only)
- **Cache affinity**: `splitSystemPromptForCache`, `stripSystemPromptDynamicBoundary`
  (bedrock/google/google-vertex/mistral/anthropic system-prompt path).
- **Deferred tools / tool-search**: `supportsDeferredTools` compat field,
  `tool_reference` content block, `TOOL_SEARCH_BETA`/`shouldUseToolSearchBeta`,
  `convertOneTool`/`convertedToolCache`, `modelSupportsDeferredTools`.
- **Server tools**: `ServerToolSource`, `serverToolUses`, `summarizeServerToolResult`.
- **Thinking**: `"adaptive"` thinking level (all providers), `stripThinkingFromMessageParams`,
  `isLatestThinkingModifiedError`, small-output thinking-budget guard (#115).
- **Pause-turn resume**: `MAX_PAUSE_TURN_RESUMES`, `continuationContext`.
- **Misc**: `advisorModel`, `ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES`,
  `mergeHeadersWithAnthropicBetas`, codex no-`max_output_tokens` patch.

## ai/src files: disposition
- **Drop** (upstream relocated/removed; no fork patch): `api-registry.ts`,
  `base.ts`, `stream.ts`, `providers/{cloudflare,github-copilot-headers,
  google-shared,images/openrouter,openai-prompt-cache,register-builtins}.ts`.
- **3-way onto api/**: anthropic-messages, openai-codex-responses (+ codex
  max_output_tokens patch), openai-completions, openai-responses(-shared),
  simple-options, transform-messages, bedrock-converse-stream,
  google-generative-ai, google-vertex, azure-openai-responses,
  mistral-conversations.
- **Same-location 3-way**: `types.ts`, `utils/validation.ts`, `models.ts`,
  `cli.ts`, `providers/faux.ts`.
- **Take upstream**: `models.generated.ts` (regenerate after).
- **Relocate**: `providers/openai-codex-responses.test.ts` → `test/`.

## Anthropic 8-conflict resolutions (target api/anthropic-messages.ts)
1. import: keep BOTH `ProviderHeaders` (theirs) + `ServerToolSource` (ours).
2. prepend `const modelSupportsDeferredTools = !model.id.toLowerCase().includes("haiku");`.
3. take theirs' `?? true` compat defaults; INSERT `supportsDeferredTools: model.compat?.supportsDeferredTools ?? modelSupportsDeferredTools`.
4. keep BOTH theirs' `hasHeader`/`assertRequestAuth` AND ours' `mergeHeadersWithAnthropicBetas`.
5. keep ours' small-output thinking-budget guard; rename `streamAnthropic`→`stream`.
6. keep ours' `useToolSearchBeta: boolean` param + theirs' `optionsHeaders?: ProviderHeaders` type.
7. take theirs (drop inline cloudflare-ai-gateway block — upstream removed it).
8. take theirs' `defaultHeaders,` (upstream precomputes with betaFeatures at L870);
   ensure `if (useToolSearchBeta) betaFeatures.push(TOOL_SEARCH_BETA)` present.
Then global-replace residual `streamAnthropic(`→`stream(`, `streamSimpleAnthropic(`→`streamSimple(`;
drop unused `resolveCloudflareBaseUrl` import.

## Actual resolution outcomes (2026-06-23)

**Merge**: real two-parent commit, parents = origin/main `558518b5b` + v0.80.2 `0201806ad`. No shims of our own — upstream `/compat` is mirrored only as a temporary baseline, then deleted from src in the immediately-following step-2 commit.

**Config conflicts** (all preserve fork identity):
- `package.json` ×4 — kept `@valkyriweb/*` scope, exact-pinned internal deps at `0.80.2`.
- `tsconfig.json` — dropped the stale `@valkyriweb/pi-ai/openrouter-images` path mapping (now a built-in, below).
- `vitest.config.ts` (coding-agent) — rewrote for 3-scope symmetry; dropped `/base` + `/openrouter-images` aliases, added `/compat`.
- `.github/workflows/build-binaries.yml` — took HEAD (fork): no `publish-npm` leak to public registry.
- `package-lock.json` + `npm-shrinkwrap.json` regenerated (not hand-merged); `check:shrinkwrap` green.

**openrouter-images = ADOPT UPSTREAM**, not a dropped fork feature. 0.80 ships it built-in (`api/openrouter-images.ts` + `register-builtins.ts`); the fork's old `/openrouter-images` subpath export is retired.

**SRC re-ports (fork-only behavior the blind merge dropped):**
- `core/auth-storage.ts` — restored `fallbackResolver` field + `setFallbackResolver()` (custom credential-resolver chain). Reconciled with upstream's new early `includeFallback === false` guard: that guard subsumes the fork's old wrapper, so the custom-resolver loop now runs unconditionally after env fallback. Sole `{includeFallback:false}` caller (`model-registry.ts getApiKeyAndHeaders`) resolves providerConfig/env itself afterward, so stored-creds-only-when-false is correct.
- `core/tools/edit-diff.ts` + `core/tools/edit.ts` — preserve the fork's `DiffHunk` rich-diff feature (`structuredPatch` hunks + `originalContent`, consumed by the TUI edit renderer) **and** its strict exact-text matcher. ⚠️ **Correction:** upstream 0.80 did NOT leave `edit-diff.ts` byte-identical — it dropped `DiffHunk` *and* replaced strict matching with fuzzy matching (`normalizeForFuzzyMatch`/`fuzzyFindText`). The first-pass merge mistakenly took upstream's fuzzy body; the `./test.sh` gate caught it (see Gate results §5). Resolution: since `edit.ts` is byte-identical to fork-tip, `edit-diff.ts` is restored to fork-tip wholesale (strict + `DiffHunk`), and `tools.test.ts` drops the 2 upstream fuzzy-acceptance tests. The fork deliberately rejects fuzzy edits.

**Dispatch routing (baseline → /compat, migrated off in step 2):** `pi-model-caller.ts` (`completeSimple`) and `interactive-mode.ts` (`getProviders`) temporarily import from `@valkyriweb/pi-ai/compat`; type-only `Api`/`Model` stay on the root barrel.

**TEST import migration:** ~50 `packages/ai/test` files + coding-agent tests rewired from old `providers/*`/root-barrel paths to the relocated `api/*` modules and `/compat`, preserving the fork's `pickModel` helper (proven via unchanged `pickModel` occurrence count — never swapped for `getModel`). coding-agent test type fixes: `config.test.ts` (`sourceUpdateCommand` 4th-arg form), `helpers/models.ts` split (`getModels`→compat, `getSupportedThinkingLevels`→models.ts), `suite/harness.ts` faux-provider via compat.

**Sequencing:** (1) this baseline merge = v0.80.2 green, dispatch temporarily on `/compat`, types on root barrel; (2) immediately-following commit = adopt the `Models` runtime in ModelRegistry + re-port fork auth onto it, delete every src `/compat` import.

## Gates (mandatory, from 2026-06-19 log)
`npx tsgo --noEmit` → `npm run check` → `./test.sh` (entrypoint sync makes check
pass while tests red) → build all 4 workspaces → `npm --prefix pi-mono-fork run
test:build-gate`. FORK-CHANGELOG.md entry **in the merge commit itself**
(`check-changelog-updated.mjs` diffs committed `origin/main...HEAD`). Re-verify
`scripts/check-browser-smoke.mjs` provider paths against final `api/` layout.

## Gate results (2026-06-23)

All gates green. `./test.sh` (offline: `auth.json` moved aside, ~60 API-key envs unset, `PI_NO_LOCAL_LLM=1`) proved a hard body-integrity gate — it caught **five** regressions that `tsgo --noEmit` / `npm run check` passed clean over.

**Final tallies**
- `npm run check` (tsgo + biome `--error-on-warnings` + browser-smoke): **EXIT 0**
- `npm run build` (tui→ai→agent→coding-agent, per-pkg `tsgo -p tsconfig.build.json`): **EXIT 0**
- `npm run test:build-gate`: **51/51 suites** (~55s)
- `./test.sh`: agent **173 passed** / 0 fail (17 files) · ai **459 passed** / 0 fail / 727 skipped (98 files) · coding-agent **2050 passed** / 0 fail / 47 skipped (225 files) · tui **703 pass** / 0 fail

**Five issues tsgo could not see** (each a body-integrity, not type, defect):

1. **`packages/agent/vitest.config.ts` — single-scope alias.** The merge left the resolve aliases at `@earendil-works/*` only; fork src imports `@valkyriweb/{pi-ai, pi-ai/compat, pi-agent-core}`. Every agent test file failed to resolve at import. Rewrote to multi-scope (valkyriweb + earendil-works + mariozechner × {pi-ai, pi-ai/compat, pi-agent-core}). → 173 pass.
2. **`packages/ai` cloudflare env-precedence test — merge-mangled body.** The 3-way merge corrupted the fork's "provider env before `process.env` for the Cloudflare AI Gateway base URL" test (dropped the `env:` override, mis-set the expectation). Restored fork intent; reconfirms src provider-env precedence (`getProviderEnvValue` = `env?.[name] || process.env[name] || sandbox`). → 9/9.
3. **dist must be built before `./test.sh`.** Extension/resource loaders + subprocess tests resolve runtime `import("@valkyriweb/pi-*")` through `package.json` exports → `dist/`. `tsgo --noEmit` (check) emits nothing and `test.sh` does not build, so a stale/unbuilt dist failed extensions-discovery + resource-loader suites. Build-before-test is now explicit in the gate order.
4. **Faux dynamic-provider harness — dropped `streamSimple` field** (`test/suite/harness.ts` + `test/suite/agent-session-model-extension.test.ts`). 0.80's `FauxProviderRegistration` (from the now-`/compat` `registerFauxProvider`) no longer exposes `.streamSimple`; the merge substituted a generic `streamSimpleCompat` into the model-registry dynamic-provider `config`. That generic path never drains the faux core's `pendingResponses`, so the recording response-factory was never invoked → parent **and** child recorded **0 contexts** (fork-agent assertions failed; agent-session tests hung to their 30s timeouts — the cause of the earlier ~340s `test.sh` wall-clock). Upstream's own 0.80 harness carries **no** `streamSimple:` field: `registerFauxProvider` registers the faux api globally via `registerApiProvider({api,stream,streamSimple}, sourceId)`, and `model-registry.ts` dispatches a `config.api` provider through that global registry without an explicit `streamSimple`. Fix = delete the field + its `streamSimple as streamSimpleCompat` import alias in both files, matching upstream. The drop from ~340s → ~30s `test.sh` wall-clock is the regression-cleared signal.
5. **`core/tools/edit-diff.ts` — strict-exact matcher silently replaced by upstream's fuzzy matcher.** Upstream 0.80 swapped the fork's strict exact-text edit matching for fuzzy matching (`normalizeForFuzzyMatch` + `fuzzyFindText`) **and** dropped the fork's `DiffHunk` interface. The first-pass merge took upstream's fuzzy body and re-added only `DiffHunk`, silently discarding the fork's strict behavior — which the fork **deliberately** keeps (11 explicit "should reject …fuzzy" tests; silent smart-quote/whitespace normalization can corrupt code without the agent's consent). `edit.ts` is byte-identical to fork-tip, so `edit-diff.ts` is its matched pair → restored fork-tip's `edit-diff.ts` (strict + `DiffHunk`) wholesale and fork-tip's `tools.test.ts` (dropping the 2 upstream fuzzy-acceptance tests that contradict the fork stance). No file outside `edit-diff.ts` consumes upstream's fuzzy exports. **Deliberate divergence, not a deferral — no tracking issue.** (Flagged to Luke: trivially reversible to adopt upstream fuzzy by keeping the merged body + dropping the 11 reject tests.)

**Known flake (out of scope):** `session-id-readonly.test.ts` can fail on macOS when `/var`→`/private/var` realpath canonicalization defeats the read-only-dir assertion; passed in the final run and is pre-existing (0.79.8 precedent), not a migration regression.

**Dropped NEW upstream tests** tracked in `valkyriweb/pi-mono#117` (anthropic-temperature-compat ×4, supports-xhigh ×11, openai-completions-tool-choice ×7) — these need fork-side backfill; distinct from the edit-diff fuzzy tests, which are a deliberate permanent divergence.
