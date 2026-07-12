---
"@valkyriweb/pi-coding-agent": patch
---

Remove GPT-5.4 Mini and GPT-5.4/5.5 variants, including Pro, from automatic child-agent tier candidates and provider defaults. OpenAI and Azure tiers use GPT-5.6 Luna, Terra, and Sol; ClawRouter preserves family-aware GPT-5.6/Claude routing; direct Codex and Copilot use current catalog-backed 5.3 fallbacks until their catalogs expose GPT-5.6.
