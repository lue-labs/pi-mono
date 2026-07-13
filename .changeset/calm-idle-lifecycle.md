---
"@valkyriweb/pi-coding-agent": patch
---

Keep extension `ctx.isIdle()` false throughout prompt and custom-message preflight, resumed interactive tools, streaming, compaction, and agent processing so idle-only actions never queue work while Pi is busy.
