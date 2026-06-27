# Claude Code 2.1.144 tool parity opportunities

This note turns the Claude Code 2.1.144 changelog into Pi follow-up work, with extra reverse-engineering from the local Claude Code CLI source at:

- `/Users/luke/Projects/oss/claude-code-cli-src-code/src_extracted/src/tools/GrepTool/GrepTool.ts`
- `/Users/luke/Projects/oss/claude-code-cli-src-code/src_extracted/src/tools/GrepTool/prompt.ts`
- `/Users/luke/Projects/oss/claude-code-cli-src-code/src_extracted/src/tools/FileEditTool/FileEditTool.ts`
- `/Users/luke/Projects/oss/claude-code-cli-src-code/src_extracted/src/tools/FileEditTool/utils.ts`
- `/Users/luke/Projects/oss/claude-code-cli-src-code/src_extracted/src/tools/FileReadTool/FileReadTool.ts`
- `/Users/luke/Projects/oss/claude-code-cli-src-code/src_extracted/src/tools/BashTool/commandSemantics.ts`

Related Pi baseline:

- `packages/coding-agent/docs/search-tools-parity.md`
- `packages/coding-agent/src/core/tools/grep.ts`
- `packages/coding-agent/src/core/tools/glob.ts`
- `packages/coding-agent/src/core/tools/edit.ts`
- `packages/coding-agent/src/core/tools/edit-diff.ts`
- `packages/coding-agent/src/core/tools/read.ts`

## Release signal

Claude Code 2.1.144 shipped 52 CLI changes. The tool-relevant highlights for Pi are:

1. Edit uses exact string replacements to avoid unintended partial matches.
2. System searches use the Grep tool for consistent file-based, reproducible search behavior.
3. Bash search-ish commands treat “no matches” as a non-error for `egrep`, `fgrep`, `git grep`, and `git diff`, not just `grep`/`rg`.
4. Head/tail file views satisfy read-before-edit.
5. Image reads whose extension does not match contents fall back to text instead of breaking the conversation.
6. MCP paginated `tools/list` is fully consumed.
7. Unsupported MCP image MIME types are saved to disk and referenced in the tool result.
8. Non-`.md` files under skill directories no longer trigger skill reloads.
9. Background task/session UX got many reliability fixes: resume, duration notifications, timeouts, Ctrl+C, stale process state, etc.

## What Pi already has

### Agent/Task parity slice

Pi now has the native uppercase `Agent` tool alongside existing lowercase `agent` and legacy `Task`, all backed by the same executor. It also supports Claude-style aliases:

- `prompt` -> `task`
- `subagent_type` -> `agent`
- `run_in_background` -> `background`

Alias conflicts reject clearly, and built-in casing aliases like `Explore`/`Plan` resolve to `explore`/`plan` only after preserving exact IDs first.

### Search backend parity

`packages/coding-agent/docs/search-tools-parity.md` already captures earlier Claude native-search work. Current Pi `Grep`/`Glob` already moved in the right direction:

- `grep` prefers `ugrep`, falls back to `rg`.
- `grep` uses wrapper-side limits, truncation, and timeouts.
- `Grep` includes hidden files, respects ignore files via `--ignore-files`, and excludes VCS dirs.
- `Glob` prefers `rg --files --sort=modified`, then `bfs`, then `fd`.
- `Glob` excludes VCS dirs and applies limits/timeouts.

## Reverse-engineered Claude tool behavior

### Claude `Grep` tool shape

Claude’s `Grep` is richer than Pi’s current `grep` schema:

- `pattern`: regex pattern.
- `path`: file/dir path.
- `glob`: glob filter, split into multiple `--glob` args.
- `type`: ripgrep file type (`js`, `py`, `rust`, etc.).
- `output_mode`: `content`, `files_with_matches`, or `count`; default is `files_with_matches`.
- `-B`, `-A`, `-C`, `context`: context lines for `content` mode.
- `-n`: line numbers for `content` mode; default true.
- `-i`: case-insensitive search.
- `head_limit`: default 250; `0` means unlimited.
- `offset`: pagination offset.
- `multiline`: adds `-U --multiline-dotall`.

Execution details:

- Always uses `--hidden`.
- Excludes `.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl` via negative globs.
- Adds `--max-columns 500` to avoid noisy minified/base64 lines.
- Protects flag-like patterns with `-e` when the pattern starts with `-`.
- Adds permission ignore patterns as negative `--glob`s.
- Sorts `files_with_matches` by mtime, then filename, before applying limit/offset.
- Relativizes paths before returning results to save tokens.
- Returns structured result metadata: `mode`, `numFiles`, `filenames`, `content`, `numLines`, `numMatches`, `appliedLimit`, `appliedOffset`.

### Claude `Edit` tool behavior

Claude’s current edit path is single replacement per call (`old_string`, `new_string`, `replace_all`), but it has strict guards:

- Requires prior file read before edit.
- Rejects stale edits if the file changed since read.
- Rejects non-unique `old_string` unless `replace_all` is true.
- Uses exact string replacement first.
- Allows quote-normalized match as a fallback and preserves curly quote style in replacement.
- Refuses notebook edits via normal edit tool.
- Has a 1 GiB max file size guard.
- Updates file read state after write.
- Notifies LSP/VS Code hooks after edit.

Pi’s current `edit` is already stricter in several ways:

- Public schema is multi-edit exact replacements: `edits[].oldText/newText`.
- Each `oldText` must match uniquely.
- Multi-edit overlaps are rejected.
- CRLF/BOM handling is preserved.
- It supports legacy `oldText/newText` by preparing them into `edits`.

Potential gap: Pi’s `edit-diff.ts` still has fuzzy matching support. That can be useful, but Claude 2.1.144’s headline says exact string replacements. If Pi wants the same predictability, fuzzy matching should be removed, disabled by default, or made explicit.

### Claude Bash command semantics

Claude has command-specific exit semantics in `BashTool/commandSemantics.ts`:

- `grep` and `rg`: exit code `1` means no matches, not an error; `>=2` is error.
- `find`: exit `1` is partial/inaccessible dirs; `>=2` is error.
- `diff`: exit `1` means files differ, not an error; `>=2` is error.
- `test` / `[`: exit `1` means false, not an error.

The 2.1.144 changelog extends this idea to `egrep`, `fgrep`, `git grep`, and `git diff`.

Pi’s current system guidance blocks `grep`/`rg`/`find`/`ls` through `bash`, which is good. But when users or agents still run shell commands, Pi can reduce false tool errors by adding the same semantic layer to `bash` result classification.

### Claude read/image handling

Claude’s `FileReadTool` detects content from bytes, not just extension. Changelog 2.1.144 says mismatched image extensions now fall back to text. Pi’s `read` calls `detectSupportedImageMimeTypeFromFile`; if that function sniffs bytes correctly, Pi may already be safe. Verify with a regression:

- Write HTML/text to `fake.png`.
- Read it.
- Expected: text output, not image decode failure.

Also consider unsupported image MIME handling: Claude saves unsupported MCP images to disk and returns a file reference instead of breaking the conversation.

## Recommended Pi backlog

### P0 — search/schema parity that likely improves agent behavior immediately

1. Add `grep` output modes.
   - `outputMode?: "content" | "files_with_matches" | "count"`
   - Keep current line-content behavior as default if backwards compatibility matters, or explicitly decide whether to follow Claude’s default `files_with_matches`.
   - Add `headLimit` and `offset` for pagination.
   - Return structured details: mode, files, lines, matches, appliedLimit, appliedOffset.

2. Add `grep` file type and multiline support.
   - `type?: string` maps to backend file-type filtering where available.
   - `multiline?: boolean` maps to `rg -U --multiline-dotall`; for `ugrep`, verify equivalent flags before implementing.

3. Add mtime sorting for files-with-matches.
   - Claude sorts by last modified time to prioritize recently touched files.
   - This is useful for large repos and reduces model drift toward stale results.

4. Add flag-like pattern regression for both backends.
   - Pi already has a test for injection-ish patterns in `grep`.
   - Keep/extend it for `ugrep` and `rg` builders.

### P1 — exact edit semantics audit

1. Decide whether fuzzy edit matching stays.
   - Current Pi descriptions promise exact replacements.
   - `edit-diff.ts` still supports fuzzy matching.
   - Best direction: exact by default; if fuzzy matching is kept, expose it as an explicit opt-in or only use it for a separate repair flow.

2. Add tests matching Claude’s headline.
   - Partial match must not edit.
   - Multiple exact matches must reject unless a future `replaceAll` is introduced.
   - Near/fuzzy quote/dash/whitespace match should reject if exact-only mode is chosen.

3. Consider read-before-edit semantics for partial reads.
   - Claude 2.1.144 says head/tail file views now satisfy read-before-edit.
   - Pi’s edit currently does not appear to require prior read, so this specific guard may not apply.
   - If Pi adds read-before-edit later, partial views should be accepted when the replacement target is within the read range or when the edit carries exact enough context.

### P1 — Bash false-error reduction

Add command semantics for common search/diff commands in Pi `bash`:

- `grep`, `egrep`, `fgrep`, `rg`, `git grep`: no matches is not an error.
- `diff`, `git diff`: differences are not an error.
- `test`, `[`: false is not an error.
- `find`: partial inaccessible dirs can be a warning, not a hard error.

Caveat: Pi blocks direct `grep`/`rg`/`find`/`ls` bash calls in system guidance/tool wrappers, so this is mostly for user shell commands and unavoidable scripts.

### P1 — read/image robustness

1. Add mismatched extension regression:
   - `fake.png` containing text/HTML returns text.
   - Real image with no/incorrect extension still returns image if sniffing detects supported MIME.

2. Add unsupported image MIME fallback:
   - If image bytes are detected but model/tool output cannot inline them, save to a temp/artifact path and return a text reference.

### P2 — MCP reliability

1. Audit MCP `tools/list` pagination.
   - Claude fixed silently dropping paginated MCP tools.
   - Pi should verify it follows `nextCursor` until exhausted.

2. Audit MCP image tool results.
   - Unsupported MIME should not break the conversation.
   - Save artifact + return path/reference.

### P2 — skill reload hygiene

Claude fixed file descriptor exhaustion from builds under skill directories by ignoring non-`.md` files for skill reloads. Pi should verify:

- Skill watchers only react to relevant files.
- Build artifacts, package installs, images, and generated files under skill dirs do not trigger reload storms.

### P2 — background/session polish

Claude 2.1.144 includes many background session fixes worth comparing against Pi:

- `/resume` includes background sessions and labels them.
- Completion notifications include elapsed duration.
- Background service operations have explicit timeouts and recovery hints.
- Background shell tasks spawned by subagents stop showing “running” after process exit.
- Ctrl+C interrupts attached shell commands.
- Detached sessions preserve added directories.

Pi already has background agent notifications and status controls. The next useful pass is a small parity matrix against `LocalAgentTask`, session resume, and `bash` background job lifecycle.

## Suggested implementation slices

### Slice B: richer `grep` output modes

Files:

- `packages/coding-agent/src/core/tools/grep.ts`
- `packages/coding-agent/test/tools.test.ts`
- `packages/coding-agent/docs/search-tools-parity.md`

Deliverables:

- Add `outputMode`, `headLimit`, `offset`, `type`, `multiline` if backend support is clear.
- Preserve old API aliases: `limit` remains supported as current maximum matches for content mode.
- Tests for content/files/count modes, pagination, no matches, flag-like patterns, VCS exclusions.

### Slice C: edit exactness audit

Files:

- `packages/coding-agent/src/core/tools/edit-diff.ts`
- `packages/coding-agent/src/core/tools/edit.ts`
- edit tests

Deliverables:

- Make actual behavior match the public “exact text” contract.
- Either remove fuzzy matching or gate it behind an explicit option not shown to default agents.
- Add regression tests for partial/fuzzy/non-unique replacements.

### Slice D: shell command semantics

Files:

- `packages/coding-agent/src/core/tools/bash.ts`
- bash tests

Deliverables:

- Interpret no-match/diff/false-condition exit statuses as non-error where appropriate.
- Include clear summaries without marking the tool call failed.

### Slice E: read/MCP robustness

Files:

- `packages/coding-agent/src/core/tools/read.ts`
- MIME utilities
- MCP client/tool-result handling

Deliverables:

- Mismatched image extension falls back to text.
- Unsupported image MIME saves to disk + returns reference.
- MCP `tools/list` pagination is exhausted.

## Strong recommendation

Do **Slice B first**. Claude’s biggest practical tool advantage here is not the backend binary; Pi already has `ugrep`/`bfs` work. The gap is result shape: Claude’s `Grep` gives agents cheap file-list, count, content, pagination, type filters, and multiline mode through one reproducible tool. That should reduce Bash misuse and improve search loops immediately.
