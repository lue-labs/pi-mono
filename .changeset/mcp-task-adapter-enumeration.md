---
"@valkyriweb/pi-coding-agent": patch
---

Tasks: enumerate extension-registered task adapters in `listTasks()`. Adds an optional `Task.list` verb and a `local_mcp` `TaskType`, and makes `listTasks()` include tasks from any registered adapter that provides `list` (beyond the built-in `local_agent`/`local_bash`). This lets an extension — e.g. pi-mcp-adapter's MCP auto-background (my-pi #1091) — register a Task adapter whose backgrounded tasks surface in `TaskBackgroundList` and resolve via `TaskStop`, without core knowing the concrete task type. Additive and vendor-neutral; existing enumeration is unchanged.
