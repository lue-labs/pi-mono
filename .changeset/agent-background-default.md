---
"@valkyriweb/pi-coding-agent": patch
---

The shared `agent`, `Agent`, and `Task` calls now run in the background when both background aliases are omitted. Pass `background:false` or `run_in_background:false` to keep a call synchronous.
