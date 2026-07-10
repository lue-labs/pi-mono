---
"@valkyriweb/pi-coding-agent": patch
---

Prevent the deferred stale-session-marker startup sweep from freezing interactive input on large session trees by traversing the tree asynchronously while preserving live, dead, and stale marker semantics.
