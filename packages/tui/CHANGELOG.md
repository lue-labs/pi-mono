# @valkyriweb/pi-tui

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

## Unreleased

- Clamp overwide non-image render lines at the TUI boundary instead of crashing the interactive session with `Rendered line ... exceeds terminal width`.

This file is fork-owned (`.gitattributes` `merge=ours`) so upstream syncs no
longer append their full changelog here.
