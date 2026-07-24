---
"@valkyriweb/pi-coding-agent": patch
---

Fix: cancelling a background Agent run now settles it even when its controller is gone (interrupted runs after the executor loop detaches, or zombie running runs with no live child session). Cancel is idempotent on already-settled runs, and cancelling settles interrupted children left over from an earlier interrupt of the same run. Previously the TUI cancel action and bulk kill-all silently no-op'd on these runs, leaving permanently stale rows the operator could not dismiss. Refs #303.
