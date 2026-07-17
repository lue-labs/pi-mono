# Spec: Owner-scoped orphan reaping for background jobs (CC/Codex parity)

Status: draft (approved by Luke: "spec + implement")
Owner: Rusty
Origin: Luke's incident — 7× `rusty-review … working · 3h4m…` background entries that
had *finished* (final output in log) but whose processes stayed alive for hours; had to be
hand-killed with `kill -TERM -- -<pgid>`.

## Problem

A background job whose owning context (sub-agent run / turn) has moved on becomes an
**unreachable orphan**: nothing can `bash_output`/`bash_kill` it, and Pi only reaps
background jobs on explicit `bash_kill` or **root** session dispose (`killAll`). So orphans
sit "working" indefinitely, leaking PIDs/RAM and cluttering the agents panel.

## Reverse-engineered prior art (binlens, 2026-07-17)

Binaries:
- Codex: `…/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` (Rust)
- Claude Code: `~/.local/share/claude/versions/2.1.206` (Bun-compiled)

### Codex CLI
- `core/src/unified_exec/{process_manager,process,async_watcher}.rs`. Exec runs in a PTY
  session that **yields** after `yield_time_ms` (default 10s, range 250–30000) returning a
  cell/session id; re-attach via `wait`/`write_stdin`. Process is owned by a session handle,
  never a naked detached child.
- **kill-on-drop**: tokio `ChildDropGuard` / `kill_on_drop` — child dies when the handle drops.
- Process-**group** kills on teardown: `failed to kill exec-server stdio process group`,
  `Failed to kill MCP process group`.
- **Orphan sweep**: `thread/backgroundTerminals/clean` (+ `failed to clean background
  terminals`, `invalid background terminal process id`) — background terminals cleaned on
  thread resume.
- Sub-agents: separate pool with `spawn_agent`/`wait_agent`/**`close_agent`** lifecycle.

### Claude Code CLI
- `taskRegistry`; tool `Stop Task` (`task_id`; `shell_id` deprecated → telemetry
  `tengu_dead_probe_taskstop_shell_id`). `LocalShellTask` states `running/stopped/killed`.
- Kill = `shellCommand.kill()` **+ `shellCommand.cleanup()`** (native `killProcessTree`:
  walks `ps` pid/ppid `^\s*(\d+)\s+(\d+)\s*$`, `enum_spawn`/`group_kill`, SIGKILL,
  ESRCH-tolerant), clears `cleanupTimeoutId`.
- **Orphan reaper (the key one)**: `killShellTasksForAgent: killing orphaned shell task` —
  when an **agent** finishes, CC tree-kills the background shells that agent owned.
- Session teardown loop tree-kills every running `local_bash` task, `abortController.abort()`s
  the rest.

### Pi today (already strong)
`core/bash-bg-jobs.ts` + `utils/shell.ts`:
- `spawn(..., { detached:true })` → each job is its own process-group leader.
- `killProcessTree(pid)` = `process.kill(-pid,"SIGKILL")` (group kill; single-PID fallback).
- Completion/crash wake listeners, concurrency cap (`PI_BASH_BG_MAX`=32), stale-log sweep.
- `killAllBashBgJobs()` on session dispose (built-in `bash-bg-jobs` extension).

**Gap vs CC/Codex:** no *owner-scoped* sweep. `killAll` is process-global and only reliably
fires on the root session. There is no CC-style `killShellTasksForAgent`.

## Decisive open question (implementation must confirm FIRST, with evidence)

Which registry owned Luke's 7 leaked entries?
- (A) **Pi bash-bg jobs** (`bash-bg-jobs.ts`), spawned inside sub-agent runs whose sessions
  were still parked/"working" (so `killAll` never fired). Panel label "Codex adapter · 7
  working · ← for agents" suggests these were agent-run children.
- (B) **Background agent runs** (`core/agents/executor.ts`) that parked/hung — the leaked
  *processes* being the `pi`/`codex` engine subprocesses the rusty-review script spawned.
- (C) my-pi **codex-adapter** background terminals.

Confirm by tracing how `rusty-review` is backgrounded in Luke's flow (skill `review`
scripts + how Pi surfaces the "working" panel). Do not implement in the wrong subsystem.

## Design (CC-parity, correct regardless of A/B/C)

1. **Tag ownership.** `BashBgJob` gains `ownerSessionId?: string` (the AgentSession that
   spawned it). `spawnBashBackground`/`adoptBashBackground` receive it from the bash tool's
   execution context (`_ctx`). Root/main session id is recorded too.

2. **Session-scoped reap.** Add `killBashBgJobsForSession(sessionId)` that tree-kills only
   running jobs with that `ownerSessionId` (CC `killShellTasksForAgent`). It does NOT clear
   the whole registry.

3. **Wire per-session dispose.** The built-in `bash-bg-jobs` extension's `onSessionDispose`
   handler knows its own session id → call `killBashBgJobsForSession(thisSessionId)` for
   non-root sessions. Root session keeps `killAll()` as the final backstop. This also fixes a
   latent over-aggressive bug: if a sub-agent session currently reaches `killAll`, it nukes
   the *parent's* jobs — session-scoping removes that footgun.

4. **(Optional, opt-in) parked-run reap.** If (B): when a background agent run reaches a
   terminal/parked-too-long state, tree-kill jobs/subprocesses it owns. Gate behind a flag;
   do NOT auto-kill live main-session jobs on idle (would kill dev servers).

## Non-goals
- No idle-output stale timeout by default (unsafe — kills long-running servers).
- No change to `params.system` or `tools[]` (cache-stable; this is registry/lifecycle only).

## Acceptance criteria
- New unit tests: (a) `killBashBgJobsForSession` kills only owned running jobs, leaves others;
  (b) sub-agent session dispose reaps its jobs and NOT the parent's; (c) root dispose still
  backstops everything.
- Regression: prove the orphan survives on baseline (job owned by a disposed non-root session
  stays `running`) and is reaped after the change.
- Gates green: `npm run test:extension-gate` + individual `bash`/bg smoke/cache tests;
  `npm --prefix ~/Projects/personal/pi-mono-fork run test:build-gate`.
- No system-prompt/tools byte drift (cache contract).
- `docs/pi-setup/catalog/*.yaml` + governed docs updated if the setup surface changes.

## Extensibility-ladder note
Rung 1–2: the change lives in fork-owned `bash-bg-jobs.ts` + the built-in `bash-bg-jobs`
extension hook (already a fork seam). No new inline core-logic patch to an upstream-owned
function body. `_ctx` session id is read via existing tool-execution context.
