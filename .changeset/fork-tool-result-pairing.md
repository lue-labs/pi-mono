---
"@lue-labs/pi-coding-agent": patch
---

Keep each forked assistant tool-call turn adjacent to its complete tool-result batch. Matching late results are moved beside their call, missing results use the stable fork placeholder, and surplus results — orphans or duplicates of an already-paired call — are never re-emitted, so every tool call reaches provider serialization with exactly one result.
