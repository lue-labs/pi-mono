# Search Tools Parity Notes

These notes capture the Claude Code native search-tool investigation and the proposed direction for Pi's built-in `Grep`/`Glob` tools.

## Current Claude Code native behavior

Claude Code `2.1.126` on native macOS/Linux is a Bun native bundle. Static strings still contain the older JavaScript `GrepTool`/`GlobTool` implementation and embedded `rg` dispatch, but release notes change the interpretation:

- `2.1.117`: native macOS/Linux replaces `Glob` and `Grep` tools with embedded `bfs` and `ugrep` available through Bash, avoiding a separate tool round-trip.
- `2.1.119`: fixed `Glob`/`Grep` disappearing when Bash is denied, which implies the native search tools are Bash-backed.
- `2.1.121`: embedded `grep`/`find`/`rg` shell wrappers fall back to installed tools if the running binary is deleted mid-session.

Confirmed embedded command dispatch by running the Claude native binary with alternate `argv0`:

```bash
exec -a rg    /Users/luke/.local/share/claude/versions/2.1.126 --version # ripgrep 14.1.1
exec -a ugrep /Users/luke/.local/share/claude/versions/2.1.126 --version # ugrep 7.5.0
exec -a bfs   /Users/luke/.local/share/claude/versions/2.1.126 --version # bfs 4.1
```

`exec -a grep` and `exec -a find` print the Claude Code version, so the dedicated embedded tools to target are `ugrep`, `bfs`, and still `rg` for compatibility/internal paths.

## Tool behavior observed

### `ugrep` content search

Useful command shapes:

```bash
# files with matches
ugrep --no-config -r -l PATTERN .

# content with line numbers
ugrep --no-config -r -n PATTERN .

# count
ugrep --no-config -r -c PATTERN .

# include hidden
ugrep --no-config -r -. -l PATTERN .

# respect root and nested .gitignore
ugrep --no-config -r --ignore-files -l PATTERN .

# include hidden and respect ignore files
ugrep --no-config -r --ignore-files -. -l PATTERN .

# ignore ignore-files and include hidden/all
ugrep --no-config -r -@. -l PATTERN .

# glob filter
ugrep --no-config -r -@. -l -g '*.js' PATTERN .

# sort and limit matching files
ugrep --no-config -r -@. --sort=name --max-files=5 -l PATTERN .
```

Observed behavior:

- `ugrep -r -l needle .` did not respect `.gitignore` by default in the test repo.
- `--ignore-files` respected root and nested `.gitignore` files.
- `-.` / `--hidden` includes hidden files.
- `-@.` searches all files, including hidden files, and cancels ignore restrictions.
- `--max-files=N` limits matching files.
- For content output, keep wrapper-side caps/truncation rather than relying only on process flags.

### `bfs` file discovery

Useful command shapes:

```bash
# find files
bfs . -type f -print

# sorted traversal
bfs . -s -type f -print

# glob/path match
bfs . -type f -path './src/*.ts' -print

# basename match
bfs . -type f -name '*.ts' -print

# exclude hidden
bfs . -nohidden -type f -print

# exclude VCS dirs/files
bfs . -exclude -name .git -exclude -name .svn -exclude -name .hg -exclude -name .bzr -exclude -name .jj -exclude -name .sl -type f -print

# limit; requires an action before -limit
bfs . -s -type f -path './many/*.js' -print -limit 5
```

Observed behavior:

- `bfs` includes hidden files and `.git/` by default.
- `bfs` does not implement `.gitignore` behavior by default.
- Claude Code `Glob` also returned `.gitignore`d files in a live test (`ignored/a.txt` and `kept/b.txt` for `**/*.txt` with `ignored/` in `.gitignore`).
- Explicit excludes are required for VCS directories and other safety defaults.
- `-limit N` must follow an action such as `-print`.

## Pi implementation direction

Copy the architecture, not every Claude quirk:

1. Keep first-class Pi tools (`Grep`, `Glob`) instead of exposing raw shell commands as the main interface.
2. Prefer native/controlled backends in this order:
   - bundled `ugrep`/`bfs` when available,
   - system `ugrep`/`bfs`,
   - existing `rg`/`fd` fallback,
   - JS fallback only if needed.
3. Preserve Pi's current safety defaults unless explicitly changed:
   - `grep` respects ignore files, includes hidden files, excludes VCS dirs, truncates long lines, caps results, and times out by default.
   - `Glob` respects `.gitignore` when the `rg`/`fd` backend is active; if moved to `bfs`, add equivalent ignore-file support or keep `fd` fallback for that mode.
4. Keep wrapper-level timeout semantics from the bounded-timeout change:
   - default `30s`, max `300s`, `timeout > 0`, structured timeout details,
   - partial output only when actually collected,
   - AbortSignal cancellation rejects as `Operation aborted`, never as timeout.

## Implemented behavior

- `grep` now resolves a backend before execution:
  1. controlled/system `ugrep` when available,
  2. managed/system `rg` fallback via the existing downloader.
- `ugrep` runs with `--no-config -r -n --with-filename --ignore-files -. --color=never`, explicit VCS directory exclusions, optional `-g` glob filters, and wrapper-side match limits/truncation/timeouts.
- `rg` keeps the previous JSON-output argv and remains the portable fallback.
- `Glob` has shared backend argv builders and now prefers `rg --files --sort=modified`, then controlled/system `bfs`, then `fd`.
- `bfs` execution intentionally does not add `.gitignore` wrapper filtering, matching observed Claude Code `Glob` behavior. The `fd` fallback remains available and keeps Pi's previous ignore-aware behavior.

## Implementation prompt

Use this prompt for the implementation pass:

```text
You are in ~/Projects/personal/pi-mono-fork.

Goal: evolve Pi's built-in Grep/Glob tools toward Claude Code native-search parity while preserving the bounded-timeout behavior already implemented.

Read first:
- AGENTS.md
- packages/coding-agent/docs/search-tools-parity.md
- packages/coding-agent/src/core/tools/grep.ts
- packages/coding-agent/src/core/tools/glob.ts
- packages/coding-agent/test/tools.test.ts

Constraints:
- Do not overwrite unrelated work. Inspect git status first.
- No dynamic/inline imports.
- Expose the Claude-style public tool names `Grep`/`Glob` for model-facing search.
- Preserve existing happy paths, truncation behavior, limit behavior, AbortSignal behavior, and timeout result shape.
- After code changes run `cd packages/coding-agent && npm run check`.
- If tests are added/modified, run the specific test file until it passes.
- Do not run `npm run dev`, `npm run build`, or full `npm test` unless explicitly asked.

Implementation plan:
1. Introduce a backend abstraction for search commands so Grep/Glob are not hardwired to one executable.
2. Add backend detection helpers:
   - prefer bundled/controlled `ugrep` for grep if available,
   - prefer `rg --files`, then bundled/controlled `bfs`, then `fd` for Glob,
   - fall back to current `rg`/`fd` behavior.
3. For grep with `ugrep`:
   - support content output with line numbers,
   - support files-with-matches/count only if adding schema/API for them is explicitly scoped; otherwise leave current API unchanged,
   - include hidden files,
   - respect ignore files via `--ignore-files`,
   - exclude VCS directories (`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`),
   - apply glob filters safely,
   - keep wrapper-side match limits, byte truncation, long-line truncation, and timeout details.
4. For Glob with `bfs`:
   - map Pi glob patterns safely to `bfs` path/name predicates,
   - include hidden files unless current behavior says otherwise,
   - preserve `.gitignore` semantics. If `bfs` cannot do this cleanly, keep `fd` as the default backend for ignore-aware mode and document why.
   - preserve result limits and byte truncation.
5. Add regression tests covering:
   - backend command argv construction for ugrep and bfs,
   - `.gitignore` behavior,
   - hidden-file behavior,
   - VCS directory exclusion,
   - timeout result details with each backend path,
   - AbortSignal still rejects `Operation aborted`,
   - existing rg/fd fallback behavior remains unchanged.
6. Update docs/changelog with the chosen backend behavior and any known divergence from Claude Code.

Deliverable:
- concise summary of changed files,
- command/test results,
- before/after behavior table,
- any known divergence from Claude Code native behavior.
```
