---
"@valkyriweb/pi-coding-agent": patch
---

Reap orphaned background Bash jobs owned by a disposed child-agent session (Claude Code `killShellTasksForAgent` parity). Each `BashBgJob` is now tagged with the `ownerSessionId` that spawned it; when a non-root (`source: "child-agent"`) session disposes, only that session's still-running jobs are tree-killed via the existing `killProcessTree`, leaving parent/root jobs untouched. Root/interactive disposal keeps `killAll()` as the global backstop. Fixes background jobs (e.g. `rusty-review`) that finished but sat "working" for hours because their owning sub-agent session parked without ever reaping them, and removes the latent footgun where a child disposal could `killAll` the parent's jobs. No system-prompt or tool-schema bytes change (cache-stable).
