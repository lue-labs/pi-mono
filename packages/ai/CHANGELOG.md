# @valkyriweb/pi-ai

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

## Unreleased

- Add GPT-5.6 prompt-cache breakpoints support: `OpenAIResponsesCompat.promptCacheApi: "breakpoints"` omits the deprecated `prompt_cache_retention` param and emits explicit `prompt_cache_breakpoint` markers on the stable system-prompt prefix (split at `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) and the previous user message. Default stays `"legacy"`; GPT-5.6 (Sol/Terra/Luna) opts in via the generated catalog. OpenAI SDK bumped to 6.46.0.
- Add `max` thinking level (GPT-5.6+ effort above `xhigh`, opt-in via `thinkingLevelMap`); other providers clamp it to their highest supported level. GPT-5.6 drops `minimal`.
- Add opt-in `ultra` for GPT-5.6 Sol/Terra. It is a client orchestration mode and always serializes as native OpenAI `max` effort; unsupported models clamp to their highest declared level.
- Regenerate model catalogs: GPT-5.6 family with real cache-write pricing (1.25× input); models.dev drops legacy Claude 3.x/4.0 entries.

- Fix: OpenAI Responses usage parsing now records provider-compatible cache-write metadata without double-counting Anthropic-style total + breakdown fields.
- Fix: Codex Responses adapter no longer forwards `prompt_cache_retention` (the ChatGPT `chatgpt.com/backend-api` backend now rejects it with `Unsupported parameter`, 400ing every Codex request). Cache affinity is preserved via `prompt_cache_key` + `session-id`. See root `FORK-CHANGELOG.md`.
- Add Anthropic tool namespace serialization support with a `PI_ANTHROPIC_NAMESPACE_WIRE=0` kill switch so grouped deferred tools can be emitted without changing flat-tool behavior when disabled.
- Refactor (fork-delta reforge slice 6, no behavior change): extracted the fork's cohesive additions from `api/anthropic-messages.ts` (+854 → +628 vs upstream) into fork-owned modules — `api/anthropic-thinking-recovery.ts` (signed-thinking-block 400 detection + strip-retry), `api/anthropic-server-tools.ts` (server tool result summarization), `api/anthropic-cache-split.ts` (`splitSystemPromptForCache`), and `api/anthropic-tool-serialization.ts` (deterministic memoized tool conversion + deferred-tool detection; the `convertedToolCache` WeakMap moved with its only writer, preserving singleton semantics). All moved bodies are verbatim; request bytes (system blocks, tools[], messages) unchanged. Namespace wire maps, beta-header merge, and the pause_turn resume loop stay inline (upstream value dependencies).

This file is fork-owned (`.gitattributes` `merge=ours`) so upstream syncs no
longer append their full changelog here.
