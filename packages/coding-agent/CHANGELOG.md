# @valkyriweb/pi-coding-agent

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

## Unreleased

- macOS: route search backends (`rg`/`fd`/`ugrep`/`bfs`) exclusively through Pi's managed `~/.pi/bin` instead of system-PATH (Homebrew) binaries. Homebrew's adhoc-signed binaries trigger a Gatekeeper assessment (`amfid`/`syspolicyd`/`trustd`) on every spawn; under Pi's hot Grep/Find loops this pinned the CPU. Managed copies carry no quarantine xattr and are assessment-inert; `downloadTool` strips the xattr as belt-and-suspenders. Offline mode keeps the PATH fallback (for both required and optional backends) so a machine with no managed copy can still search. darwin-gated; no effect on Linux/Termux/Windows.
- Reap stale `<session>.live` liveness markers proactively: add `sweepStaleMarkers()` and a deferred, unref'd sweep on interactive startup so markers left by crashed/SIGKILL'd sessions can no longer accumulate without bound (354 dead markers observed on one machine). Only dead/stale markers are removed; live sessions are untouched.
- Add opt-in resident session pruning after successful compaction and during compacted-session hydration (`compaction.residentPrune` / `PI_RESIDENT_SESSION_PRUNE=1`), planning current-version loads from raw-line metadata and applying stubs before summarized candidate payload JSON is parsed, plus a Claude/Pi RSS audit harness.
- Report loaded context usage separately from unloaded provider-deferred tool schemas in context-usage diagnostics and the TUI footer.
- Expose `ctx.reload()` on extension event contexts so model-switch handlers can rebuild provider-specific runtime resources without queuing slash-command text.
- Agents status pane now shows a live elapsed-seconds counter for in-progress runs (e.g. `running 12s`): `formatDuration` renders live elapsed for `running` runs, and `AgentsPane` repaints on a 1s ticker (duplicate-guarded, `unref`'d, cleared on dispose). Previously running rows showed a static `running` placeholder.
- Remove the dormant, never-activated background-tasks pane (`background-tasks-ui.ts`). It was added but never imported into the runtime and is superseded by the agents status pane; the public `Task*` tool factories in `core/tools/background-tasks.ts` are unchanged.

This file is fork-owned (`.gitattributes` `merge=ours`) so upstream syncs no
longer append their full changelog here.
