---
"@valkyriweb/pi-coding-agent": patch
---

Permanently retire out-of-budget image payloads from stored session messages (`retireOutOfBudgetContextImages`). The transient provider view already replaces images beyond the newest-first 3 MB budget with placeholder text on every request, so those base64 payloads could never reach the model again — yet they stayed resident in `agent.state.messages`/session entries for the process lifetime, and because they cost zero context tokens they never triggered compaction, accumulating without bound in long sessions (my-pi#1147, multi-GB JS heaps). Retirement runs at `agent_end` and on session restore, mutates content blocks in place with the exact placeholder the transient view emits (provider request bytes unchanged — cache-neutral; verified by a provider-view equivalence test), and never rewrites the durable JSONL (messages are persisted at `message_end` before retirement).
