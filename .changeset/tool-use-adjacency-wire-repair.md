---
"@valkyriweb/pi-ai": patch
---

Repair `tool_use` → `tool_result` adjacency on the outgoing Anthropic request after `onPayload`.

Every captured incident of `messages.N: tool_use ids were found without tool_result blocks immediately after` had a valid durable session log; the pair is split after serialization, by a payload hook that re-inserts messages at frozen absolute positions once the array it measured has shifted (the mid-conversation tool-change sentinel lane killed lue-kube goal session 01a0202f this way: assistant@11, sentinel@12, displaced result@13). No pre-serialization seam can see that fault, so `repairToolUseAdjacency` runs on the final `MessageParam[]` — after the adjacency report, on both the initial and pause_turn continuation sends. Displaced results are pulled back to lead the message after their assistant turn; displaced non-result content is re-emitted immediately after the batch in original order; duplicate results for a settled id and results whose `tool_use` is absent are dropped; an unsettled `tool_use` is left alone. A well-formed request returns the identical array, so valid payloads serialize byte-identically and the prompt-cache prefix is untouched.
