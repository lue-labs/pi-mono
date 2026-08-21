# Claude Code 2.1.232 agents-view parity: status ordering and initial-load filtering

Grounding evidence for the `/agents runs` view (`agent-runs-selector.ts`), extracted
from the installed Claude Code CLI binary
`~/.local/share/claude/versions/2.1.232` (Bun-compiled Mach-O arm64; string
literals intact) via `binlens search/strings` and bounded byte-window reads,
cross-referenced against the April source snapshot in
`~/Projects/oss/claude-code-cli-src-code/src_extracted/src` and the RE pack in
`~/Projects/oss/claude-code-cli-src-code/re-2.1.201/agents-and-tasks.md`.

## What Claude Code actually does (2.1.232)

### Durable registry vs view filtering — they are distinct layers

CC's task registry (`AppState.tasks`) **retains terminal tasks**. Eviction is a
separate, condition-gated GC, not an automatic delete-on-completion:

- `Yjb` (minified eviction fn, offset `0x10703f2c` region) refuses to evict a
  task unless it is terminal (`kC(status)`), `notified === true`, its
  `evictAfter` deadline has passed, and it has no `keepaliveReasons`.
- Completion sets `evictAfter = Date.now() + kye` where `kye = 30000`
  (offset `0x10704846`: `var jLr=3000,kye=30000,nhp=30000`). This matches the
  April source's `PANEL_GRACE_MS = 30_000` in `utils/task/framework.ts`.
- `retain`ed tasks and tasks with live `keepaliveReasons` never get a deadline
  (`Lha`, offset `0x107055e3`: `if(e.retain)return; if(t.park && keepaliveReasons.size>0)return; return Date.now()+kye`).

### The 2.5s timer is an ephemeral completion nudge, not deletion

The only 2.5s constant in an agent/task context is `$Rw = 2500` (offset
`0x1127b8cc`), used by hook `qzh`: on a completion-edge transition it sets a
boolean for 2.5s and renders an animated top/bottom border flash
(`"\u2500"` runs through a color ramp) — a UI attention nudge. It does not
touch the registry. Do not model registry lifetime on it.

### Dialog ordering (background-tasks dialog, `HGi`, offset `0x111fb740`)

```js
sort((a, b) => {
  if (a.status === "running" && b.status !== "running") return -1;
  if (a.status !== "running" && b.status === "running") return 1;
  return b.task.startTime - a.task.startTime; // newest first
})
```

Running rows first, remainder newest-first by start time. Groups are then
bucketed by kind (teammates → shells → monitors → mcp → remote → agents →
completed agents → workflows → dreams → auto-mode scans) for section headers;
2.1.232 added a distinct `completedAgentTasks` bucket (`MGi`/`bOh`: completed,
not quietly parked) so settled-but-retained agents render separately from live
ones instead of interleaving.

### Initial-load filtering

The dialog's visibility predicate `TXl` shows a **completed** `local_agent`
only while it is still retained: real subagent (`e4`), backgrounded, not an
observer (`JR`), `evictAfter !== 0`, and every keepalive reason is the benign
`"flag:idle-window"` (`WOe`). Everything else terminal is view-hidden even
though the registry row may briefly survive until GC. Net effect on (re)open:
stale completed agents older than the 30s grace are gone; failed/stopped rows
that still need the user are not silently dropped by the grace path (they go
through kill/notify flows with their own `STOPPED_DISPLAY_MS = 3000` display
window).

## Chosen Pi UX (this fork)

Pi's registry (`core/agents/status.ts` `recentRuns`) is deliberately more
durable than CC's: it is the source for `/agents status`, resume, and the
extension task registry, bounded at `MAX_RECENT_RUNS = 25` with
never-evict-running/parked pruning. We do **not** delete terminal runs from it.

Parity is implemented purely at the view layer, in
`selectAgentRunRows(runs, nowMs)` (`components/agent-runs-selector.ts`):

- **Ordering** (CC-identical): running rows first, then newest-first by
  `startedAt`.
- **Initial-load filtering** (CC-shaped, Pi-adjusted): `completed` and
  `cancelled` rows disappear from the view once
  `AGENT_RUN_SETTLED_VIEW_GRACE_MS = 30_000` has passed since `endedAt` —
  same 30s grace as CC's `kye`/`PANEL_GRACE_MS`. `failed` and `interrupted`
  rows never age out: unlike CC's evicted states, Pi's rows carry actionable
  operator verbs (error detail, `r` resume, `c` cancel) and hiding them would
  strand a run you can still act on. Rows without a parseable `endedAt` are
  kept (fail open).
- The registry stays intact: `/agents status` and `/agents status <id>` still
  list every retained run, including ones the selector no longer shows.

Tests: `test/agent-runs-selector.test.ts` (`selectAgentRunRows` describe
block).
