---
"@valkyriweb/pi-coding-agent": patch
---

Skip an auto-discovered extension that fails to load instead of exiting.

A repo-local `.pi/extensions/*.ts` that could not be imported took the whole process down. In a fresh worktree of this repository that meant two dev conveniences importing an unbuilt workspace package made the repo unhostable for any agent until a nine-package build had run, and the only symptom anyone saw was a startup timeout.

Extensions found by scanning an extensions directory are conveniences nobody asked for by name, so one failing now degrades: it is reported as a warning, listed in the loaded-resources panel, and startup continues. Extensions requested by name — `-e <path>`, a `settings.json` entry, or a package-provided extension — still fail hard, because silently dropping something that was asked for is worse than stopping. `PI_STRICT_EXTENSIONS=1` restores the old all-fatal behaviour for CI.

The underlying error text is unchanged; only the severity moved.
