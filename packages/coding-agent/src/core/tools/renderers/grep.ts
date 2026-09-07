/**
 * Presentation for the grep tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `grep.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@lue-labs/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { GrepToolDetails } from "../grep.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

/**
 * Colour a single grep output line.
 * Match lines:   "path:lineno:content"  -> accent / syntaxNumber / toolOutput
 * Context lines: "path-lineno-content"  -> dim
 * Separators:    "--"                   -> muted dots
 */
function colorGrepLine(line: string, theme: Theme): string {
	if (line === "--") return theme.fg("muted", "\u00b7\u00b7\u00b7");

	// Match line: "file:lineno:content"
	const matchM = line.match(/^(.+?):(\d+):(.*)/);
	if (matchM) {
		const [, file, num, content] = matchM;
		// Single-line highlight is best-effort; fall back to toolOutput on unknown lang.
		const lang = getLanguageFromPath(file);
		const leading = content.match(/^(\s*)/)?.[1] ?? "";
		const trimmed = content.trimStart();
		const highlightedContent =
			lang && trimmed
				? leading + (highlightCode(trimmed, lang)[0] ?? theme.fg("toolOutput", trimmed))
				: theme.fg("toolOutput", content);
		return (
			theme.fg("accent", file) +
			theme.fg("muted", ":") +
			theme.fg("syntaxNumber", num) +
			theme.fg("muted", ":") +
			highlightedContent
		);
	}

	// Context line: "file-lineno-content"
	if (line.match(/^(.+?)-(\d+)-(.*)/)) return theme.fg("dim", line);

	return theme.fg("toolOutput", line);
}
function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: Theme,
	label: string,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold(label)) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}
function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => colorGrepLine(line, theme)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}

		// Summary: match count + distinct file count (always shown outside the collapse region)
		const matchLines = lines.filter((l) => /^.+?:\d+:/.test(l));
		const fileCount = new Set(matchLines.map((l) => l.match(/^(.+?):\d+:/)?.[1]).filter(Boolean)).size;
		if (matchLines.length > 0) {
			const filePart = fileCount > 1 ? ` across ${fileCount} files` : fileCount === 1 ? " in 1 file" : "";
			text += `\n${theme.fg("dim", `${matchLines.length} match${matchLines.length === 1 ? "" : "es"}${filePart}`)}`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export type GrepRenderers = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;

/** The grep tool is registered under more than one label, so the rendered title follows the definition. */
export function createGrepRenderers(label = "Grep"): GrepRenderers {
	return {
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args as any, theme, label));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export const grepRenderers: GrepRenderers = createGrepRenderers();
