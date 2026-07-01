# @valkyriweb/pi-coding-agent

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

## Unreleased

- Add an experimental Pierre-backed Edit TUI diff renderer behind `PI_TUI_DIFF_RENDERER=pierre` / `PI_DIFF_RENDERER=pierre`, covering both structured hunk rendering and the legacy no-hunks fallback while keeping the existing fast terminal renderer as the default.
- Skip npm audit during managed package installs by passing `--no-audit` alongside `--legacy-peer-deps`, avoiding Arborist audit/rollback failures during extension refreshes while leaving bun/pnpm install behavior unchanged.
- Add `ctx.requestStopAfterTurn(reason?)` for extensions that need to park the current agent run at the next turn boundary without aborting and without changing mixed tool-batch `terminate` semantics. Covers mixed terminating/non-terminating tool batches with `test/suite/agent-session-extension-stop-after-turn.test.ts`.
- Add `ForkAgentOptions.detachFromParent` (additive, default-off): a fork can opt out of the parent session's abort signal so a `AgentSession.dispose()`/`agent.abort()` on session replace/reload no longer cancels a best-effort background fork; the fork then runs on the caller's own signal, bounded by the caller's drain. Consumed by pi-memory turn-end extraction (drained on `session_shutdown`). Lifecycle flag only, not part of the cached prefix. Locks the drain-before-abort invariant with a regression test in `test/agent-session-runtime-events.test.ts`. Refs #151/#152.
- Add cache-safe semantic auto model routing boundaries: `model:resolve` hooks can resolve `auto` / provider-scoped `*/auto` aliases at session, child-agent, or first-prompt interactive boundaries; unresolved aliases now fail clearly or remain pending instead of silently using a seed model, and parallel Agent child rows expose routed child task details.
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
