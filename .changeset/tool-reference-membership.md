---
"@valkyriweb/pi-ai": patch
"@valkyriweb/pi-coding-agent": patch
---

Filter transcript `tool_reference` blocks against the current request's tools[] during Anthropic serialization, and surface error-stopped child agent runs as failed.

Anthropic requires every `tool_reference.tool_name` to exactly match a tool in `tools[]` and 400s the whole request otherwise ("Tool reference 'X' not found in available tools"). References enter transcripts when a parent activates a deferred tool, then leak into requests built with a smaller tool set — forked child agents with filtered tools, profile changes, resumed sessions — killing the run on the first turn. Both leak points (assistant-message blocks and tool-result content) now drop references to tools absent from the request; references to present tools are unchanged, so healthy requests stay byte-identical (prompt-cache safe).

The companion executor fix stops masking such deaths: `session.prompt()` resolves even when the run terminates on a provider error, so child runs previously reported `status: "completed"` with empty output. A trailing error-stopped assistant message now fails the run with the provider's error message. Fixes valkyriweb/my-pi#1210.
