# @valkyriweb/pi-ai

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

## Unreleased

- Add Anthropic tool namespace serialization support with a `PI_ANTHROPIC_NAMESPACE_WIRE=0` kill switch so grouped deferred tools can be emitted without changing flat-tool behavior when disabled.

This file is fork-owned (`.gitattributes` `merge=ours`) so upstream syncs no
longer append their full changelog here.
