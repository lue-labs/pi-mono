// Embedded script detection for bash-call rendering (fork-owned; extracted
// verbatim from tools/bash.ts). Display-only: splits a command into segments so
// inline `python3 -c "..."` / heredoc scripts highlight in their own language.

export interface CommandSegment {
	text: string;
	lang: string;
}

/** Interpreter flag patterns that introduce an inline script argument. */
const INLINE_SCRIPT_FLAGS: Array<{ pattern: RegExp; lang: string }> = [
	{ pattern: /\b(?:python3?|pypy3?)\s+-[Bc]\s/, lang: "python" },
	{ pattern: /\b(?:node|nodejs)\s+(?:-e|-p|--eval)\s/, lang: "javascript" },
	{ pattern: /\bruby\s+-e\s/, lang: "ruby" },
	{ pattern: /\bperl\s+-[eE]\s/, lang: "perl" },
	{ pattern: /\bphp\s+(?:-r|-R)\s/, lang: "php" },
];

/**
 * Extract a quoted string starting at `startIdx` (which points at the opening quote).
 * Returns the unescaped content and the index just past the closing quote, or null if
 * the string is unterminated.
 */
function extractQuotedString(cmd: string, startIdx: number): { content: string; endIdx: number } | null {
	const quote = cmd[startIdx];
	if (quote !== '"' && quote !== "'") return null;
	let i = startIdx + 1;
	let content = "";
	while (i < cmd.length) {
		if (quote === '"' && cmd[i] === "\\" && i + 1 < cmd.length) {
			content += cmd[i + 1];
			i += 2;
		} else if (cmd[i] === quote) {
			return { content, endIdx: i + 1 };
		} else {
			content += cmd[i];
			i++;
		}
	}
	return null; // unterminated
}

/**
 * Try to detect a heredoc embedded script in `cmd`.
 * Handles both quoted (`<< 'EOF'`) and unquoted (`<< EOF`) delimiters.
 * Returns segments or null if no heredoc found.
 */
function detectHeredoc(cmd: string): CommandSegment[] | null {
	const heredocRe = /<<-?\s*['"]?([A-Z_][A-Z_0-9]*)['"]?\n/;
	const match = heredocRe.exec(cmd);
	if (!match) return null;
	const delimiter = match[1]!;
	const codeStart = match.index + match[0].length;
	const closingPattern = new RegExp(`(?:^|\n)${delimiter}s*(?:\n|$)`);
	const closeMatch = closingPattern.exec(cmd.slice(codeStart));
	if (!closeMatch) return null;

	// Determine language from the command preceding the heredoc marker
	const prefix = cmd.slice(0, match.index);
	let lang = "bash";
	for (const { pattern, lang: l } of INLINE_SCRIPT_FLAGS) {
		if (pattern.test(`${prefix} x`)) {
			lang = l;
			break;
		}
	}

	const codeEnd = codeStart + closeMatch.index + (closeMatch[0].startsWith("\n") ? 1 : 0);
	return [
		{ text: cmd.slice(0, codeStart), lang: "bash" },
		{ text: cmd.slice(codeStart, codeEnd), lang },
		{ text: cmd.slice(codeEnd), lang: "bash" },
	];
}

/**
 * Split a bash command into segments for per-language syntax highlighting.
 * Detects patterns like `python3 -c "..."` and heredocs.
 * Falls back to a single bash segment if no embedded script is found.
 */
export function segmentCommand(command: string): CommandSegment[] {
	// Try heredoc first (it uses a different delimiter style)
	const heredocSegments = detectHeredoc(command);
	if (heredocSegments) return heredocSegments;

	// Try inline -c/-e flag patterns
	for (const { pattern, lang } of INLINE_SCRIPT_FLAGS) {
		const match = pattern.exec(command);
		if (!match) continue;

		const flagEnd = match.index + match[0].length;

		// Skip optional line-continuation whitespace between the flag and the quote
		let quoteStart = flagEnd;
		while (quoteStart < command.length && /[\s\\]/.test(command[quoteStart]!)) {
			quoteStart++;
		}

		const quoteChar = command[quoteStart];
		if (quoteChar !== '"' && quoteChar !== "'") continue;

		const extracted = extractQuotedString(command, quoteStart);
		if (!extracted) continue;

		// Include the opening and closing quotes in the surrounding bash segments so
		// highlight.js sees balanced (or intentionally partial) quoting.
		return [
			{ text: command.slice(0, quoteStart + 1), lang: "bash" },
			{ text: extracted.content, lang },
			{ text: command.slice(extracted.endIdx - 1), lang: "bash" },
		];
	}

	return [{ text: command, lang: "bash" }];
}
