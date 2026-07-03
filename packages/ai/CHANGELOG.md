# @valkyriweb/pi-ai

This package's release notes are split:

- **Fork-specific notes** (the canonical source) live in the repo-root
  [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md).
- **Upstream history** (earendil-works/pi-mono, Keep-a-Changelog format) is
  archived in [`CHANGELOG.upstream.md`](./CHANGELOG.upstream.md).

## Unreleased

- Fix: OpenAI Responses usage parsing now records provider-compatible cache-write metadata without double-counting Anthropic-style total + breakdown fields.
- Fix: Codex Responses adapter no longer forwards `prompt_cache_retention` (the ChatGPT `chatgpt.com/backend-api` backend now rejects it with `Unsupported parameter`, 400ing every Codex request). Cache affinity is preserved via `prompt_cache_key` + `session-id`. See root `FORK-CHANGELOG.md`.
- Add Anthropic tool namespace serialization support with a `PI_ANTHROPIC_NAMESPACE_WIRE=0` kill switch so grouped deferred tools can be emitted without changing flat-tool behavior when disabled.

This file is fork-owned (`.gitattributes` `merge=ours`) so upstream syncs no
longer append their full changelog here.
