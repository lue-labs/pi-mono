# Changelog

## [Unreleased]

### Fixed

- Memory: cap the supervised RPC child `stderrBuffer` to a 64 KB tail; a long-lived `pi` child that logs to stderr over its lifetime no longer grows this string without bound.

- Resolve `@valkyriweb/pi-coding-agent/rpc-entry` via the ESM resolver (`import.meta.resolve`); the CJS `require.resolve()` rejected the ESM-only subpath export and broke every non-bun `orchestrator spawn` with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

## [0.81.1] - 2026-07-21

## [0.81.0] - 2026-07-21

### Changed

- Renamed the orchestrator workspace package and internal server references to server ([#6898](https://github.com/earendil-works/pi/pull/6898) by [@cristinaponcela](https://github.com/cristinaponcela)).

## [0.80.10] - 2026-07-16

## [0.80.9] - 2026-07-16

## [0.80.8] - 2026-07-16

## [0.80.7] - 2026-07-14

## [0.80.6] - 2026-07-09

## [0.80.5] - 2026-07-09

## [0.80.4] - 2026-07-09

## [0.80.3] - 2026-06-30
