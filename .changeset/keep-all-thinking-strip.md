---
"@lue-labs/pi-ai": patch
---

Gate the Anthropic stale-thinking strip on models that keep prior-turn thinking (Opus 4.5+, Sonnet 4.6+, Fable, Mythos). Stripping there rewrote the whole transcript at every real user turn; last-turn-only models keep the strip.
