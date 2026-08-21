---
"@valkyriweb/pi-ai": patch
---

Record any `tool_use` an outgoing Anthropic request does not settle in the very next message. Anthropic rejects such a request with a 400, but the session logs of affected sessions all hold the missing result, so the fault lives between the durable record and the wire. `convertMessages` now inspects the final `MessageParam[]` and appends the offending id, tool name, message index, the following message's shape, and where the result landed later in the request (if anywhere) to `~/.pi/agent/logs/tool-use-adjacency.log`. Diagnostic only: nothing is thrown or repaired, logging failures are swallowed, and a clean request writes nothing.
