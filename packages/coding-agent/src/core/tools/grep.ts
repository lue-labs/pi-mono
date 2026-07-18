import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@valkyriweb/pi-agent-core";
import { StringEnum } from "@valkyriweb/pi-ai";
import { Text } from "@valkyriweb/pi-tui";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { ensureTool, getOptionalSearchToolPath, toolDisplayName } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({
		description: "Search pattern (regex or literal string)",
	}),
	path: Type.Optional(
		Type.String({
			description: "Directory or file to search (default: current directory)",
		}),
	),
	glob: Type.Optional(
		Type.String({
			description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
		}),
	),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({
			description: "Treat pattern as literal string instead of regex (default: false)",
		}),
	),
	context: Type.Optional(
		Type.Number({
			description: "Number of lines to show before and after each match (default: 0)",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum number of matches to return (default: 100)",
		}),
	),
	outputMode: Type.Optional(
		StringEnum(["content", "files_with_matches", "count"] as const, {
			description:
				"Output mode: content (matching lines), files_with_matches (file paths), or count (matches per file). Defaults to content for backwards compatibility.",
		}),
	),
	output_mode: Type.Optional(
		StringEnum(["content", "files_with_matches", "count"] as const, {
			description: "Alias for outputMode.",
		}),
	),
	headLimit: Type.Optional(
		Type.Number({
			description: "Maximum output entries after offset; 0 means unlimited",
		}),
	),
	head_limit: Type.Optional(Type.Number({ description: "Alias for headLimit" })),
	offset: Type.Optional(
		Type.Number({
			description: "Number of matching output entries to skip before returning results (default: 0)",
		}),
	),
	type: Type.Optional(
		Type.String({
			description: "Ripgrep file type filter, e.g. js, py, rust. Uses rg backend.",
		}),
	),
	multiline: Type.Optional(
		Type.Boolean({
			description: "Unsupported in Pi native grep until ugrep/rg backend parity is verified",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds (default: 30, max 300)",
			exclusiveMinimum: 0,
			maximum: 300,
		}),
	),
	full: Type.Optional(
		Type.Boolean({
			description:
				"Lift the default 100-match cap and per-line truncation. Large model-facing output is still byte-capped to prevent crashes; use narrower paths/globs when you need exhaustive output. Defaults to false.",
		}),
	),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const VCS_DIRS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

type GrepOutputMode = "content" | "files_with_matches" | "count";
type GrepBackend = "ugrep" | "rg";

interface GrepBackendCommand {
	backend: GrepBackend;
	command: string;
	args: string[];
}

export function buildUgrepArgs(input: {
	pattern: string;
	searchPath: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
}): string[] {
	const args = ["--no-config", "-r", "-n", "--with-filename", "--ignore-files", "-.", "--color=never"];
	for (const vcsDir of VCS_DIRS) args.push("--exclude-dir", vcsDir);
	if (input.ignoreCase) args.push("--ignore-case");
	if (input.literal) args.push("--fixed-strings");
	if (input.glob) args.push("-g", input.glob);
	args.push("--", input.pattern, input.searchPath);
	return args;
}

export function buildRgArgs(input: {
	pattern: string;
	searchPath: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	type?: string;
}): string[] {
	const args = ["--json", "--line-number", "--color=never", "--hidden"];
	for (const vcsDir of VCS_DIRS) args.push("--glob", `!${vcsDir}`);
	if (input.ignoreCase) args.push("--ignore-case");
	if (input.literal) args.push("--fixed-strings");
	if (input.type) args.push("--type", input.type);
	if (input.glob) args.push("--glob", input.glob);
	args.push("--", input.pattern, input.searchPath);
	return args;
}

export async function resolveGrepBackend(input: {
	pattern: string;
	searchPath: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	type?: string;
}): Promise<GrepBackendCommand | undefined> {
	const rgPath = await ensureTool("rg", true);
	if (rgPath) return { backend: "rg", command: rgPath, args: buildRgArgs(input) };

	if (!input.type) {
		const ugrepPath = getOptionalSearchToolPath("ugrep");
		if (ugrepPath)
			return {
				backend: "ugrep",
				command: ugrepPath,
				args: buildUgrepArgs(input),
			};
	}
	return undefined;
}

function parseUgrepMatchLine(line: string): { filePath: string; lineNumber: number; lineText: string } | undefined {
	let firstColon = line.indexOf(":");
	while (firstColon > 0) {
		const secondColon = line.indexOf(":", firstColon + 1);
		if (secondColon <= firstColon + 1) return undefined;
		const lineNumberText = line.slice(firstColon + 1, secondColon);
		if (/^\d+$/.test(lineNumberText)) {
			const lineNumber = Number(lineNumberText);
			if (!Number.isInteger(lineNumber) || lineNumber < 1) return undefined;
			return {
				filePath: line.slice(0, firstColon),
				lineNumber,
				lineText: line.slice(secondColon + 1),
			};
		}
		firstColon = line.indexOf(":", firstColon + 1);
	}
	return undefined;
}

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	timedOut?: boolean;
	timeoutMs?: number;
	path?: string;
	glob?: string;
	pattern?: string;
	matchesReturned?: number;
	mode?: GrepOutputMode;
	numFiles?: number;
	numMatches?: number;
	appliedLimit?: number;
	appliedOffset?: number;
}

function timeoutMsFromSeconds(timeout: number | undefined): number {
	const seconds = typeof timeout === "number" && Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT_SECONDS;
	return Math.min(Math.max(seconds, Number.MIN_VALUE), MAX_TIMEOUT_SECONDS) * 1000;
}

function formatTimeoutSeconds(timeoutMs: number): string {
	const seconds = timeoutMs / 1000;
	return seconds >= 1 ? `${Math.round(seconds)}s` : `${timeoutMs}ms`;
}

function formatGrepTimeoutResult(args: {
	pattern: string;
	path: string;
	glob?: string;
	timeoutMs: number;
	matchesReturned: number;
	partialOutput?: string;
}) {
	const timeout = formatTimeoutSeconds(args.timeoutMs);
	const partial = args.partialOutput?.trim();
	const text = [
		`grep timed out after ${timeout} while searching ${args.path}.`,
		`Retry with a narrower path/glob/pattern, or explicitly raise timeout up to ${MAX_TIMEOUT_SECONDS}s.`,
		partial ? `\nPartial matches returned before timeout:\n${partial}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
	return {
		content: [{ type: "text" as const, text }],
		isError: true,
		details: {
			timedOut: true,
			timeoutMs: args.timeoutMs,
			path: args.path,
			glob: args.glob,
			pattern: args.pattern,
			matchesReturned: args.matchesReturned,
		},
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && /abort/i.test(error.name || error.message);
}

function normalizeGrepOutputOptions(input: {
	outputMode?: GrepOutputMode;
	output_mode?: GrepOutputMode;
	headLimit?: number;
	head_limit?: number;
	offset?: number;
	full?: boolean;
}): { mode: GrepOutputMode; headLimit?: number; offset: number } {
	if (input.outputMode && input.output_mode && input.outputMode !== input.output_mode) {
		throw new Error("outputMode and output_mode differ");
	}
	if (input.headLimit !== undefined && input.head_limit !== undefined && input.headLimit !== input.head_limit) {
		throw new Error("headLimit and head_limit differ");
	}
	const requestedHeadLimit = input.headLimit ?? input.head_limit;
	// full:true returns every match — drop the default output-entry cap unless the
	// caller explicitly paginates (an explicit headLimit/head_limit still wins).
	const unlimited = requestedHeadLimit === 0 || (input.full === true && requestedHeadLimit === undefined);
	return {
		mode: input.outputMode ?? input.output_mode ?? "content",
		headLimit: unlimited ? undefined : Math.max(1, requestedHeadLimit ?? DEFAULT_LIMIT),
		offset: Math.max(0, input.offset ?? 0),
	};
}

function createBoundedGrepOutput(maxBytes: number = DEFAULT_MAX_BYTES) {
	const outputLines: string[] = [];
	let outputBytes = 0;
	let totalBytes = 0;
	let totalLines = 0;
	let truncated = false;
	let firstLineExceedsLimit = false;

	const append = (line: string): boolean => {
		const lineBytes = Buffer.byteLength(line, "utf-8");
		const totalLineBytes = lineBytes + (totalLines > 0 ? 1 : 0);
		totalBytes += totalLineBytes;
		totalLines++;

		if (truncated) return false;

		const outputLineBytes = lineBytes + (outputLines.length > 0 ? 1 : 0);
		if (outputBytes + outputLineBytes > maxBytes) {
			truncated = true;
			firstLineExceedsLimit = outputLines.length === 0;
			return false;
		}

		outputLines.push(line);
		outputBytes += outputLineBytes;
		return true;
	};

	const appendMany = (lines: string[]): boolean => {
		for (const line of lines) {
			if (!append(line)) return false;
		}
		return true;
	};

	const snapshot = (): { content: string; truncation: TruncationResult } => {
		const content = outputLines.join("\n");
		return {
			content,
			truncation: {
				content,
				truncated,
				truncatedBy: truncated ? "bytes" : null,
				totalLines,
				totalBytes,
				outputLines: outputLines.length,
				outputBytes,
				lastLinePartial: false,
				firstLineExceedsLimit,
				maxLines: Number.MAX_SAFE_INTEGER,
				maxBytes,
			},
		};
	};

	return { append, appendMany, snapshot };
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
	toolName?: "grep" | "Grep";
	label?: string;
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

/**
 * Colour a single grep output line.
 * Match lines:   "path:lineno:content"  → accent / syntaxNumber / toolOutput
 * Context lines: "path-lineno-content" → dim
 * Separators:    "--"                   → muted dots
 */
function colorGrepLine(line: string, theme: typeof import("../../modes/interactive/theme/theme.ts").theme): string {
	if (line === "--") return theme.fg("muted", "···");

	// Match line: "file:lineno:content"
	const matchM = line.match(/^(.+?):(\d+):(.*)/);
	if (matchM) {
		const [, file, num, content] = matchM;
		// Try to syntax-highlight the content using the language inferred from file extension.
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
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
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

		// Summary: match count + distinct file count (always shown outside collapse region)
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

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	const toolName = options?.toolName ?? "grep";
	const label = options?.label ?? "Grep";
	return {
		name: toolName,
		label,
		description: `A powerful content-search tool built on ripgrep. ALWAYS use this tool for content search; NEVER invoke \`grep\` or \`rg\` via bash — those calls are blocked at runtime. Supports full regex syntax; ripgrep, not grep — escape literal braces (use \`interface\\{\\}\` to find \`interface{}\`). Filter files with \`glob\` (e.g. "**/*.tsx") or \`type\` (e.g. js, py, rust). \`outputMode\`: "content" (matching lines with file paths and line numbers, default), "files_with_matches" (paths only), "count" (match counts). By default patterns match within single lines; use \`multiline:true\` for cross-line patterns. Respects .gitignore. Times out after ${DEFAULT_TIMEOUT_SECONDS}s by default; pass timeout up to ${MAX_TIMEOUT_SECONDS}s for intentional broad searches. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars unless full:true is set; huge full:true output is still byte-capped to prevent crashes. For conceptual or meaning-based searches ('where is auth handled?', 'how does X work?', 'find the retry logic'), prefer \`semantic_grep\` if available — it finds concepts even when the exact wording differs. Default rule: if you don't already know the exact string, use \`semantic_grep\` first. \`grep\` is for known literals, identifiers, and error messages.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		executionMode: "parallel",
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
				outputMode,
				output_mode,
				headLimit,
				head_limit,
				offset,
				type,
				multiline,
				timeout,
				full,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
				outputMode?: GrepOutputMode;
				output_mode?: GrepOutputMode;
				headLimit?: number;
				head_limit?: number;
				offset?: number;
				type?: string;
				multiline?: boolean;
				timeout?: number;
				full?: boolean;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				let timeoutId: NodeJS.Timeout | undefined;
				let killTimeoutId: NodeJS.Timeout | undefined;
				const timeoutMs = timeoutMsFromSeconds(timeout);
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						if (timeoutId) clearTimeout(timeoutId);
						if (killTimeoutId) clearTimeout(killTimeoutId);
						fn();
					}
				};

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						if (multiline) {
							settle(() =>
								reject(
									new Error(
										"grep multiline is not supported by Pi native grep yet; backend flags are not verified",
									),
								),
							);
							return;
						}
						let outputOptions: {
							mode: GrepOutputMode;
							headLimit?: number;
							offset: number;
						};
						try {
							outputOptions = normalizeGrepOutputOptions({
								outputMode,
								output_mode,
								headLimit,
								head_limit,
								offset,
								full,
							});
						} catch (error) {
							settle(() => reject(error as Error));
							return;
						}
						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = full ? Number.MAX_SAFE_INTEGER : Math.max(1, limit ?? DEFAULT_LIMIT);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						const backendCommand = await resolveGrepBackend({
							pattern,
							searchPath,
							glob,
							ignoreCase,
							literal,
							type,
						});
						if (!backendCommand) {
							settle(() =>
								reject(new Error("Neither ugrep nor ripgrep (rg) is available and rg could not be downloaded")),
							);
							return;
						}

						const child = spawn(backendCommand.command, backendCommand.args, {
							stdio: ["ignore", "pipe", "pipe"],
						});
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let timedOut = false;
						let killedDueToLimit = false;
						const output = createBoundedGrepOutput();

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill("SIGTERM");
								killTimeoutId = setTimeout(() => {
									if (!child.killed) child.kill("SIGKILL");
								}, 5000);
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						if (timeoutMs > 0) {
							timeoutId = setTimeout(() => {
								timedOut = true;
								stopChild();
							}, timeoutMs);
						}
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;
								// Truncate long lines so grep output stays compact.
								const { text: truncatedText, wasTruncated } = full
									? { text: sanitized, wasTruncated: false }
									: truncateLine(sanitized);
								if (wasTruncated) linesTruncated = true;
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							return block;
						};

						// Collect matches during streaming, then format them after rg exits.
						const matches: Array<{
							filePath: string;
							lineNumber: number;
							lineText?: string;
						}> = [];
						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) return;
							if (backendCommand.backend === "ugrep") {
								const match = parseUgrepMatchLine(line);
								if (!match) return;
								matchCount++;
								matches.push(match);
							} else {
								let event: any;
								try {
									event = JSON.parse(line);
								} catch {
									return;
								}
								if (event.type !== "match") return;
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								if (filePath && typeof lineNumber === "number")
									matches.push({ filePath, lineNumber, lineText });
							}
							if (matchCount >= effectiveLimit) {
								matchLimitReached = true;
								stopChild(true);
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() =>
								reject(new Error(`Failed to run ${toolDisplayName(backendCommand.command)}: ${error.message}`)),
							);
						});
						child.on("close", async (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (timedOut) {
								for (const match of matches) {
									if (contextValue === 0 && match.lineText !== undefined) {
										const relativePath = formatPath(match.filePath);
										const sanitized = match.lineText
											.replace(/\r\n/g, "\n")
											.replace(/\r/g, "")
											.replace(/\n$/, "");
										const { text: truncatedText } = full ? { text: sanitized } : truncateLine(sanitized);
										if (!output.append(`${relativePath}:${match.lineNumber}: ${truncatedText}`)) break;
									} else {
										const block = await formatBlock(match.filePath, match.lineNumber);
										if (!output.appendMany(block)) break;
									}
								}
								const partialOutput = output.snapshot().content;
								settle(() =>
									resolve(
										formatGrepTimeoutResult({
											pattern,
											path: searchPath,
											glob,
											timeoutMs,
											matchesReturned: matches.length,
											partialOutput,
										}) as any,
									),
								);
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const backendName = toolDisplayName(backendCommand.command);
								const errorMsg = stderr.trim() || `${backendName} exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								const text =
									outputOptions.mode === "files_with_matches" ? "No files found" : "No matches found";
								settle(() =>
									resolve({
										content: [{ type: "text", text }],
										details: undefined,
									}),
								);
								return;
							}

							const paginate = <T>(
								items: T[],
							): {
								items: T[];
								appliedLimit?: number;
								appliedOffset?: number;
							} => {
								const paged = items.slice(
									outputOptions.offset,
									outputOptions.headLimit === undefined
										? undefined
										: outputOptions.offset + outputOptions.headLimit,
								);
								return {
									items: paged,
									...(outputOptions.headLimit !== undefined &&
									items.length - outputOptions.offset > outputOptions.headLimit
										? { appliedLimit: outputOptions.headLimit }
										: {}),
									...(outputOptions.offset > 0 ? { appliedOffset: outputOptions.offset } : {}),
								};
							};

							const distinctFiles = Array.from(new Set(matches.map((match) => formatPath(match.filePath))));
							if (outputOptions.mode === "files_with_matches") {
								const paged = paginate(distinctFiles);
								const details: GrepToolDetails = {
									mode: outputOptions.mode,
									numFiles: paged.items.length,
									...(paged.appliedLimit !== undefined ? { appliedLimit: paged.appliedLimit } : {}),
									...(paged.appliedOffset !== undefined ? { appliedOffset: paged.appliedOffset } : {}),
								};
								const notice = paged.appliedLimit
									? `\n\n[${paged.appliedLimit} files limit reached. Use offset=${outputOptions.offset + paged.appliedLimit} to continue.]`
									: "";
								settle(() =>
									resolve({
										content: [
											{
												type: "text",
												text: paged.items.length ? `${paged.items.join("\n")}${notice}` : "No files found",
											},
										],
										details,
									}),
								);
								return;
							}

							if (outputOptions.mode === "count") {
								const counts = new Map<string, number>();
								for (const match of matches) {
									const file = formatPath(match.filePath);
									counts.set(file, (counts.get(file) ?? 0) + 1);
								}
								const entries = Array.from(counts.entries());
								const paged = paginate(entries);
								const numMatches = paged.items.reduce((sum, [, count]) => sum + count, 0);
								const details: GrepToolDetails = {
									mode: outputOptions.mode,
									numFiles: paged.items.length,
									numMatches,
									...(paged.appliedLimit !== undefined ? { appliedLimit: paged.appliedLimit } : {}),
									...(paged.appliedOffset !== undefined ? { appliedOffset: paged.appliedOffset } : {}),
								};
								const output = paged.items.map(([file, count]) => `${file}:${count}`).join("\n");
								const notice = paged.appliedLimit
									? `\n\n[${paged.appliedLimit} count entries limit reached. Use offset=${outputOptions.offset + paged.appliedLimit} to continue.]`
									: "";
								settle(() =>
									resolve({
										content: [
											{
												type: "text",
												text: output ? `${output}${notice}` : "No matches found",
											},
										],
										details,
									}),
								);
								return;
							}

							const pagedMatches = paginate(matches);
							// Format matches after streaming finishes so custom readFile() backends can be async.
							for (const match of pagedMatches.items) {
								if (contextValue === 0 && match.lineText !== undefined) {
									const relativePath = formatPath(match.filePath);
									const sanitized = match.lineText
										.replace(/\r\n/g, "\n")
										.replace(/\r/g, "")
										.replace(/\n$/, "");
									const { text: truncatedText, wasTruncated } = full
										? { text: sanitized, wasTruncated: false }
										: truncateLine(sanitized);
									if (wasTruncated) linesTruncated = true;
									if (!output.append(`${relativePath}:${match.lineNumber}: ${truncatedText}`)) break;
								} else {
									const block = await formatBlock(match.filePath, match.lineNumber);
									if (!output.appendMany(block)) break;
								}
							}

							const outputSnapshot = output.snapshot();
							const truncation = outputSnapshot.truncation;
							let outputText = outputSnapshot.content;
							const details: GrepToolDetails = {
								mode: outputOptions.mode,
								matchesReturned: pagedMatches.items.length,
								numFiles: distinctFiles.length,
								...(pagedMatches.appliedLimit !== undefined ? { appliedLimit: pagedMatches.appliedLimit } : {}),
								...(pagedMatches.appliedOffset !== undefined
									? { appliedOffset: pagedMatches.appliedOffset }
									: {}),
							};
							// Build actionable notices for truncation and match limits.
							const notices: string[] = [];
							if (pagedMatches.appliedLimit !== undefined) {
								notices.push(
									`${pagedMatches.appliedLimit} output entries limit reached. Use offset=${outputOptions.offset + pagedMatches.appliedLimit} to continue`,
								);
							}
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) outputText += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: outputText }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						if (signal?.aborted || isAbortError(err)) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme, label));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
