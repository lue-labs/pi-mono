---
"@valkyriweb/pi-ai": patch
---

Stop `cacheRetention: "none"` leaking Codex session affinity to the provider.

The upstream-0.84 review-gate fix correctly established that local bookkeeping — SSE-fallback state and failure records — must stay keyed to the real Pi session id, or a session whose WebSocket transport is broken redials it every turn. It applied that as a blanket rename across the Codex path, which also caught three things the provider can observe: the `thread-id` / `x-client-request-id` headers, WebSocket pooling, and the pooled-connection debug stats.

The effect was that `cacheRetention: "none"` suppressed `prompt_cache_key` and the `session-id` header while still shipping a stable per-session correlator in `x-client-request-id`, and still reusing a pooled socket that carries connection-scoped `previous_response_id` context. A retention-free turn was therefore neither unlinkable nor free of provider-retained state.

The two ids are now named and used by who can see them: `localSessionId` for local-only bookkeeping, and the retention-gated `cacheSessionId` for everything provider-visible. Both halves are locked by tests — the two that this regressed, plus a new one covering the ungated fallback bookkeeping, which had no coverage and is why the regression landed silently.
