---
"@valkyriweb/pi-ai": patch
---

Classify transient concurrency throttles and truncated Codex stream frames as retryable provider errors.

`isRetryableAssistantError` (via `RETRYABLE_PROVIDER_ERROR_PATTERN`) previously matched none of the tokens a gateway concurrency throttle emits (`Too many concurrent requests`, `throttled`, `source: concurrency_limit`), nor the `Connection error: Invalid Codex SSE/WebSocket JSON …` text the Codex adapter now surfaces for a stream truncated mid-frame. Both classified as non-retryable, so the harness aborted the turn (and any active goal) with "non-retryable provider error" instead of backing off and retrying a plainly transient failure.

Added `too many concurrent`, `throttl`, and `concurrency.?limit` to the retryable pattern. These are transient throttles (retrying after backoff clears them), distinct from the account/quota/billing limits kept non-retryable by `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`.
