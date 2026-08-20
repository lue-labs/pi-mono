---
"@valkyriweb/pi-ai": patch
---

Default Codex Responses zstd request compression by base URL. The SSE path compresses only when the model's base URL points at the official ChatGPT Codex backend (or is unset); every other base URL sends plain JSON, so Codex-wire gateways that reject `Content-Encoding: zstd` work without per-model configuration. An explicit `compat.supportsZstdRequestCompression` still overrides in both directions.
