---
"@valkyriweb/pi-coding-agent": patch
---

Defer a recorded bash execution whenever the agent is busy, not only while it streams. `recordBashResult` gated on `isStreaming` alone, which is false during compaction (its LLM calls run outside `agent.runWithLifecycle()`), during the `prompt()` setup window, and during the `agent_end` listener phase. A `!` command in one of those windows pushed a visible `bashExecution` message between an assistant `tool_use` and its `tool_result` batch, and Anthropic then rejected every later request in the session with `tool_use ids were found without tool_result blocks immediately after`. The guard now matches `sendCustomMessage`'s (`isStreaming || isCompacting || agent.isProcessing`); deferred messages flush in the enclosing run's `finally` or before the next prompt.
