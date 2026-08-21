---
"@lue-labs/pi-agent-core": patch
"@lue-labs/pi-coding-agent": patch
---

continue pending input after interrupting an active turn

Escape now aborts the current response, resumes queued messages with the existing steering-before-follow-up and queue-mode semantics, then submits composer text as the next normal user turn. Repeated interrupts during the handoff are idempotent, and an empty composer with no queued messages remains a plain abort.
