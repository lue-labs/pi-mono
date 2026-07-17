// Bash command guards (fork-owned; extracted verbatim from tools/bash.ts):
// read-only child-agent policy, native-tool steering guard, redundant-cd guard,
// and semantic exit-code classification. Opinionated fork behavior — tier-3
// follow-up is moving the policy/guard opinions into a my-pi extension once the
// beforeToolCall deny surface carries enough context.

import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ---------- Bash policy (read-only child agents) ----------
//
// Per-invocation policy enforcing a deny-list against bash commands executed
// inside a specific child agent (currently: `explore`). Set via
// `runWithBashPolicy()` around `session.prompt(...)` in the agents executor;
// read at the top of bash `execute`. AsyncLocalStorage keeps the policy bound
// to the child's async context without plumbing options through session
// factories.
//
// Soft guard, not a sandbox: rejects commands whose first 1-3 tokens of any
// pipeline/sequence segment match a deny pattern, and rejects unquoted
// `>` / `>>` / `tee` / `sponge` when `denyWrites` is set. Will not catch every
// adversarial construction (eval, $(), backticks, here-docs).
export interface BashPolicy {
	/** Human-readable label used in error messages. */
	label: string;
	/** Command-name patterns to reject (case-sensitive, word-boundary match). Multi-word entries (e.g. "git push") match consecutive tokens. */
	denyCommands: string[];
	/** When true, reject unquoted output redirection (`>`, `>>`, `tee`, `| sponge`). */
	denyWrites?: boolean;
}

const bashPolicyStore = new AsyncLocalStorage<BashPolicy>();

/** Run `fn` with `policy` bound to the current async context. */
export function runWithBashPolicy<T>(policy: BashPolicy, fn: () => Promise<T>): Promise<T> {
	return bashPolicyStore.run(policy, fn);
}

/** Read the policy bound to the current async context, if any. */
export function currentBashPolicy(): BashPolicy | undefined {
	return bashPolicyStore.getStore();
}

/** Deny list applied to the `explore` agent: no mutations, no writes, no network sends. */
export const EXPLORE_BASH_POLICY: BashPolicy = {
	label: "explore (read-only)",
	denyWrites: true,
	denyCommands: [
		"rm",
		"mv",
		"cp",
		"mkdir",
		"rmdir",
		"touch",
		"chmod",
		"chown",
		"ln",
		"sed -i",
		"perl -i",
		"awk -i",
		"git add",
		"git commit",
		"git push",
		"git pull",
		"git fetch",
		"git checkout",
		"git switch",
		"git reset",
		"git restore",
		"git stash",
		"git merge",
		"git rebase",
		"git cherry-pick",
		"git tag",
		"git branch",
		"git worktree",
		"gh pr create",
		"gh pr edit",
		"gh pr close",
		"gh pr merge",
		"gh issue create",
		"gh issue edit",
		"gh issue close",
		"gh issue comment",
		"gh release",
		"gh repo create",
		"gh repo delete",
		"npm install",
		"npm i",
		"npm run",
		"npm publish",
		"pnpm install",
		"pnpm add",
		"yarn install",
		"yarn add",
		"pip install",
		"pipx install",
		"brew install",
		"cargo install",
		"go install",
		"kill",
		"pkill",
		"killall",
		"systemctl",
		"launchctl",
		"docker run",
		"docker exec",
		"kubectl apply",
		"kubectl delete",
		"kubectl create",
		"kubectl edit",
		"kubectl patch",
		"scp",
		"rsync",
		"eval",
		"exec",
		"source",
	],
};

/** Tokenize the command into pipeline/sequence segments. */
function splitBashSegments(command: string): string[] {
	return command
		.split(/(?:;|&&|\|\|?|\n)/g)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** First three whitespace-separated tokens of a segment (covers "git push" style). */
function firstTokens(segment: string): string {
	const trimmed = segment.replace(/^[!\s]+/, "").trim();
	return trimmed.split(/\s+/).slice(0, 3).join(" ");
}

/**
 * Strip single-quoted spans from a string. Single quotes in POSIX shell are
 * literal (no escapes, no interpolation), so anything inside `'...'` cannot
 * be a backtick / `$()` / here-doc operator we care about. Removing them
 * eliminates false positives like `grep '\$(' file`.
 */
function stripSingleQuoted(s: string): string {
	return s.replace(/'[^']*'/g, "''");
}

/**
 * Detect unsafe shell constructs that the simple token scanner can't reason
 * about: command substitution (`$(...)`, backticks), here-docs (`<<WORD`,
 * `<<-WORD`, `<<<` is fine — it's a here-string of literal data), and `eval`/
 * arithmetic substitution `$((...))` which can shell out via nested `$()`.
 * Returns a reason string when found, else undefined.
 */
function detectUnsafeConstructs(command: string): string | undefined {
	const stripped = stripSingleQuoted(command);
	if (/\$\(/.test(stripped))
		return "command substitution `$(...)` is not permitted — inline the inner command directly";
	if (/(^|[^\\])`/.test(stripped))
		return "backtick command substitution is not permitted — inline the inner command directly";
	if (/[<>]\(/.test(stripped))
		return "process substitution `<(...)` / `>(...)` is not permitted — it runs an arbitrary command; inline the data instead";
	if (/<<-?\s*['"]?\w+/.test(stripped)) return "here-doc (`<<WORD`) is not permitted — pass arguments inline instead";
	return undefined;
}

/**
 * Check `command` against `policy`. Returns a human-readable reason if denied,
 * else undefined.
 *
 * Pipeline:
 *   1. Detect command substitution, backticks, here-docs — reject outright.
 *      These constructs let the model smuggle arbitrary commands past the
 *      segment scanner. A read-only explore agent never needs them.
 *   2. Split into pipeline/sequence segments.
 *   3. Multi-word patterns (e.g. "git push") match the first 1–3 tokens of
 *      each segment.
 *   4. Single-word patterns (e.g. "rm") match ANY token in any segment —
 *      catches `find ... | xargs rm` style chained-mutation bypasses.
 *   5. When `denyWrites` is set, reject unquoted `>` / `>>` / `tee` / `sponge`.
 */
export function checkBashPolicy(command: string, policy: BashPolicy): string | undefined {
	const unsafe = detectUnsafeConstructs(command);
	if (unsafe) {
		return `bash policy [${policy.label}] denied: ${unsafe} (command: ${command.slice(0, 80)}). Report what you need in Open Questions instead.`;
	}
	const singleWordDeny = policy.denyCommands.filter((p) => !p.includes(" "));
	const multiWordDeny = policy.denyCommands.filter((p) => p.includes(" "));
	const segments = splitBashSegments(command);
	for (const segment of segments) {
		const head = firstTokens(segment);
		for (const pattern of multiWordDeny) {
			if (head === pattern || head.startsWith(`${pattern} `)) {
				return `bash policy [${policy.label}] denied: "${pattern}" is not permitted (segment: ${segment.slice(0, 80)}). Report what you need in Open Questions instead.`;
			}
		}
		const tokens = segment.split(/\s+/);
		for (const token of tokens) {
			if (singleWordDeny.includes(token)) {
				return `bash policy [${policy.label}] denied: "${token}" is not permitted (segment: ${segment.slice(0, 80)}). Report what you need in Open Questions instead.`;
			}
		}
		if (policy.denyWrites) {
			if (/(^|[^&\d])>>?(?![&])/.test(segment) || /\btee\b/.test(segment) || /\bsponge\b/.test(segment)) {
				return `bash policy [${policy.label}] denied: output redirection / tee is not permitted (segment: ${segment.slice(0, 80)}).`;
			}
		}
	}
	return undefined;
}

const COMMAND_SEMANTIC_EXIT_STATUS = 1;

export type BashSemanticExit = {
	command: string;
	exitCode: number;
	summary: string;
};

function shellTokensForSimpleCommand(command: string): string[] | undefined {
	const tokens: string[] = [];
	let token = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;

	for (const char of command.trim()) {
		if (escaped) {
			token += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else token += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "\n" || char === "(" || char === ")") {
			return undefined;
		}
		if (/\s/.test(char)) {
			if (token) {
				tokens.push(token);
				token = "";
			}
			continue;
		}
		token += char;
	}
	if (escaped || quote) return undefined;
	if (token) tokens.push(token);
	return tokens.length > 0 ? tokens : undefined;
}

function isShellAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function skipGitGlobalOption(tokens: string[], index: number): number {
	const token = tokens[index];
	if (!token?.startsWith("-")) return index;
	if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(token)) return index + 2;
	if (
		token.startsWith("-C") ||
		token.startsWith("-c") ||
		token.startsWith("--git-dir=") ||
		token.startsWith("--work-tree=") ||
		token.startsWith("--namespace=")
	) {
		return index + 1;
	}
	return index + 1;
}

function commandNameForExitSemantics(command: string): string | undefined {
	const tokens = shellTokensForSimpleCommand(command);
	if (!tokens) return undefined;
	let index = 0;
	while (isShellAssignment(tokens[index] ?? "")) index++;
	if (tokens[index] === "command" || tokens[index] === "builtin") index++;
	if (tokens[index] === "env") {
		index++;
		while (isShellAssignment(tokens[index] ?? "")) index++;
	}
	const commandName = tokens[index];
	if (!commandName) return undefined;
	if (commandName !== "git") return commandName;

	index++;
	while (index < tokens.length && tokens[index]?.startsWith("-")) {
		const nextIndex = skipGitGlobalOption(tokens, index);
		if (nextIndex <= index) break;
		index = nextIndex;
	}
	const gitSubcommand = tokens[index];
	if (gitSubcommand === "grep" || gitSubcommand === "diff") return `git ${gitSubcommand}`;
	return commandName;
}

export function semanticExitForBashCommand(command: string, exitCode: number | null): BashSemanticExit | undefined {
	if (exitCode !== COMMAND_SEMANTIC_EXIT_STATUS) return undefined;
	const commandName = commandNameForExitSemantics(command);
	switch (commandName) {
		case "grep":
		case "egrep":
		case "fgrep":
		case "rg":
		case "git grep":
			return { command: commandName, exitCode, summary: `${commandName} found no matches` };
		case "diff":
		case "git diff":
			return { command: commandName, exitCode, summary: `${commandName} found differences` };
		case "test":
		case "[":
			return { command: commandName, exitCode, summary: `${commandName} condition was false` };
		case "find":
			return {
				command: commandName,
				exitCode,
				summary: "find completed with partial results or inaccessible paths",
			};
		default:
			return undefined;
	}
}

function unquoteShellPath(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value.replace(/\\ /g, " ");
}

export function redundantCdToCurrentWorkingDirectory(command: string, cwd: string): boolean {
	const match = /^\s*cd\s+((?:"[^"]+"|'[^']+'|\\\S+|\S)+)\s*(?:&&|;)\s*\S/s.exec(command);
	if (!match) return false;
	let target = unquoteShellPath(match[1]!);
	if (target === "~" || target.startsWith("~/")) target = join(homedir(), target.slice(2));
	return resolve(cwd, target) === resolve(cwd);
}

export function redundantCdError(): string {
	return "Blocked redundant cd: bash already runs in the current working directory. Run the command without `cd <cwd> && ...`, or use command-native flags like `git -C <dir>` / `npm --prefix <dir>` for another directory.";
}
