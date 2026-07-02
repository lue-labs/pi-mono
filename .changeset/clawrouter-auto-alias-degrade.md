---
"@valkyriweb/pi-coding-agent": patch
---

Register `clawrouter` as an auto-alias provider and degrade unresolved auto aliases gracefully instead of throwing (shipped in #177, changeset backfilled).

- `core/model-resolver.ts` adds `clawrouter` to `AUTO_MODEL_ALIAS_PROVIDERS`; the model selector gains an "Auto (semantic ClawRouter)" item.
- When a pending auto alias yields no routing decision from the `model:resolve` filter, `agent-session.ts` (`_resolvePendingAutoModelForPrompt`) and the `sdk.ts` startup path now clear the pending request, keep the current model + cache affinity untouched, and surface a `model-routing-warning` custom message — instead of hard-throwing `Auto model <x> did not resolve to a semantic routing decision` and killing the turn (regression observed 2026-07-02 in a clawrouter-cwd session, worst after `/reload`).
- Cache-safe: the degrade path never mutates `agent.state.model` or `cacheAffinityKey`; the warning is an appended message, not part of the cached prefix.
