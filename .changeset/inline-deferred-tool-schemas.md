---
"@valkyriweb/pi-ai": patch
---

Anthropic: opt-in `compat.inlineDeferredTools` — message-anchored schema delivery for gateways without the native deferral wire. Mid-session-activated tools stay out of wire `tools[]` permanently (schema delivered once as a `<tool-loaded>` text block after the activating tool_result), keeping the prompt-cache prefix byte-stable. Fixes full-prefix cache busts (~109k tokens re-billed) on deferred-tool activation over the clawrouter/claude-bridge CC lanes.
