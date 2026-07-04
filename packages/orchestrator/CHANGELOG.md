# Changelog

## [Unreleased]

### Fixed

- Resolve `@valkyriweb/pi-coding-agent/rpc-entry` via the ESM resolver (`import.meta.resolve`); the CJS `require.resolve()` rejected the ESM-only subpath export and broke every non-bun `orchestrator spawn` with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## [0.80.3] - 2026-06-30
