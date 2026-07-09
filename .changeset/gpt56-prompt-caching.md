---
"@valkyriweb/pi-ai": minor
"@valkyriweb/pi-agent-core": minor
"@valkyriweb/pi-coding-agent": minor
---

GPT-5.6 prompt caching + `max` thinking level.

- New OpenAI Responses prompt-cache API support (`OpenAIResponsesCompat.promptCacheApi: "breakpoints"`, default `"legacy"`): omits the deprecated `prompt_cache_retention` param and emits explicit `prompt_cache_breakpoint` markers on the stable system-prompt prefix (split at `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) and on the previous user message, riding the implicit latest-message breakpoint. GPT-5.6 (Sol/Terra/Luna) models opt in via the generated catalog.
- New `max` thinking level (GPT-5.6+ reasoning effort above `xhigh`), threaded through thinking-level maps, clamping, CLI/settings/selector/agent-tool surfaces, and provider adapters (clamped to `high`/`xhigh` where unsupported).
- OpenAI SDK bumped to 6.46.0; model catalogs regenerated (GPT-5.6 family pricing incl. 1.25× cache writes, models.dev drops legacy Claude 3.x/4.0 entries).
