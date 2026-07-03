# @valkyriweb/pi-agent-core

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

This file is fork-owned (`.gitattributes` `merge=ours`) so upstream syncs no
longer append their full changelog here.

## Unreleased

- Preserve abort reasons when `Agent.abort(reason)` cancels the active run, allowing extension-owned cleanup aborts to be distinguished from generic user/provider aborts.
