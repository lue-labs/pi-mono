---
"@lue-labs/pi-coding-agent": patch
---

Stop re-serializing the split-turn prefix into the cache-safe turn-prefix summary prompt; those messages are already in the cached context, so the duplicate was a never-read cache write on every split-turn compaction.
