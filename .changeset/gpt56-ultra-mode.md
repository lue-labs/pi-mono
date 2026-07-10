---
"@valkyriweb/pi-ai": minor
"@valkyriweb/pi-agent-core": minor
"@valkyriweb/pi-coding-agent": minor
---

Add model-gated GPT-5.6 Ultra support.

- Sol and Terra advertise `ultra` as maximum reasoning with client-side automatic task delegation; other models do not expose it unless their `thinkingLevelMap` opts in.
- OpenAI Responses, ChatGPT Codex Responses, and OpenAI-compatible Completions transports always serialize Ultra as native `max` effort, never the client-only `"ultra"` label.
- Thread Ultra through CLI, settings, selectors, theme, agent configuration, and extension-facing thinking-level types.
