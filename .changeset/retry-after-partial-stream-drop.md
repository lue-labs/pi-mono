---
"@lue-labs/pi-ai": patch
"@lue-labs/pi-coding-agent": patch
---

Retry transient provider errors after partial streamed output again. A stream that drops mid-turn (`Anthropic stream ended before message_stop`, `terminated`, socket closed) is replayed within the configured retry budget instead of surfacing to the user; the dropped partial turn never ran its tool calls and is removed from context before the retry.
