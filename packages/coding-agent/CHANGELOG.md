# @valkyriweb/pi-coding-agent

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

## Unreleased

- Agents runs selector: pressing Enter on a running agent row now enters the zoomed session view for that row (row-scoped zoom entry); non-running rows keep the existing detail view. Regression in `test/interactive-mode-agents-command.test.ts`.

- System prompt: tool-provided `promptGuidelines` are no longer silently dropped when a custom system prompt is set — they render as a `Tool guidelines:` section before the dynamic boundary (cached prefix; byte-identical output when no guidelines are provided). Regressions in `test/system-prompt.test.ts`.

- Bash: enforce the long-documented native-tool guard at runtime — commands whose first pipeline stage is standalone `grep`/`egrep`/`fgrep`/`rg`/`find`/`ls` (including behind env assignments, wrappers like `sudo`/`env`/`nice`, subshell parens, and absolute paths) are rejected with steering to the native Grep/Glob/Ls tools; pipeline filters on command output (`kubectl ... | grep Ready`) remain allowed and heredoc bodies are ignored. Grep tool description gains Claude-Code-parity ripgrep steering (ALWAYS Grep / NEVER bash grep, brace escaping, outputMode, multiline), the explore agent prompt no longer suggests bash `grep` pipelines for repo files, and Bash promptGuidelines wording now matches the enforced behavior. Regressions in `test/bash-native-tool-guard.test.ts`.

- Suppress only the known benign pi-goal stale queued-continuation abort (`pi-goal:stale-queued-continuation-cancelled`) in interactive rendering while preserving visible text for normal aborts and errors.

- Footer: while an auto-model alias is pending, show only the alias (e.g. `openai-codex/auto`) instead of `alias → seed-model`. The concrete model behind a pending alias is just the unrouted compat seed, so the old arrow display read as if routing had already resolved (to the seed, typically `gpt-5.3-codex-spark`); the alias clears on resolve, so the routed model appears as soon as it exists. Regression in `test/footer-width.test.ts`.

- Route settings-persisted auto model defaults (`defaultProvider` + `defaultModel: "auto"`) through the same deferred `model:resolve` pending-auto request as `--model auto`, so a persisted `openai-codex/auto` default semantically routes at the first prompt boundary instead of silently landing on `findInitialModel`'s concrete fallback model. Also fixed for configs with `enabledModels` (scoped models): `buildSessionOptions`' scoped-model fallback previously discarded the auto intent before the SDK seam could see it, and auto placeholder seeding now prefers in-scope models over the full registry. Concrete defaults, explicit `--model`, and session restore are unaffected. Regressions in `test/sdk-settings-default-auto.test.ts` and `test/main-session-options-settings-auto.test.ts`.

- Keep the `/resume` / `--resume` session picker default on the Named filter, but treat sessions with a non-placeholder first user message as displayable named results so the default hides only empty stubs instead of normal unnamed sessions.

- Fix a fatal race in `AgentSession.prompt()`: the busy gate now checks `isCompacting`/`agent.isProcessing` in addition to `isStreaming` (mirroring `sendCustomMessage`), so prompts and extension `sendUserMessage` calls sent during auto-compaction, the post-compaction resume, or the agent_end listener phase are queued (default steer) instead of racing `agent.prompt()` and rejecting with "Agent is already processing a prompt" — an un-awaited rejection there crashed the whole interactive process mid-"Auto-compacting…". A TOCTOU fallback at the `_runAgentPrompt` send chokepoint routes raced prompt messages into the steer/follow-up queue, and manual `compact()` now drains messages queued while it held the busy gate (it aborts any active run, so nothing else would deliver them). Regressions in `test/agent-session-concurrent.test.ts`.
- Fix `fast`/`medium` child-agent model aliases for `clawrouter`, warn when `fast` falls back to a parent/frontier model, and clamp unsupported `thinking: "off"` to the lowest supported model thinking level.

- Add an experimental Pierre-backed Edit TUI diff renderer behind `PI_TUI_DIFF_RENDERER=pierre` / `PI_DIFF_RENDERER=pierre`, covering both structured hunk rendering and the legacy no-hunks fallback while keeping the existing fast terminal renderer as the default.
- Skip npm audit during managed package installs by passing `--no-audit` alongside `--legacy-peer-deps`, avoiding Arborist audit/rollback failures during extension refreshes while leaving bun/pnpm install behavior unchanged.
- Add `ctx.requestStopAfterTurn(reason?)` for extensions that need to park the current agent run at the next turn boundary without aborting and without changing mixed tool-batch `terminate` semantics. Covers mixed terminating/non-terminating tool batches with `test/suite/agent-session-extension-stop-after-turn.test.ts`.
- Add `ForkAgentOptions.detachFromParent` (additive, default-off): a fork can opt out of the parent session's abort signal so a `AgentSession.dispose()`/`agent.abort()` on session replace/reload no longer cancels a best-effort background fork; the fork then runs on the caller's own signal, bounded by the caller's drain. Consumed by pi-memory turn-end extraction (drained on `session_shutdown`). Lifecycle flag only, not part of the cached prefix. Locks the drain-before-abort invariant with a regression test in `test/agent-session-runtime-events.test.ts`. Refs #151/#152.
- Add cache-safe semantic auto model routing boundaries: `model:resolve` hooks can resolve `auto` / provider-scoped `*/auto` aliases at session, child-agent, or first-prompt interactive boundaries; unresolved aliases degrade gracefully (visible routing warning, current model and cache affinity untouched) or remain pending instead of silently using a seed model, and parallel Agent child rows expose routed child task details.
- Register `clawrouter` as an auto-alias provider (`clawrouter/auto` in the model selector and `AUTO_MODEL_ALIAS_PROVIDERS`), and degrade unresolved auto aliases at the prompt/startup boundary with a `model-routing-warning` custom message instead of throwing `did not resolve to a semantic routing decision`.
- Add a first-class Glob `ignore:false` retry mode for ignored known paths while keeping ignore-aware defaults and VCS metadata exclusions.
- Show running background bash jobs in the existing background status footer/pane by backing it with the unified task registry instead of agent-only status.
- Flag likely prompt-cache TTL expiry as cache-health telemetry in session logs and the interactive footer so cold turns after warm same-model turns are easier to diagnose.
- Bound Grep's formatted model-facing output before the final join so broad or `full:true` searches cannot exhaust memory before truncation; suppress noisy skill collision warnings for byte-identical duplicate installs.
- Cap aggregate model-facing tool-result text at 100k chars after extension `tool_result` hooks, preserve full text artifacts under `.pi/tool-results`, and bound edit-tool original-content details to `originalContentPreview`.
- Fix cache-safe split-turn compaction summaries so the `Turn Context (split turn)` section uses a delta-only format instead of repeating the main Goal/Progress/Next Steps checkpoint headings.
- macOS: route search backends (`rg`/`fd`/`ugrep`/`bfs`) exclusively through Pi's managed `~/.pi/bin` instead of system-PATH (Homebrew) binaries. Homebrew's adhoc-signed binaries trigger a Gatekeeper assessment (`amfid`/`syspolicyd`/`trustd`) on every spawn; under Pi's hot Grep/Find loops this pinned the CPU. Managed copies carry no quarantine xattr and are assessment-inert; `downloadTool` strips the xattr as belt-and-suspenders. Offline mode keeps the PATH fallback (for both required and optional backends) so a machine with no managed copy can still search. darwin-gated; no effect on Linux/Termux/Windows.
- Reap stale `<session>.live` liveness markers proactively: add `sweepStaleMarkers()` and a deferred, unref'd sweep on interactive startup so markers left by crashed/SIGKILL'd sessions can no longer accumulate without bound (354 dead markers observed on one machine). Only dead/stale markers are removed; live sessions are untouched.
- Add opt-in resident session pruning after successful compaction and during compacted-session hydration (`compaction.residentPrune` / `PI_RESIDENT_SESSION_PRUNE=1`), planning current-version loads from raw-line metadata and applying stubs before summarized candidate payload JSON is parsed, plus a Claude/Pi RSS audit harness.
- Report loaded context usage separately from unloaded provider-deferred tool schemas in context-usage diagnostics and the TUI footer.
- Expose `ctx.reload()` on extension event contexts so model-switch handlers can rebuild provider-specific runtime resources without queuing slash-command text.
- Agents status pane now shows a live elapsed-seconds counter for in-progress runs (e.g. `running 12s`): `formatDuration` renders live elapsed for `running` runs, and `AgentsPane` repaints on a 1s ticker (duplicate-guarded, `unref`'d, cleared on dispose). Previously running rows showed a static `running` placeholder.
- Remove the dormant, never-activated background-tasks pane (`background-tasks-ui.ts`). It was added but never imported into the runtime and is superseded by the agents status pane; the public `Task*` tool factories in `core/tools/background-tasks.ts` are unchanged.

This file is fork-owned (`.gitattributes` `merge=ours`) so upstream syncs no
longer append their full changelog here.
