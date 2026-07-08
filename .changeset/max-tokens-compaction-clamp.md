---
"@valkyriweb/pi-ai": patch
---

Fix zero-output truncation on the first turn after compaction (notably `claude-fable-5` with adaptive thinking). After compaction, `estimateContextTokens` anchored on the retained assistant message's stale pre-compaction `usage.totalTokens` (~194k while the real context was ~55k), so `clampMaxTokensToContext` collapsed `max_tokens` to ~1131; the `forceAdaptiveThinking` branch then let unconstrained adaptive thinking consume the whole budget, ending the turn with `stopReason:"length"` and no visible output.

Two changes: (1) `estimateContextTokens` now discards a usage anchor that exceeds a fresh recount of the current messages + system/tools prefix by more than 2× (compaction-scale mismatch) and falls back to the recount; (2) the Anthropic `forceAdaptiveThinking` path disables thinking when the clamped `max_tokens` is below `MIN_THINKING_BUDGET * 2`, mirroring the existing budget-branch floor guard so the budget goes to visible output instead of pure thinking. Per-request `max_tokens`/`thinking` only — no system-prompt or tools byte change, cache-safe.
