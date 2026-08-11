---
"@valkyriweb/pi-coding-agent": patch
---

Settle tool calls left without an outcome when a session is resumed. A turn that died between the assistant message and its tool results left an unpaired `tool_use` in the history, which Anthropic rejects with a 400, wedging every later request in that session. Resuming now appends a synthetic result to each open call before the first turn runs. The result states the outcome is unknown rather than claiming the tool failed or succeeded, and a session whose calls are all settled is left untouched.
