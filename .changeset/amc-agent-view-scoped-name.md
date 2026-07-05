---
"@valkyriweb/pi-coding-agent": patch
---

Fix `pi agents` failing to find an installed `pi-agent-view` extension when
it's published under an npm scope (e.g. `@valkyriweb/pi-agent-view`, as
my-pi-full's bundle does). The dashboard-package resolver previously matched
the extension's `package.json` `name` against the literal string
`pi-agent-view` only, so any scoped publish silently missed the match and `pi
agents` printed `Error: \`pi agents\` requires the pi-agent-view package` even
though the package was installed and enabled. It now also matches scoped
names ending in `/pi-agent-view`. Found during live-verification of the
agents-mission-control program (docs/plans/agents-mission-control) — this was
the original user-reported `pi agents` bootstrap failure.
