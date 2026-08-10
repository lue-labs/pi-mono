#!/usr/bin/env bash
# Tmux smoke verification for the TUI zoom-into-running-agent view.
#
# Why this is a shell smoke and not a vitest test: zooming requires a live
# background `agent` run, which needs a real model and OAuth/API keys.
# AGENTS.md explicitly forbids real provider credentials in the vitest suite,
# so vitest covers the zoom logic in the pi-agent-ui package (my-pi repo), which
# calls the methods directly with stubbed UI, and this script covers the
# end-to-end TTY rendering path on a workstation that *does* have creds.
#
# Usage (from repo root):
#   ./packages/coding-agent/test/tmux/zoom-smoke.sh
#
# What it checks:
#   1. pi starts in a 100x32 tmux session.
#   2. Spawning a background agent run (`/agents` … or a slash command that
#      spawns one) leaves the footer pill showing a running count.
#   3a. Phase 1 hotkey: pressing `app.agents.zoom.enter` (default alt+z)
#       swaps the chat pane for the zoom header `Zoom › agent-…`.
#   3b. Phase 2a footer-nav: pressing Up on an empty editor enters footer-nav
#       mode (pills appear in footer), Up/Down cycle, Enter zooms.
#   4. Typing text + Enter while zoomed renders a `→ <text>` line
#      (the user_injected event) immediately.
#   5. Pressing `app.agents.zoom.exit` (default `escape`) restores the
#      pre-zoom chat pane.
#
# Pre-reqs: tmux installed; `npm run build` has produced dist/, or run
# directly via `./pi-test.sh`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SESSION="pi-zoom-smoke-$$"

cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null || true; }
trap cleanup EXIT

tmux new-session -d -s "$SESSION" -x 100 -y 32
tmux send-keys -t "$SESSION" "cd $ROOT && ./pi-test.sh" Enter
sleep 4

echo "== boot =="
tmux capture-pane -t "$SESSION" -p | tail -12

# The rest is operator-driven: the harness prints the captured pane and
# pauses so a human (or a higher-level eval driver) can spawn a background
# `agent` run, press the zoom hotkey, and visually confirm the transitions.
cat <<'INSTRUCTIONS'

Now drive the smoke manually:

  1) In the tmux session, type a prompt that spawns a background agent:
        agent run --background scout "list every .ts file in packages/ai"

  2) Wait for the footer pill to show "Agents: 1 running".

  --- Phase 1 hotkey path ---
  3a) Press alt+z — confirm header "Zoom › agent-…" appears.
  4a) Type "stop and summarise" + Enter — confirm a "→ stop and summarise"
      line renders immediately.
  5a) Press escape — confirm the chat pane comes back.

  --- Phase 2a footer-nav path ---
  3b) Ensure the editor is empty, then press Up arrow.
      Confirm the footer changes from the plain summary to individual pills
      (each running agent shown as an accent-bold "[agent-N]" pill).
  3c) Press Up/Down — confirm the highlighted pill cycles through agents.
  3d) Press Enter — confirm the zoom header "Zoom › agent-…" appears for
      the highlighted agent.
  3e) Press escape — confirm the chat pane comes back.
  3f) Repeat 3b, then press Escape without pressing Enter — confirm pills
      disappear and the editor is still empty (no zoom entered).

  Attach with:   tmux attach -t SESSION_BELOW

INSTRUCTIONS
echo "SESSION_BELOW=$SESSION"
echo "Leaving session alive. Run: tmux kill-session -t $SESSION  when done."
trap - EXIT
