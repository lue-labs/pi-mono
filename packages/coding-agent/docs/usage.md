# Using Pi

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Footer cache hit rate

The footer's `cache N%` value is computed from the current session tree's **active branch** after the latest compaction:

```text
cacheRead / (input + cacheRead + cacheWrite)
```

Provider usage is normalized before display:

- `claude-bridge` / Anthropic-style providers can report both `cacheRead` and `cacheWrite`; writes are included in the denominator because they are cacheable prompt work that missed and had to be created.
- `openai-codex` / OpenAI Responses-style providers report cached input as `cacheRead` and normally report `cacheWrite = 0`; `input` is already non-cached input, so `cacheRead / (input + cacheRead)` is the comparable provider-reported cache hit rate.

The footer intentionally ignores abandoned branches from `/tree` or `/fork` navigation. Session-wide diagnostics such as `pi-cache-stats` may show both active-branch and full-tree totals.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Images | Paste with Ctrl+V, Alt+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |

See [Keybindings](keybindings.md) for all shortcuts and customization.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/agents` | List native child agents, run native agent subcommands, or insert an agent prompt scaffold |
| `/agents-doctor` | Diagnose native agent definitions, chains, tools, models, and runtime services |
| `/agents-status [run-id]` | Show recent native child-agent runs, or inspect one run in detail |
| `/agents runs` | Open a selectable recent-runs panel with background controls |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and continue from there |
| `/trust` | Save project trust decision for future sessions |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL |
| `/import <file>` | Import and resume a session from a JSONL file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit pi |

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want pi to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.pi/agent/sessions/`, organized by working directory.

```bash
pi -c                  # Continue most recent session
pi -r                  # Browse and select a session
pi --no-session        # Ephemeral mode; do not save
pi --name "my task"    # Set session display name at startup
pi --session <path|id> # Use a specific session file or session ID
pi --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Context Files

Pi loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.pi/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

Use context files for project conventions, commands, safety rules, and preferences.

Context files support native Claude-Code-style `@` imports before the system prompt is built. Use `@path`, `@./path`, `@../path`, `@~/path`, or `@/absolute/path` to include another text file. Pi strips `#fragments`, supports escaped spaces like `@docs/my\ file.md`, and ignores imports inside fenced/indented code blocks, inline code, and HTML comments. Missing, duplicate/circular, non-file, and unsupported-extension imports are skipped with diagnostics.

Disable loading with `--no-context-files` or `-nc`. If you previously installed an extension that patches the system prompt to expand `AGENTS.md` imports, disable it after upgrading to native support.

### System Prompt Files

Replace the default system prompt with:

- `.pi/SYSTEM.md` for a project
- `~/.pi/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

### Project Trust

On interactive startup, pi asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.pi/agent/trust.json`. Trusting a project allows pi to load `.pi/settings.json` and `.pi` resources, install missing project packages, and execute project extensions.

Before the trust decision, pi loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.pi/agent/settings.json`, or change it with `/settings`.

`pi config` and package commands use the same project trust flow, except `pi update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.pi/agent/trust.json` only; the current session is not reloaded, so restart pi for changes to take effect.


## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link.

If you use pi for open source work and want to publish sessions for model, prompt, tool, and evaluation research, see [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). It publishes sessions to Hugging Face datasets.

## CLI Reference

```bash
pi [options] [@files...] [messages...]
```

### Agent View Command

```bash
pi agents                  # Open the Agent View dashboard from pi-agent-view
pi agents --bg <task>      # Start a detached background task, then show Agent View
```

`pi agents` is a thin core dispatcher. The dashboard UI lives in the separate `pi-agent-view` package; if that package is not installed, Pi prints an install hint instead of loading coding-agent internals.

### Package Commands

```bash
pi install <source> [-l]     # Install package, -l for project-local
pi remove <source> [-l]      # Remove package
pi uninstall <source> [-l]   # Alias for remove
pi update [source|self|pi]   # Update pi only, or one package source
pi update --all              # Update pi and packages; reconcile pinned git refs
pi update --extensions       # Update packages only; reconcile pinned git refs
pi update --self             # Update pi only
pi update --extension <src>  # Update one package
pi list                      # List installed packages
pi config                    # Enable/disable package resources
```

These commands manage pi packages and `pi update` can update the pi CLI installation. To uninstall pi itself, see [Quickstart](quickstart.md#uninstall). `pi config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `pi update` never prompts for project trust.

See [Pi Packages](packages.md) for package sources and security notes.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export a session to HTML |

In print mode, pi also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | pi -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `adaptive` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |
| `--name <name>`, `-n <name>` | Set session display name at startup |

## Native Agent Tool

The built-in `agent` tool delegates work to an in-process child `AgentSession` with its own transcript and bounded tools.

Modes:

```json
{ "agent": "scout", "task": "Find auth-related files" }
{ "tasks": [{ "agent": "scout", "task": "Find models" }, { "agent": "reviewer", "task": "Review API code" }], "concurrency": 2 }
{ "chain": [{ "agent": "scout", "task": "Map the flow" }, { "agent": "plan", "task": "Plan from: {previous}" }] }
{ "agent": "worker", "task": "Run the long migration audit", "background": true }
{ "action": "interrupt", "runId": "agent-1" }
{ "action": "resume", "runId": "agent-1", "message": "Continue from the interrupted audit." }
```

Options include `context` (`default`, `fork`, `slim`, `none`), `model`, `thinking`, `tools`, `output`, `outputMode` (`inline`, `file`, `both`), `chainDir`, `background`, and `agentScope` (`user`, `project`, `both`). Use `default` for a fresh named Agent with its profile-filtered tools. `fork` is a permissive self-fork that preserves the caller transcript, frozen system prompt when available, and tool set; a selected named role is appended as trailing guidance, and Pi warns when fork bypasses ordinary profile tool filtering. Nested Agent availability remains profile- and depth-capped. Built-ins and user agents are available by default; project agents require explicit scope and confirmation.

Interactive slash helpers:

```text
/agents                         # selector
/agents run scout -- map auth    # single-agent scaffold
/agents parallel scout,reviewer -- inspect auth
/agents run-chain review -- auth flow
/agents list-chains
/agents doctor                  # same report as /agents-doctor
/agents status                  # same report as /agents-status
/agents runs                    # selectable recent-runs panel
/agents-status agent-1           # detail view for one native agent run
/agents interrupt agent-1        # interrupt a running background run; leaves it resumable when possible
/agents cancel agent-1           # cancel a running/interrupted background run
/agents resume agent-1 -- continue the audit
```

Saved chains live in `~/.pi/agent/chains/*.json` or project `.pi/chains/*.json`:

```json
{
  "name": "review",
  "description": "Scout, then review",
  "chain": [
    { "agent": "scout", "task": "Map the requested area" },
    { "agent": "reviewer", "task": "Review this handoff: {previous}" }
  ]
}
```

Project chains override user chains with the same name. `/agents-status` tracks recent native foreground and background child-agent runs. Detail mode shows the child session ref/path, status timeline summary, recent tool calls, invoked skills, usage, errors, output refs, and whether an interrupted background run can be resumed. Background runs also appear in the footer with a `/agents runs` shortcut to the selectable control panel. Pi does not enforce a hard timeout for child agents; background runs are monitored for stalled progress and marked `needs attention` so you can inspect, interrupt, or cancel them from `/agents runs`.

During a native `agent` tool call, collapsed rendering shows mode, agents, per-child status, current tool, tool count, compact token usage (`32k tok`), minute-aware duration (`1m 12s`), and session/output refs. Expanded rendering adds recent tools, recent output snippets, invoked/loaded skills, model/thinking, errors, and output paths.

Child sessions are persisted as normal Pi sessions with the parent session recorded as their parent reference. Inspect them via `/agents-status <run-id>` or the printed session path. Native background resume continues single-child interrupted runs from the persisted child session when the original Pi process still owns the run controller.

Non-fork Agent task tools are computed from the calling session's active tools, requested tools, profile allow/deny lists, and the configured nesting depth. Fork mode instead retains inherited tool schemas for cache identity unless the task explicitly narrows them; named profile restrictions are guidance rather than hidden runtime blocks. The Agent engine still remains unbound when the selected profile or depth denies nested delegation. `--tools`, `--no-builtin-tools`, and `--no-tools` continue to set the calling-session ceiling; tasks cannot gain tools that are not active there.

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools, including `agent` |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

`grep` uses ripgrep (`rg`) and `find` uses fd (`fd`) for fast .gitignore-aware traversal. Both default to a 30s timeout and accept `timeout` in seconds up to 300s. For huge trees, narrow `path`/`glob` first; raise `timeout` only for intentional broad searches.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
pi --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include them in the message:

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
pi "List all .ts files in src/"

# Non-interactive
pi -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | pi -p "Summarize this text"

# Named one-shot session
pi --name "release audit" -p "Audit this repository"

# Different model
pi --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
pi --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
pi --model sonnet:high "Solve this complex problem"

# Limit model cycling
pi --models "claude-*,gpt-4o"

# Read-only mode
pi --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
pi --exclude-tools ask_question
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | Override config directory; default is `~/.pi/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | Override session storage directory; overridden by `--session-dir` |
| `PI_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `PI_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `PI_SKIP_VERSION_CHECK` | Skip the Pi version update check at startup. This prevents the `pi.dev` latest-version request |
| `PI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no`. This does not disable update checks |
| `PI_CACHE_RETENTION` | Set to `long` for extended prompt cache where supported |
| `VISUAL`, `EDITOR` | Fallback external editor for Ctrl+G when `externalEditor` is unset; defaults to Notepad on Windows and `nano` elsewhere |

## Design Principles

Pi keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.

It intentionally does not include built-in MCP, permission popups, plan mode, to-dos, or background bash. Native `agent` covers bounded in-process child sessions, single/parallel/chain delegation, diagnostics, recent status, saved chains, and background lifecycle control for native child-agent runs. Manager editing screens remain extension territory.

For the full rationale, read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/).
