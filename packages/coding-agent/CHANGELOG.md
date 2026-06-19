# @valkyriweb/pi-coding-agent

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

## Unreleased

- Add opt-in resident session pruning after successful compaction and during compacted-session hydration (`compaction.residentPrune` / `PI_RESIDENT_SESSION_PRUNE=1`), planning current-version loads from raw-line metadata and applying stubs before summarized candidate payload JSON is parsed, plus a Claude/Pi RSS audit harness.
- Report loaded context usage separately from unloaded provider-deferred tool schemas in context-usage diagnostics and the TUI footer.
- Expose `ctx.reload()` on extension event contexts so model-switch handlers can rebuild provider-specific runtime resources without queuing slash-command text.

This file is fork-owned (`.gitattributes` `merge=ours`) so upstream syncs no
longer append their full changelog here.
