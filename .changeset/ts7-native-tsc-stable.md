---
"@valkyriweb/pi-tui": patch
"@valkyriweb/pi-ai": patch
"@valkyriweb/pi-agent-core": patch
"@valkyriweb/pi-coding-agent": patch
"@valkyriweb/pi-orchestrator": patch
---

Migrate the build toolchain to stable TypeScript 7 (`typescript@7.0.2`, native `tsc`). Drops the `typescript-native-preview`/`tsgo` binary in favour of the shipped native `tsc`, so typechecks now run on the stable compiler. Because stable `tsc` correctly enforces it (the preview was lenient), the compile target moves `ES2022 → ES2024` — matching the Node 24.14+ engine floor and the code that already relies on the ES2024 RegExp `v`/`unicodeSets` flag (`\p{RGI_Emoji}` in `packages/tui`).

The relative-import lint (`scripts/check-ts-relative-imports.mjs`) is reimplemented on `oxc-parser` (the Rust TS parser used by oxlint) since stable TS 7 ships no programmatic compiler API until 7.1. This avoids pulling a TS6 API alias whose transitive `tsc` bin would shadow native `tsc@7` under npm. No runtime/library behaviour changes; emit differences are limited to reduced down-levelling for the Node 24 runtime.
