---
"@valkyriweb/pi-coding-agent": patch
---

fix(agents): fork mode inherits the parent model + thinking, bypassing a `settings.subagents` provider pin

`context:"fork"` forks (pi-memory extraction, pi-recap, fusion, suggested-tasks) deliberately omit `model` so the child inherits the parent's model/thinking for prompt-cache identity — the inherited transcript only reads from the parent's warm cache at 0.1× when the child's request is cache-key-identical. But `runChild` resolved model/thinking through `resolveAgentDefaults` (which folds in `settings.subagents`) *before* the fork-mode branch, so a configured `subagents.providers.<provider>.model` pin (the cheap model used for `explore`/`general` fan-out) silently downgraded every fork off the parent model, cold-writing the whole inherited prefix on each run.

Fork mode now drops the `settings.subagents` defaults so model/thinking fall through to the parent; agent-frontmatter (`model`/`thinking`) and explicit task-level overrides still win, and non-fork delegations (default/slim/none context — `explore`/`general`/`plan`/`reviewer`) keep the cheap pin.
