---
"@valkyriweb/pi-coding-agent": patch
---

Keep each forked assistant tool-call turn adjacent to its complete tool-result batch. Matching late results are moved beside their call, missing results use the stable fork placeholder, and orphan or duplicate results are dropped before provider serialization.
