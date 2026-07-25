import { statSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AgentTool } from "@valkyriweb/pi-agent-core";
import { Text } from "@valkyriweb/pi-tui";
import { spawn } from "child_process";
import { minimatch } from "minimatch";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { ensureTool, getOptionalSearchToolPath, toolDisplayName } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, FULL_TRUNCATION, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

const globSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
	ignore: Type.Optional(
		Type.Boolean({
			description:
				"Respect .gitignore and similar ignore files (default: true). Set false to include ignored files.",
		}),
	),
	outputMode: Type.Optional(
		Type.Union([Type.Literal("paths"), Type.Literal("count")], {
			description: "Output mode: paths (default) or count (number of matching paths).",
		}),
	),
	output_mode: Type.Optional(
		Type.Union([Type.Literal("paths"), Type.Literal("count")], { description: "Alias for outputMode." }),
	),
	offset: Type.Optional(
		Type.Number({ description: "Number of matching paths to skip before returning results (default: 0)" }),
	),
	sort: Type.Optional(
		Type.Union([Type.Literal("name"), Type.Literal("modified"), Type.Literal("none")], {
			description:
				"Sort results by name, by modified time (newest first), or leave backend order unchanged (default: none \u2014 rg backend already returns modified-time order).",
		}),
	),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (default: 30, max 300)", exclusiveMinimum: 0, maximum: 300 }),
	),
	full: Type.Optional(
		Type.Boolean({
			description:
				"Return ALL results with no result-count/byte truncation (and skip tokenjuice compaction). Use only when you genuinely need every match. Defaults to false.",
		}),
	),
});

export type GlobToolInput = Static<typeof globSchema>;

const DEFAULT_LIMIT = 1000;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const VCS_DIRS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

type GlobBackend = "rg" | "bfs" | "fd";
type GlobOutputMode = "paths" | "count";
type GlobSort = "name" | "modified" | "none";

interface GlobBackendCommand {
	backend: GlobBackend;
	command: string;
	args: string[];
}

export function buildBfsArgs(input: { pattern: string; searchPath: string; limit: number }): string[] {
	const args = [input.searchPath, "-s"];
	for (const vcsDir of VCS_DIRS) args.push("-exclude", "-name", vcsDir);
	args.push("-type", "f");
	if (input.pattern.includes("/")) {
		const normalizedPattern = input.pattern.replace(/^\.\//, "");
		const pathPattern = path.isAbsolute(input.searchPath) ? `*/${normalizedPattern}` : `./${normalizedPattern}`;
		args.push("-path", pathPattern);
	} else {
		args.push("-name", input.pattern);
	}
	args.push("-print", "-limit", String(input.limit));
	return args;
}

export function buildFdArgs(input: {
	pattern: string;
	searchPath: string;
	limit: number;
	insideGitRepo?: boolean;
	ignore?: boolean;
}): string[] {
	const args = ["--glob", "--color=never", "--hidden"];
	for (const vcsDir of VCS_DIRS) args.push("--exclude", vcsDir);
	if (input.ignore === false) args.push("--no-ignore");

	// fd normally ignores .gitignore outside git repos, so keep --no-require-git there.
	// Inside repos, use fd's default git-aware behavior so parent .gitignore rules stop at
	// nested repo boundaries: https://github.com/earendil-works/pi/issues/5960
	if (!input.insideGitRepo) args.push("--no-require-git");
	args.push("--max-results", String(input.limit));

	// fd --glob matches against the basename unless --full-path is set; in --full-path
	// mode it matches against the absolute candidate path, so a path-containing
	// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
	let effectivePattern = input.pattern;
	if (input.pattern.includes("/")) {
		args.push("--full-path");
		if (!input.pattern.startsWith("/") && !input.pattern.startsWith("**/") && input.pattern !== "**") {
			effectivePattern = `**/${input.pattern}`;
		}
	}
	args.push("--", effectivePattern, input.searchPath);
	return args;
}

export function buildRgFilesArgs(input: { searchPath: string; insideGitRepo?: boolean; ignore?: boolean }): string[] {
	const args = ["--files", "--sort=modified", "--hidden"];
	for (const vcsDir of VCS_DIRS) args.push("--glob", `!${vcsDir}`);
	if (input.ignore === false) args.push("--no-ignore");
	if (!input.insideGitRepo) args.push("--no-require-git");
	args.push(input.searchPath);
	return args;
}

function matchesGlobPattern(relativePath: string, pattern: string): boolean {
	const normalizedPattern = pattern.replace(/^\.\//, "");
	return (
		minimatch(relativePath, normalizedPattern, { dot: true }) ||
		minimatch(path.basename(relativePath), normalizedPattern, { dot: true })
	);
}

async function resolveGlobBackend(input: {
	pattern: string;
	searchPath: string;
	limit: number;
	ignore?: boolean;
	backend?: GlobBackend | "auto";
}): Promise<GlobBackendCommand | undefined> {
	const insideGitRepo = await isInsideGitRepo(input.searchPath);
	if (input.backend !== "bfs" && input.backend !== "fd") {
		const rgPath = await ensureTool("rg", true);
		if (rgPath) return { backend: "rg", command: rgPath, args: buildRgFilesArgs({ ...input, insideGitRepo }) };
	}

	if (input.backend !== "rg" && input.backend !== "fd") {
		const bfsPath = getOptionalSearchToolPath("bfs");
		if (bfsPath) return { backend: "bfs", command: bfsPath, args: buildBfsArgs(input) };
	}

	if (input.backend !== "rg" && input.backend !== "bfs") {
		const fdPath = await ensureTool("fd", true);
		if (fdPath) return { backend: "fd", command: fdPath, args: buildFdArgs({ ...input, insideGitRepo }) };
	}
	return undefined;
}

async function isInsideGitRepo(searchPath: string): Promise<boolean> {
	for (let current = searchPath; ; ) {
		if (await pathExists(path.join(current, ".git"))) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	timedOut?: boolean;
	timeoutMs?: number;
	path?: string;
	pattern?: string;
	entriesReturned?: number;
	backend?: GlobBackend;
	elapsedMs?: number;
	mode?: GlobOutputMode;
	sort?: GlobSort;
	appliedLimit?: number;
	appliedOffset?: number;
}

function sortGlobResults(paths: string[], searchPath: string, sort: GlobSort): string[] {
	if (sort === "none") return paths;
	const sorted = [...paths];
	if (sort === "name") {
		sorted.sort((a, b) => a.localeCompare(b));
	} else {
		sorted.sort((a, b) => {
			const aTime = statSync(path.resolve(searchPath, a), { throwIfNoEntry: false })?.mtimeMs ?? 0;
			const bTime = statSync(path.resolve(searchPath, b), { throwIfNoEntry: false })?.mtimeMs ?? 0;
			return bTime - aTime || a.localeCompare(b);
		});
	}
	return sorted;
}

function finalizeGlobResults(args: {
	relativized: string[];
	searchPath: string;
	outputMode: GlobOutputMode;
	sort: GlobSort;
	offset: number;
	requestedLimit: number;
	full?: boolean;
	backend?: GlobBackend;
	startedAt: number;
}): { content: Array<{ type: "text"; text: string }>; details: GlobToolDetails } {
	const sorted = sortGlobResults(args.relativized, args.searchPath, args.sort);
	const paged = sorted.slice(args.offset, args.offset + args.requestedLimit);
	const resultLimitReached = sorted.length > args.offset + args.requestedLimit;
	const rawOutput = args.outputMode === "count" ? String(sorted.length) : paged.join("\n");
	const truncation = truncateHead(rawOutput, args.full ? FULL_TRUNCATION : { maxLines: Number.MAX_SAFE_INTEGER });
	let resultOutput = truncation.content;
	const details: GlobToolDetails = {
		...(args.backend ? { backend: args.backend } : {}),
		elapsedMs: Date.now() - args.startedAt,
		mode: args.outputMode,
		sort: args.sort,
		entriesReturned: args.outputMode === "count" ? sorted.length : paged.length,
	};
	const notices: string[] = [];
	if (args.outputMode !== "count" && resultLimitReached) {
		notices.push(
			`${args.requestedLimit} results limit reached. Use offset=${args.offset + args.requestedLimit} to continue, or refine pattern`,
		);
		details.resultLimitReached = args.requestedLimit;
		details.appliedLimit = args.requestedLimit;
	}
	if (args.offset > 0) details.appliedOffset = args.offset;
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) resultOutput += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text: resultOutput }], details };
}

function timeoutMsFromSeconds(timeout: number | undefined): number {
	const seconds = typeof timeout === "number" && Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT_SECONDS;
	return Math.min(Math.max(seconds, Number.MIN_VALUE), MAX_TIMEOUT_SECONDS) * 1000;
}

function formatTimeoutSeconds(timeoutMs: number): string {
	const seconds = timeoutMs / 1000;
	return seconds >= 1 ? `${Math.round(seconds)}s` : `${timeoutMs}ms`;
}

function formatNoFilesFound(respectIgnores: boolean): string {
	return respectIgnores
		? "No files found matching pattern. If the file may be ignored by .gitignore or another ignore file, retry this Glob call with ignore:false."
		: "No files found matching pattern";
}

function formatGlobTimeoutResult(args: {
	pattern: string;
	path: string;
	timeoutMs: number;
	entriesReturned: number;
	partialOutput?: string;
}) {
	const timeout = formatTimeoutSeconds(args.timeoutMs);
	const partial = args.partialOutput?.trim();
	const text = [
		`Glob timed out after ${timeout} while searching ${args.path}.`,
		`Retry with a narrower path/glob, or explicitly raise timeout up to ${MAX_TIMEOUT_SECONDS}s.`,
		partial ? `\nPartial entries returned before timeout:\n${partial}` : undefined,
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
			pattern: args.pattern,
			entriesReturned: args.entriesReturned,
		},
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && /abort/i.test(error.name || error.message);
}

/**
 * Pluggable operations for the Glob tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface GlobOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Match files with a glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultGlobOperations: GlobOperations = {
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface GlobToolOptions {
	toolName?: "Glob";
	label?: string;
	/** Custom operations for Glob. Default: local filesystem plus rg/bfs/fd. */
	operations?: GlobOperations;
	/** Internal backend override for deterministic tests and fallback verification. */
	backend?: GlobBackend | "auto";
}

function formatGlobCall(
	args: { pattern: string; path?: string; limit?: number } | undefined,
	theme: Theme,
	label: string,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold(label)) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatGlobResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GlobToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines
			.map((line) => (line.endsWith("/") ? theme.fg("accent", line) : theme.fg("toolOutput", line)))
			.join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		// Result count summary
		const n = lines.length;
		text += `\n${theme.fg("dim", `${n} result${n === 1 ? "" : "s"}`)}`;
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGlobToolDefinition(
	cwd: string,
	options?: GlobToolOptions,
): ToolDefinition<typeof globSchema, GlobToolDetails | undefined> {
	const customOps = options?.operations;
	const preferredBackend = options?.backend ?? "auto";
	const toolName = options?.toolName ?? "Glob";
	const label = options?.label ?? "Glob";
	return {
		name: toolName,
		label,
		description: `Fast file pattern matching tool. Returns matching file paths relative to the search directory, sorted by modification time when the rg backend is available. Use this tool for file discovery; do not invoke \`find\` via bash — those calls are blocked at runtime. Prefers rg, then bfs, then fd. The rg and fd backends respect .gitignore by default; if a known file is missing because it may be ignored, retry the same Glob call with ignore:false. Supports offset and outputMode=count for token-efficient broad searches, and sort=name/modified/none to reorder or preserve backend order. Times out after ${DEFAULT_TIMEOUT_SECONDS}s by default; pass timeout up to ${MAX_TIMEOUT_SECONDS}s for intentional broad searches. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "Match files by glob pattern",
		executionMode: "parallel",
		parameters: globSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				limit,
				ignore,
				outputMode,
				output_mode,
				offset,
				sort,
				timeout,
				full,
			}: {
				pattern: string;
				path?: string;
				limit?: number;
				ignore?: boolean;
				outputMode?: GlobOutputMode;
				output_mode?: GlobOutputMode;
				offset?: number;
				sort?: GlobSort;
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
				let stopChild: (() => void) | undefined;
				let timeoutId: NodeJS.Timeout | undefined;
				let killTimeoutId: NodeJS.Timeout | undefined;
				const timeoutMs = timeoutMsFromSeconds(timeout);
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					if (timeoutId) clearTimeout(timeoutId);
					if (killTimeoutId) clearTimeout(killTimeoutId);
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						if (outputMode && output_mode && outputMode !== output_mode) {
							settle(() => reject(new Error("outputMode and output_mode differ")));
							return;
						}
						const outputModeValue: GlobOutputMode = outputMode ?? output_mode ?? "paths";
						const offsetValue = Math.max(0, offset ?? 0);
						const sortValue: GlobSort = sort ?? "none";
						const requestedLimit = full ? Number.MAX_SAFE_INTEGER : (limit ?? DEFAULT_LIMIT);
						const effectiveLimit =
							outputModeValue === "count" || full ? requestedLimit : offsetValue + requestedLimit;
						const startedAt = Date.now();
						const respectIgnores = ignore !== false;
						const ops = customOps ?? defaultGlobOperations;

						// If custom operations provide glob(), use that instead of fd.
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							let customTimedOut = false;
							let timeoutHandle: NodeJS.Timeout | undefined;
							const timeoutPromise = new Promise<never>((resolve) => {
								timeoutHandle = setTimeout(() => {
									customTimedOut = true;
									resolve(undefined as never);
								}, timeoutMs);
							});
							const globPromise = ops.glob(pattern, searchPath, {
								ignore: respectIgnores ? ["**/node_modules/**", "**/.git/**"] : ["**/.git/**"],
								limit: effectiveLimit,
							});
							const results =
								timeoutMs > 0 ? await Promise.race([globPromise, timeoutPromise]) : await globPromise;
							if (timeoutHandle) clearTimeout(timeoutHandle);
							if (customTimedOut) {
								settle(() =>
									resolve(
										formatGlobTimeoutResult({
											pattern,
											path: searchPath,
											timeoutMs,
											entriesReturned: 0,
										}) as any,
									),
								);
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (results.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: formatNoFilesFound(respectIgnores) }],
										details: undefined,
									}),
								);
								return;
							}

							// Relativize paths against the search root for stable output.
							const relativized = results.map((p) => {
								if (p.startsWith(searchPath)) return toPosixPath(p.slice(searchPath.length + 1));
								return toPosixPath(path.relative(searchPath, p));
							});
							const { content, details } = finalizeGlobResults({
								relativized,
								searchPath,
								outputMode: outputModeValue,
								sort: sortValue,
								offset: offsetValue,
								requestedLimit,
								full,
								startedAt,
							});
							settle(() => resolve({ content, details }));
							return;
						}

						const backendCommand = await resolveGlobBackend({
							pattern,
							searchPath,
							limit: effectiveLimit,
							ignore: respectIgnores,
							backend: preferredBackend,
						});
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!backendCommand) {
							settle(() => reject(new Error("No file search backend is available and could not be downloaded")));
							return;
						}

						const child = spawn(backendCommand.command, backendCommand.args, {
							stdio: ["ignore", "pipe", "pipe"],
						});
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let timedOut = false;
						const lines: string[] = [];

						stopChild = () => {
							if (!child.killed) {
								child.kill("SIGTERM");
								killTimeoutId = setTimeout(() => {
									if (!child.killed) child.kill("SIGKILL");
								}, 5000);
							}
						};

						if (timeoutMs > 0) {
							timeoutId = setTimeout(() => {
								timedOut = true;
								stopChild?.();
							}, timeoutMs);
						}

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						rl.on("line", (line) => {
							if (backendCommand.backend === "rg") {
								if (lines.length >= effectiveLimit) return;
								const trimmed = line.replace(/\r$/, "").trim();
								let relativePath = trimmed;
								if (trimmed.startsWith(searchPath)) relativePath = trimmed.slice(searchPath.length + 1);
								else relativePath = path.relative(searchPath, trimmed);
								if (!matchesGlobPattern(toPosixPath(relativePath), pattern)) return;
							}
							lines.push(line);
							if (backendCommand.backend === "rg" && lines.length >= effectiveLimit) stopChild?.();
						});

						child.on("error", (error) => {
							cleanup();
							settle(() =>
								reject(new Error(`Failed to run ${toolDisplayName(backendCommand.command)}: ${error.message}`)),
							);
						});

						child.on("close", (code) => {
							cleanup();
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (timedOut) {
								const relativized: string[] = [];
								for (const rawLine of lines) {
									const line = rawLine.replace(/\r$/, "").trim();
									if (!line) continue;
									const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
									let relativePath = line;
									if (line.startsWith(searchPath)) relativePath = line.slice(searchPath.length + 1);
									else relativePath = path.relative(searchPath, line);
									if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
									relativized.push(toPosixPath(relativePath));
								}
								const partialOutput = truncateHead(relativized.join("\n"), {
									maxLines: Number.MAX_SAFE_INTEGER,
								}).content;
								settle(() =>
									resolve(
										formatGlobTimeoutResult({
											pattern,
											path: searchPath,
											timeoutMs,
											entriesReturned: relativized.length,
											partialOutput,
										}) as any,
									),
								);
								return;
							}
							const output = lines.join("\n");
							if (code !== 0) {
								const backendName = toolDisplayName(backendCommand.command);
								const errorMsg = stderr.trim() || `${backendName} exited with code ${code}`;
								if (!output && !(backendCommand.backend === "rg" && code === 1 && !stderr.trim())) {
									settle(() => reject(new Error(errorMsg)));
									return;
								}
							}
							if (!output) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: formatNoFilesFound(respectIgnores) }],
										details: undefined,
									}),
								);
								return;
							}

							const relativized: string[] = [];
							for (const rawLine of lines) {
								const line = rawLine.replace(/\r$/, "").trim();
								if (!line) continue;
								const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
								let relativePath = line;
								if (line.startsWith(searchPath)) {
									relativePath = line.slice(searchPath.length + 1);
								} else {
									relativePath = path.relative(searchPath, line);
								}
								if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
								relativized.push(toPosixPath(relativePath));
							}

							const { content, details } = finalizeGlobResults({
								relativized,
								searchPath,
								outputMode: outputModeValue,
								sort: sortValue,
								offset: offsetValue,
								requestedLimit,
								full,
								backend: backendCommand.backend,
								startedAt,
							});
							settle(() => resolve({ content, details }));
						});
					} catch (e) {
						if (signal?.aborted || isAbortError(e)) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGlobCall(args, theme, label));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGlobResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGlobTool(cwd: string, options?: GlobToolOptions): AgentTool<typeof globSchema> {
	return wrapToolDefinition(createGlobToolDefinition(cwd, options));
}
