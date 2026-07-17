/**
 * Guideline strings shared between the default system prompt (system-prompt.ts)
 * and tool promptGuidelines (bash.ts). addGuideline() deduplicates by exact
 * string match, so shared rules MUST be byte-identical — import these constants
 * instead of restating the text. (Scar: the two copies drifted once, and every
 * session prompt carried both near-duplicate bullets.)
 */

export const GUIDELINE_NATIVE_FILE_TOOLS =
	"File exploration uses native tools, not bash: Read = file contents (replaces cat/head/tail/sed on files); Grep = content search (known strings/regex); Glob = file discovery by glob; SemanticGrep = conceptual search. Avoid running `grep`/`rg`/`find` in Bash for repo exploration unless explicitly instructed or a dedicated tool cannot accomplish the task; pipeline filters on command output (e.g. `kubectl get pods | grep Ready`) are fine. Directory listing via Bash `ls` is fine.";

export const GUIDELINE_BASH_SHELL_WORK =
	"Use Bash for shell work and non-repo command output: `kubectl ... | jq`, `ps ... | awk`, git, package managers, `stat`/`wc`/`head`/`tail`.";

export const GUIDELINE_READ_EDIT_WRITE =
	"Use Read/Edit/Write for files instead of shelling out to view or modify file contents.";
