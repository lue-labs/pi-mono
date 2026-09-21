---
"@lue-labs/pi-coding-agent": patch
---

Let cache-safe compaction read the prompt cache instead of cold-writing it. `completeSummarization` forced `cacheRetention: "none"` on every summary request, which is right for a standalone `<conversation>` text blob but wrong for the cache-safe path, where the request deliberately replays the live conversation prefix the main loop just cached. The override also discarded sticky routing, because the Anthropic adapter drops `cacheSessionId` whenever retention is `"none"`. Caller-supplied retention is now honored (standalone callers such as branch summarization keep the `"none"` default), and default compaction now passes the live session id through to `compact()`.
