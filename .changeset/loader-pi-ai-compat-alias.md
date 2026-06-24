---
"@valkyriweb/pi-coding-agent": patch
---

fix(extensions/loader): expose the fork-scoped `@valkyriweb/pi-ai/compat` subpath to bundled extensions

The 0.80 model-runtime migration split the deprecated global dispatch surface into a `/compat` subpath. The extension module resolver registered `/compat` for the upstream scopes (`@earendil-works/pi-ai/compat`, `@mariozechner/pi-ai/compat`) but omitted it for the fork's own `@valkyriweb` scope, so fork extensions importing `@valkyriweb/pi-ai/compat` failed to load in the compiled binary with `Cannot find module '@valkyriweb/pi-ai/compat'`. Register the missing alias in both `VIRTUAL_MODULES` (Bun binary) and `getAliases()` (Node/dev), reusing the already-bundled `_bundledPiAiCompat` / `piAiCompatEntry`.
