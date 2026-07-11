---
"@valkyriweb/pi-coding-agent": minor
---

Preserve dirty-shutdown evidence as `.crashed` session tombstones instead of deleting stale `.live` markers, badge crashed sessions in the resume picker (`✗`), clear tombstones when a session is reopened, and age out tombstones after 30 days. Enables browser-style "restore my sessions" after a crash, power loss, or reboot.
