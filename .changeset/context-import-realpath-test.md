---
"@lue-labs/pi-coding-agent": patch
---

Fix the `context file @ imports` home-relative test on macOS.

The importer resolves paths with `realpathSync.native` (it dedups imports across roots by real path), but the test compared against the unresolved path. On macOS the temp HOME lives under `/var`, a symlink to `/private/var`, so the assertion failed locally while passing on Linux CI. Test-only; no behavior change.
