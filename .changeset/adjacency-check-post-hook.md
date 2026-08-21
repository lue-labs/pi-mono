---
"@valkyriweb/pi-ai": patch
"@valkyriweb/pi-coding-agent": patch
---

Inspect the payload the provider actually receives, and persist bash records the busy-state guard defers.

The `tool_use` adjacency diagnostic ran inside `buildParams`, before `onPayload`. An extension that replaces `params.messages` could therefore introduce the exact fault under investigation while the diagnostic recorded nothing. It now runs after the hook resolves, on both the initial and the continuation send. The checker also no longer treats a `tool_result` as settling its call unless it leads the immediately following *user* message — results behind a text block, or carried by a non-user message, are the shapes Anthropic rejects, and scanning the whole message marked them clean.

Widening the bash deferral guard left two paths with no flush. Manual `compact()` is user-invoked, so nothing encloses it the way `_runAgentPrompt` encloses auto-compaction, and a bash recorded during summarization stayed unpersisted until some later prompt. `navigateTree` sets `_branchSummaryAbortController`, so `isCompacting` deferred any bash run during branch summarization and the next prompt flushed it onto the branch being navigated to. Both now flush at the right seam: after the compacted context is rebuilt, and before the leaf switch.
