---
"@valkyriweb/pi-coding-agent": patch
---

enforce a configurable default foreground timeout for the bash tool

A foreground bash call blocks the whole turn and cannot be interrupted, so the harness now resolves a default timeout for every call that omits `timeout`: `PI_BASH_TIMEOUT_SECONDS` > the new `bashTimeoutSeconds` setting > a 120s built-in default (previously an undocumented, unconfigurable 300s). `0` from either source restores unbounded foreground execution. An explicit `timeout`, `timeout: false`, and `run_in_background: true` all still outrank the default, and background jobs remain genuinely unbounded. On timeout the whole process tree is killed and the error now names the measured elapsed time, keeps the output captured before the kill, and lists every way to raise the limit.
