---
"@valkyriweb/pi-coding-agent": patch
---

Cache health: classify Anthropic thinking-block strips as `thinking_strip_likely` instead of `cache_write_unhealthy`. When a real user message follows an agentic loop, Anthropic strips the loop's thinking blocks from history, collapsing the warm prefix to the tools+system anchor — an expected one-time rewrite, not prefix drift. Detected via a new `followsUserTurn` signal (warm→anchor collapse, gap under the TTL window, same model); footer renders a dim `⟳think` marker analogous to `⟳compact`.
