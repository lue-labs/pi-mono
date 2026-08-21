---
"@lue-labs/pi-coding-agent": patch
---

Bash policy: ban process substitution `<(...)` / `>(...)` in `detectUnsafeConstructs`.

The read-only bash policy (`EXPLORE_BASH_POLICY`, applied to the `explore` child agent) rejected command substitution `$(...)`, backticks, and here-docs, but not process substitution. `cat <(rm -rf x)` / `tee >(rm -rf x)` execute an arbitrary inner command while presenting as a benign `cat`/`tee`, bypassing the deny-list scanner (no `$(`, no backtick, and `<(` carries no `>` for the write guard to catch). Adds a `/[<>]\(/` check to the same function, with a regression test (`test/bash-policy.test.ts`) covering `<(...)`, `>(...)`, the single-quote false-positive guard, and benign read-only commands.

Found via Claude Code 2.1.207–2.1.212 reverse-engineering triage (catastrophic-shell-construct handling); Pi's blanket ban is already stricter than CC's analyze-and-ask, this just closes the missing construct.
