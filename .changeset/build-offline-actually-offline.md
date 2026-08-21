---
"@valkyriweb/pi-coding-agent": patch
---

Make the repository's `build:offline` actually offline.

Its last leg was `cd ../coding-agent && npm run build`, and coding-agent's `build` re-enters `npm --prefix ../ai run build`, whose first step is `generate-models` — a network fetch of models.dev, NVIDIA NIM and OpenRouter. The offline target therefore rebuilt the model data online, undoing the `ai` offline build it had already done correctly earlier in the same chain, and additionally required `bun` for a `--compile` step. It now uses coding-agent's `build:ts`, matching what the non-offline root `build` already did.
