---
"@valkyriweb/pi-ai": patch
"@valkyriweb/pi-coding-agent": patch
---

Repair `tool_use` -> `tool_result` adjacency at request assembly so an injected message can never brick a session.

A custom message delivered while a tool call was in flight (captain wake, relay push, monitor notification) was persisted between the assistant `toolCall` entry and its `toolResult`. Anthropic rejects that history with `unexpected 'tool_use_id' found in 'tool_result' blocks`, and because the order is committed to the session file the same payload replays on every later request — the session dies permanently and survives both `/reload` and `continue`. Two consecutive captain sessions were lost this way (pi-mono#479, the orphan-`tool_result` mirror of #406 and the native-Anthropic case of #380).

`transformMessages` now runs `restoreToolResultAdjacency` before synthesising results: results for an open batch are pulled back next to the assistant turn that issued them, the displaced messages are re-emitted immediately after (nothing is dropped or reordered relative to each other), and the two shapes no provider can accept — a `tool_result` whose `tool_use` is absent from the history, and a duplicate result for an already-settled call — are removed. This sits at the seam every producer shares (normal turns, aborted turns, injected steers, monitor wakes, compaction, resume, fork), so an already-poisoned transcript is recovered on the next request instead of replaying the 400. A well-formed history returns the identical array, so valid requests serialise byte-identically and the prompt cache is untouched.

`sendCustomMessage` gains the matching delivery-side guard: an injection is queued whenever the recorded history still holds an unsettled tool call, not only when the run flags say the agent is busy. `triggerTurn` callers keep the prompt path (queueing them with no run in flight would strand the message) and rely on the request-assembly repair for ordering.
