# Fork upstream sync 2026-07-11 — 0.80.3 → 0.80.6 (upstream deferred-tools collision)

Worktree: `pi-mono-fork-update`, branch `lue/pi-upstream-20260711-115942`.
Base (fork): `origin/main` = 14690a97e. Upstream tip: 4c1861033 (v0.80.6; carries v0.80.4/0.80.5, 202 commits).
Merge commit: `b6d7fa6c8` (two-parent). Follow-ups: `4daad3cfd` (lockfiles/changelog), `81d417ba1` (pipeline restore + typing fallout). 121 conflicted files.

## What changed upstream (the big one)
Upstream 0.80.4–0.80.6 shipped its **own client-side deferred-tools/tool-search
implementation**, structurally parallel to the fork's long-standing pipeline:

- `packages/ai/src/utils/deferred-tools.ts` (new): `splitDeferredTools(context, supported)`.
- Compat flags: `OpenAIResponsesCompat.supportsToolSearch`,
  `AnthropicMessagesCompat.supportsToolReferences` (+ `defaultSupportsToolReferences`).
- Message-anchored loading: `ToolResultMessage.addedToolNames` populated by
  upstream's agent loop; providers re-inject loaded tools as `tool_search_call` /
  `tool_search_output` items (openai) or `tool_reference` sibling content (anthropic).
- `estimate.ts` rewritten around `addedToolNames` accounting; regression test in
  the 6162 suite depends on the field being populated.

The fork already has all of this, differently and deeper (native `defer_loading`
beta + `buildWireNameMaps`/`canonicalToWire`/`convertedToolCache` on anthropic,
`promptCacheApi: "breakpoints"` on openai-responses, `emitDeferLoading` +
`tool_search` sibling on codex, fork `estimate.ts` with `tool_reference` char
accounting). **Fork architecture wins on every colliding surface.**

## Resolution rules applied (same as prior syncs)
- Tool/cache pipeline files (`anthropic-messages.ts`, `openai-responses.ts`,
  `openai-responses-shared.ts`, `openai-codex-responses.ts`, `estimate.ts`,
  6162 test): **ours**. Upstream's `addedToolNames` regression test NOT adopted —
  fork's agent-session/runner never populates the field.
- Upstream's parallel impl arrives as dead code: `utils/deferred-tools.ts` is
  unreferenced after resolution; compat fields `supportsToolSearch` /
  `supportsToolReferences` exist in types (harmless, defaulted) but nothing
  fork-side consumes them. Candidates for deletion in a follow-up.
- Orthogonal upstream features: **theirs/adopted** — cache-miss transcript
  notices (`showCacheMissNotices`), `before_provider_headers` extension seam
  (fork claude-bridge headers folded into `mergeProviderAttributionHeaders` +
  `emitBeforeProviderHeaders`), package `autoload:false` delta filter (combined
  with fork `defaultLoad`), `forkSessionOrExit`/`--fork-session` (threaded
  through fork `SessionHydrationOptions`), `retry.ts` superset, `max` thinking
  level + `theme-schema.json` `thinkingMax`, `details: T` required tool-result
  typing + `AgentSettledEvent`, codex websocket 55-min age limit,
  `(no tool output)` placeholder, OpenAI Responses min `max_output_tokens=16`.
- Generated catalogs keep the fork snapshot (ADR 0002): `openai.models.ts` keeps
  fork GPT-5.6 (`breakpoints`, 1050000 ctx, `ultra`) — upstream 272k+price-tiers
  variant NOT taken. Pure thinking-map additions taken theirs. `generate-models.ts`
  merged: upstream `supportsOpenAiMax(model)` + copilot extended-ctx +
  `missingOpenAiModels`; fork `supportsOpenAiUltra` + missing Opus/Sonnet/Gemini kept.
- Scope: auto-merged upstream `@earendil-works/pi-*` imports rescoped to
  `@valkyriweb/pi-*`; loader compat alias maps, `OFFICIAL_PACKAGE_NAME`,
  config.test.ts, and doc comments deliberately stay on upstream scope.
- Lockfiles regenerated, never hand-merged.

## Post-merge fallout (commit 81d417ba1) — auto-merge leaks
Auto-merged (non-conflicted) hunks let upstream's parallel pipeline leak into
fork-resolved files; tsc caught all of it (~45 errors):

- `anthropic-messages.ts`: upstream's `convertMessages` signature (no `model`
  param, pre-transformed messages) + orphaned `convertToolResult`/`siblingContent`
  landed around fork-resolved hunks → restored fork `convertMessages(messages,
  model, …)` with internal `transformMessages(…, normalizeToolCallId)` and
  toolResults-only user message; deleted upstream helper. Kept
  `supportsToolReferences` compat default (dead but typed).
- `openai-responses-shared.ts`: upstream `tool_search_call`/`tool_search_output`
  injection block inside `convertResponsesMessages` → removed (fork pipeline
  handles deferred loading at the tools[] layer).
- `openai-codex-responses.ts`: `splitDeferredTools` call + `deferredTools`
  option → removed; kept websocket age-limit feature.
- `openai-responses.ts`: `Required<OpenAIResponsesCompat>` now includes
  `supportsToolSearch` → defaulted `false` in `getCompat`.
- `utils/validation.ts`: upstream inlined-away `isRecord`/`isJsonSchemaObject`
  helper defs while fork-only stringified-JSON pre-parse regions still call
  them → re-added the two helpers.
- `details: T` required: fork-owned `tools/agent.ts` control actions get
  `emptyControlDetails()` fallback; ~20 mechanical `details: {}` adds across
  fork tests/examples; upstream-added tests adapted to fork APIs
  (`createRunner(result)` for the 7-arg `ExtensionRunner`, `pickModel` instead
  of literal-id `getModel` per test-helper convention).

## Flagged for review (not resolved here)
1. **Dead upstream deferred-tools code**: `packages/ai/src/utils/deferred-tools.ts`
   + `supportsToolSearch`/`supportsToolReferences` compat fields are unreferenced.
   Keep (reduces future merge conflicts) or delete — decide next sync.
2. **openai.models.ts GPT-5.6**: fork snapshot kept; upstream's 272k-context +
   price-tier entries diverge. Revisit if fork regenerates catalogs.
3. **`addedToolNames` accounting**: upstream populates it in its agent loop and
   uses it for estimate + reinjection; fork ignores it entirely. If a future
   upstream feature depends on it, this becomes a real port.

## Verification
- `npm run check` fully green: biome, changelog, pinned-deps, ts-imports,
  shrinkwrap, install-lock, `tsc --noEmit`, browser-smoke.
- Workspace test suites + fork build gate: see PR description for final status.
