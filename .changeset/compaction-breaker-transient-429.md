---
"@valkyriweb/pi-coding-agent": patch
---

Auto-compaction failure circuit breaker no longer counts transient provider errors (429 rate-limit/usage-limit windows, 529/503 overload shedding, gateway errors) toward its 3-strike trip, and such errors no longer reset a real-failure streak. Previously a ChatGPT-Codex usage-limit window (`usage_limit_reached`, which carries `resets_in_seconds`) tripped the breaker and permanently disabled auto-compaction for a session that resumes working once the limit resets — leaving it to grow unchecked until it died at the context-window limit.
