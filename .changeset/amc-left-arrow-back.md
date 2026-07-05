---
"@valkyriweb/pi-coding-agent": patch
---

Add `app.agentView.back` keybinding (default: left arrow) — a thin, additive
`AppKeybindings` entry so extensions (e.g. `agent-view`'s dashboard) can offer
a user-remappable "return to dashboard" action via `CustomEditor`/
`KeybindingsManager`, without any new core dispatch wiring. Slice 6 of the
agents-mission-control program (docs/plans/agents-mission-control).
