---
"@lue-labs/pi-coding-agent": patch
---

Expose `registerTaskAdapter`/`findTaskAdapter` on the injected `ExtensionAPI` (thin passthroughs to the shared task registry, mirroring `registerLiveSession`) and make `listTasks()` enumerate registered adapters generically via an optional `Task.list?()`. Lets an extension own a long-running thing — e.g. a backgrounded MCP tool call (my-pi #1091) — and have it stoppable through `TaskStop` and listable in `TaskBackgroundList` without importing the core registry singleton directly (which would create a second adapter table under a duplicated module instance). Additive platform seam; no system-prompt or `tools[]` bytes change (cache-stable). Adds `mcp_background` to `TaskType`.
