---
"@valkyriweb/pi-coding-agent": patch
---

Force-exit one-shot `--print`/`--mode json` runs after completion so a leaked event-loop handle (observability sockets, sidecar children, metric timers) can't keep the process alive until the harness timeout, matching the existing package-command one-shot guarantee (win32 drains naturally to avoid nodejs/node#56645). Fixes valkyriweb/my-pi#1080.
