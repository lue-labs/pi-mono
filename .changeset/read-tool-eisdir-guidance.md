---
"@valkyriweb/pi-coding-agent": patch
---

The read tool rejects a directory path with an instructive error — "<path> is a directory, not a file. Use bash (ls) to list its contents." — instead of leaking the raw `EISDIR: illegal operation on a directory, read` errno, which gave the model no recovery path.
