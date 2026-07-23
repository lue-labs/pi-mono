# @valkyriweb/pi-tui

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

## Unreleased

- StdinBuffer: treat an unbracketed multi-line stdin chunk (no escape sequences, content spanning multiple lines) as a single paste event. Prevents terminals/muxes that strip bracketed-paste markers (e.g. tmux `-CC` control-mode clients) from shredding a paste into one submitted message per line. Single-line chunks with a trailing newline still submit, so programmatic text-plus-Enter automation is unaffected.

- Memory: bound the OSC 11 background-color pending-query backlog. Timed-out queries are still consumed if the terminal answers late, but on a terminal that never answers the backlog (and its reply counter) no longer grows without limit.

- Add an optional `captureInput?: boolean` component hint so higher-level pane hosts can keep focus on an existing editor/input surface for display-only components.

- Clamp overwide non-image render lines at the TUI boundary instead of crashing the interactive session with `Rendered line ... exceeds terminal width`.

This file is fork-owned (`.gitattributes` `merge=ours`) so upstream syncs no
longer append their full changelog here.
