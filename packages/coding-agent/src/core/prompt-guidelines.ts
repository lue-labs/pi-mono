/**
 * Guideline strings shared between the default system prompt (system-prompt.ts)
 * and tool promptGuidelines (bash.ts). addGuideline() deduplicates by exact
 * string match, so shared rules MUST be byte-identical — import these constants
 * instead of restating the text. (Scar: the two copies drifted once, and every
 * session prompt carried both near-duplicate bullets.)
 */

export const GUIDELINE_NATIVE_FILE_TOOLS =
	"File/dir exploration uses native tools, never bash: Read = file contents (replaces cat/head/tail/sed on files); Ls = directory listing; Grep = content search (known strings/regex); Glob = file discovery by glob; SemanticGrep = conceptual search. Bash calls containing `ls`/`grep`/`rg`/`find` are rejected in full — split into separate native-tool calls, do not combine with other shell work in one bash invocation.";

export const GUIDELINE_BASH_SHELL_WORK =
	"Use Bash for shell work and non-repo command output: `kubectl ... | jq`, `ps ... | awk`, git, package managers, `stat`/`wc`/`head`/`tail`.";

export const GUIDELINE_READ_EDIT_WRITE =
	"Use Read/Edit/Write for files instead of shelling out to view or modify file contents.";
