---
"@valkyriweb/pi-coding-agent": patch
---

Bash: drop the hard runtime native-tool guard (`checkNativeToolGuard`) that rejected standalone `grep`/`egrep`/`fgrep`/`rg`/`find`, and steer toward Grep/Glob via prompt only — matching Claude Code.

Reverse-engineering the Claude Code CLI binary (2.1.204–2.1.212) confirmed CC has **no** runtime block on grep/find in Bash: it steers repo search toward Grep/Glob purely through the Bash tool description ("Avoid using this tool to run `find`, `grep`, … unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task") and gates bash through a user-configurable permission engine, never a built-in rejection. The fork's guard (added for "CC Grep steering parity") was a divergence that over-blocked composite verification harnesses (echo-labeled `grep -c` probe batches), forcing clunky python fallbacks — 762 sessions / 2,734 blocks since it landed 2026-07-04.

The Bash tool description and the shared native-file-tools prompt guideline now carry CC's soft steering with the "unless a dedicated tool cannot accomplish the task" escape hatch instead of claiming a hard block. `semanticExitForBashCommand` (grep/find exit-1 → treated-as-success) and the redundant-cd guard are unchanged.
