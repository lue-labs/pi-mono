# @valkyriweb/pi-ai

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

## Unreleased

- Fix: `StringEnum` now declares its type parameter `const`, so inline value arrays keep their literal union types instead of widening to `string`. Previously any schema built from `StringEnum([...])` lost its literal union at the call site, and object literals flowing into a `Static<>` of such a schema failed TS2379 under `exactOptionalPropertyTypes`. No call-site changes required.

- Fix: recover from Anthropic's latest-assistant thinking-signature 400 by stripping only that assistant turn's `thinking`/`redacted_thinking` blocks, preserving all earlier signed reasoning and the byte-stable system/tool cache prefix while reporting the one-turn reasoning loss.

- Fix: the Anthropic pause_turn resume loop tracked the raw stop reason in both a local and `output.rawStopReason`, but only reset the local. A resumed call that ended without a `message_delta.stop_reason` left `"pause_turn"` visible to callers — the value the loop exists to hide. The local is gone; the field is the single source of truth, matching every other adapter.

- Fix: `cacheRetention: "none"` (Codex Responses) no longer clears the local Pi session id. The retention gate now applies only to provider-retained state — `prompt_cache_key`, the provider-visible `session-id` header, and `previous_response_id` continuation, which is dropped by downgrading the transport from `websocket-cached` to `websocket`. Thread id, SSE-fallback tracking, WebSocket connection keying, and debug stats stay keyed to the real session id.

- Fix: stop replaying thinking blocks older than the last real user turn (`anthropic-messages`). Anthropic discards them, so replaying re-cached the whole accumulated thinking mass at every user boundary — measured at 772,212 wasted cache-write tokens in one live session, with a single 162,804-token rewrite against 167,501 tokens of accumulated thinking. A live A/B on identical history shows 1,246 write tokens per boundary with replay versus 0 when stripped (warmth 95% → 100%). Blocks at or after the boundary are untouched (Anthropic validates the latest assistant message's signed blocks); only signed/redacted blocks are dropped, so `allowEmptySignature` compat providers keep replaying their own reasoning. Escape hatch: `PI_STALE_THINKING_REPLAY=1` ([#446](https://github.com/valkyriweb/pi-mono/issues/446)).
- Feat: opt-in `compat.inlineDeferredTools` (anthropic-messages) — message-anchored schema delivery for gateways without the native deferral wire (`supportsToolReferences: false` lanes such as the clawrouter CC adapter / claude-bridge OAuth). Tools activated mid-session via toolResult `addedToolNames` are permanently excluded from wire `tools[]`; their full definition is delivered once as a `<tool-loaded>` text block after the activating tool_result, keeping the prompt-cache prefix byte-stable (previously each activation re-billed the full prefix, observed 109k tokens) ([#372](https://github.com/valkyriweb/pi-mono/pull/372)).

- Fix: preserve valid OAuth/deferred `tool_reference` blocks by normalizing canonical names to their serialized Claude Code wire names before request membership checks (`read` → `Read`) ([#359](https://github.com/valkyriweb/pi-mono/pull/359)).

- Fix: filter transcript `tool_reference` blocks (assistant messages and tool-result content) against the current request's serialized `tools[]` wire names during Anthropic serialization. Anthropic 400s the whole request when a reference names a tool absent from `tools[]` ("Tool reference 'X' not found in available tools") — hit by forked child sessions with filtered tools, profile changes, and resumed sessions. References to present tools serialize byte-identically (prompt-cache safe); a mixed tool result whose only surviving content was ghost references gets a placeholder text block ([my-pi#1210](https://github.com/valkyriweb/my-pi/issues/1210), [#354](https://github.com/valkyriweb/pi-mono/pull/354)).

- Fix: classify transient concurrency throttles and truncated Codex stream frames as retryable. `RETRYABLE_PROVIDER_ERROR_PATTERN` now matches `too many concurrent`, `throttl`, and `concurrency.?limit`, so gateway throttles (`Too many concurrent requests` / `source: concurrency_limit`) and `Connection error: Invalid Codex SSE/WebSocket JSON …` truncations back off and retry instead of aborting the turn/goal as a non-retryable provider error. Account/quota/billing limits remain non-retryable.

- Fix Codex Responses gateways with opaque bearer credentials and JSON-only transports: `OpenAICodexResponsesCompat` can omit ChatGPT JWT account-ID derivation and inherited headers, force SSE when WebSocket is unsupported, and disable zstd request compression. Direct ChatGPT defaults remain unchanged.

- Fix automatic retries so transient failures remain retryable only before the assistant emits text, thinking, or tool output, preventing duplicate work after a partial response.
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
