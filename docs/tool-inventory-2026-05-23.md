# Pi Tool Inventory — 2026-05-23

Snapshot of every tool a `pi` session running the `my-pi-full` profile can
call, grouped by source. Built from:
- `git diff upstream/main..main` (fork-only files in `pi-mono-fork`)
- AST/regex scan of `my-pi/extensions/*/`
- Inspection of installed third-party extensions under `~/.pi/agent/git/`
- Earlier audit doc `docs/fork-divergence-audit-2026-05-23.md`

## Summary

| Source | Tool count |
|--------|-----------:|
| Upstream pi core (canonical) | 9 |
| pi-mono-fork core, fork-only additions | 12 (3 standalone + 6 Uppercase + 3 bash bg) |
| my-pi extensions | ~35 across 13 extensions |
| Third-party extensions (installed) | ~10 |
| **Total runtime tools (deduped)** | **~50** |

## Upstream pi core (untouched by fork)

These ship in `@lue-labs/pi-coding-agent` upstream. No fork divergence
on the canonical lowercase names.

| Tool | File | Notes |
|------|------|-------|
| `read` | `core/tools/read.ts` | Fork adds `toolName` option for Uppercase alias |
| `bash` | `core/tools/bash.ts` | Fork adds `run_in_background`/`tui_only` + bg-job mgmt |
| `edit` | `core/tools/edit.ts` | Fork adds `hunks`/`originalContent` in details |
| `write` | `core/tools/write.ts` | Fork adds Uppercase alias support |
| `grep` | `core/tools/grep.ts` | Fork adds ugrep backend + Uppercase |
| `find` | `core/tools/find.ts` | Fork adds offset/headLimit + Uppercase |
| `ls` | `core/tools/ls.ts` | Fork adds Uppercase alias |

## Fork-only core additions (pi-mono-fork)

**Tools in `packages/coding-agent/src/core/tools/` not present in upstream:**

| Tool | File | LOC | Status |
|------|------|----:|--------|
| `agent` / `Agent` / `Task` | `agent.ts` | 587 | Fork-only entire file; PR #3 target |
| `WebFetch` / `web_fetch` | `web-fetch.ts` | 75 | Fork-only entire file; **PR #1B target — already mirrored in `native-tool-aliases` extension** |
| `WebSearch` / `web_search` | `web-search.ts` | 79 | Fork-only entire file; **PR #1B target — already mirrored in `native-tool-aliases` extension** |
| `Read` (Uppercase alias) | `read.ts:372-381` | ~15 | **PR #1B target — already mirrored** |
| `Edit` (Uppercase alias) | `edit.ts` | ~15 | **PR #1B target — already mirrored** |
| `Write` (Uppercase alias) | `write.ts` | ~15 | **PR #1B target — already mirrored** |
| `Grep` (Uppercase alias) | `grep.ts` | ~15 | **PR #1B target — already mirrored** |
| `Find` (Uppercase alias) | `find.ts` | ~15 | **PR #1B target — already mirrored** |
| `Ls` (Uppercase alias) | `ls.ts` | ~15 | **PR #1B target — already mirrored** |
| `bash_output` / `BashOutput` | `bash.ts` | shares with bash | PR #2 target |
| `bash_kill` / `KillShell` | `bash.ts` | shares with bash | PR #2 target |
| `Bash` (Uppercase alias) | `bash.ts` | ~15 | PR #2 target (couples to bg-job) |
| `Agent` / `Task` (Uppercase) | `agent.ts` | shares | PR #3 target |

**Subsystems supporting these tools (also fork-only, not standalone tools):**
- `core/agents/` — 13 files, ~1,500 LOC (multi-agent orchestration)
- `core/tasks/` — 6 files, ~400 LOC
- `core/deferred-tool-*` — 4 files, ~450 LOC (powers `tool_search`)
- `core/cache-affinity.ts` — system prompt cache optimization
- `core/context-file-imports.ts` — context imports
- `utils/color-diff.ts` — ColorDiffComponent renderer

## my-pi extensions

Captured via AST scan; counts may undercount extensions using dynamic registration
(loops, factories). Verified entries from `~/Projects/personal/my-pi/extensions/`:

| Extension | Tools registered |
|-----------|------------------|
| `advisor` | `advisor` |
| `agent-view` | (UI-only, no tool registration) |
| `boot-context-log` | (lifecycle hooks only) |
| `codex-service-tier` | (provider config only) |
| `computer-use` | `computer_use` |
| `context-forking` | `context_fork` |
| `dream-memory` | `memory_note` |
| `github-pr` | (slash commands only) |
| `handoff` | (slash commands only) |
| `letta-shadow` | (memory shim, no tools) |
| `mem0-shadow` | (memory shim, no tools) |
| `monitor` | `monitor_start`, `monitor_status`, `monitor_read`, `monitor_stop`, `monitor_list` |
| **`native-tool-aliases`** ⭐ NEW | `Read`, `Edit`, `Write`, `Grep`, `Find`, `Ls`, `WebFetch`, `web_fetch`, `WebSearch`, `web_search` |
| `notify` | (UI notifications, no tool) |
| `pi-goal` | `get_goal`, `goal_wait`, `update_goal`, `rewrite_goal_objective` |
| `pi-memory` | (memory hooks) |
| `pi-routine` | (routine engine, slash commands) |
| `pi-semantic-grep` | `semantic_grep` / `SemanticGrep` |
| `pi-workflow` | `Workflow` |
| `session-title` | (slash command + lifecycle) |
| `skill-loader` | `skill`, `skill_search` |
| `syntax-input` | (input hook) |
| `task-tools` | `task_create`, `task_get`, `task_update`, `task_list` |
| `third-party/pi-context-lue` | `context_tag`, `context_log`, `context_checkout`, `context_tree_query` |
| `time-context` | (system prompt hook) |
| `tokenjuice` | (compactor hook) |
| `tool-search` | `tool_search` |

## Third-party extensions (installed via `~/.pi/agent/git/`)

| Repo | Tools |
|------|-------|
| `davebcn87/pi-autoresearch` | `init_experiment`, `run_experiment`, `log_experiment` |
| `kostyay/pi-k-excalidraw` | `draw_diagram`, `save_diagram`, `list_diagrams`, `load_diagram`, `screenshot_diagram`, `draw_mermaid_diagram` |
| `nicobailon/pi-intercom` | `contact_supervisor`, `intercom` |
| `badlogic/pi-diff-review` | (slash command only) |
| `dbachelder/pi-btw` | (slash command only) |

## Drift snapshot — what's still in pi-mono-fork core

Per-file LOC delta vs `upstream/main` for `core/tools/`:

| File | +LOC | -LOC | PR plan |
|------|-----:|-----:|---------|
| `bash.ts` | 738 | 20 | PR #2 (bg-job extraction) |
| `grep.ts` | 451 | 35 | PR #5 (ugrep backend; needs upstream PR or extension) |
| `index.ts` | 312 | 25 | PR #1B (delete Uppercase entries) |
| `find.ts` | 221 | 41 | PR #5 (offset/headLimit; needs upstream PR or extension) |
| `edit-diff.ts` | 34 | 102 | PR #5 (ColorDiff integration) |
| `edit.ts` | 115 | 14 | PR #1B (delete Uppercase) + PR #5 (hunks/originalContent details) |
| `ls.ts` | 32 | 6 | PR #1B (delete Uppercase) |
| `read.ts` | 24 | 8 | PR #1B (delete Uppercase) |
| `write.ts` | 18 | 3 | PR #1B (delete Uppercase) |
| `agent.ts` | 587 | 0 | PR #3 (whole subsystem) |
| `web-fetch.ts` | 68 | 0 | PR #1B (delete; mirrored in extension) |
| `web-search.ts` | 68 | 0 | PR #1B (delete; mirrored in extension) |

**Total fork-only LOC in `core/tools/` alone: ~2,800 added, ~250 removed.**

## Status of refactor pipeline

| PR | Status | Description |
|----|--------|-------------|
| **#1A** | ✅ Shipped (`my-pi@debd22f`) | Created `native-tool-aliases` extension that overrides Read/Edit/Write/Grep/Find/Ls + WebFetch/WebSearch. Additive — fork core unchanged. Smoke test (10 tools) passes. |
| **#1B** | ✅ Shipped (`pi-mono-fork@cc333ab2`) | Deleted `web-fetch.ts` + `web-search.ts` from `core/tools/` and removed their `index.ts` switch arms + `ToolName` entries. Net **-154 LOC removed**, +9 LOC for a new bridge-only gate in `agent-session.ts::_refreshToolRegistry`. Test migration used the existing `DefaultResourceLoader.extensionFactories` option (no new core hook needed). All 106 tests in the refactor's blast radius pass. |
| **#1C** | ✅ Shipped (2026-05-24) | Deleted the 6 Uppercase factories (`createUppercase{Read,Edit,Write,Grep,Find,Ls}Tool[Definition]`) and their entries from `core/tools/index.ts` (ToolName, allToolNames, switch arms, bulk registries). Updated `core/sdk.ts` to use `string[]` for `defaultActiveToolNames` (the 6 names are no longer in `ToolName`). Removed factory exports from `src/index.ts`. Net **-218 / +86 LOC** across 14 files. Diagnostic note from the earlier two attempts: the `forkAgent` "bypass" hypothesis was wrong — the issue was vite cache serving stale builds of `_forkAgentFromExtension`. After clearing `node_modules/.vite`, probes fired correctly and showed `effectiveTools=["Read"]` (intersection was fine). The actual test failure was on the SECOND assertion (`childToolNames`): the test harness creates a fresh `DefaultResourceLoader` per child session that doesn't inherit the parent's in-memory `extensionFactories`, so extension-provided tools don't propagate to child API calls. Production isn't affected (child loaders discover on-disk extensions the same way the parent does). Test fixed by switching `allowedTools: ["Read"]` → `["Bash"]` (still core); same allowedTools-intersection logic exercised. Shipped in `fb088467`, merged `d6441ba3`. |
| **#2** | ⏸ Queued | Extract bash bg-job system (`bash_output`/`bash_kill`/`run_in_background`/persistent registry) to `my-pi/extensions/bash-bg`. Blocked on resolving where `BashBgJob`/`getBashBgJob`/`subscribeBashBgJobs` shared types live (currently imported by `my-pi/packages/pi-agent-ui/src/components/zoomed-bash.ts`). |
| **#3** | ⏸ Queued | Extract `core/agents/` + `core/tasks/` + `core/tools/agent.ts` to a fork package or extension. Largest extraction (~2,500 LOC); needs its own approval cycle. |
| **#4** | ⏸ Queued | Extract `core/deferred-tool-*` to `my-pi/extensions/tool-search` (consolidate with the existing `tool_search` tool). |
| **#5** | ⏸ Queued (smaller) | Upstream PRs (or extensions) for `grep` ugrep backend, `find` offset/headLimit, `edit` `hunks`/`originalContent` details — features that probably belong upstream. |

## Latent issues found during this audit

1. **`pi-otel-exporter` stale-ctx on startup** (pre-existing, exposed by E2E test): Extension fails to load with "ctx is stale after session replacement or reload". Affects load on every `pi` invocation. Not fatal — pi continues — but consumes log noise and may break observability.
2. **`session-title` stale-ctx on dispose** (pre-existing): `setTimeout(updateTitle, 0)` captures ctx that becomes stale once `-p` mode disposes the session. Crash visible in `pi -p` runs.
3. **Profile classifier missing entries for `letta-shadow` and `mem0-shadow`** (pre-existing): `npm run check:profiles` fails until classified. Not blocking, but should be cleaned up.
