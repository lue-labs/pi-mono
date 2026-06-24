import { createInterface } from "node:readline";
import type { AgentTool } from "@valkyriweb/pi-agent-core";
import { Text } from "@valkyriweb/pi-tui";
import { spawn } from "child_process";
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

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
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

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const VCS_DIRS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

type FindBackend = "bfs" | "fd";

interface FindBackendCommand {
	backend: FindBackend;
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
}): string[] {
	const args = ["--glob", "--color=never", "--hidden"];

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

async function resolveFindBackend(input: {
	pattern: string;
	searchPath: string;
	limit: number;
	backend?: FindBackend | "auto";
}): Promise<FindBackendCommand | undefined> {
	if (input.backend !== "fd") {
		const bfsPath = getOptionalSearchToolPath("bfs");
		if (bfsPath) return { backend: "bfs", command: bfsPath, args: buildBfsArgs(input) };
	}

	if (input.backend !== "bfs") {
		const fdPath = await ensureTool("fd", true);
		if (fdPath) {
			const insideGitRepo = await isInsideGitRepo(input.searchPath);
			return { backend: "fd", command: fdPath, args: buildFdArgs({ ...input, insideGitRepo }) };
		}
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

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	timedOut?: boolean;
	timeoutMs?: number;
	path?: string;
	pattern?: string;
	entriesReturned?: number;
}

function timeoutMsFromSeconds(timeout: number | undefined): number {
	const seconds = typeof timeout === "number" && Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT_SECONDS;
	return Math.min(Math.max(seconds, Number.MIN_VALUE), MAX_TIMEOUT_SECONDS) * 1000;
}

function formatTimeoutSeconds(timeoutMs: number): string {
	const seconds = timeoutMs / 1000;
	return seconds >= 1 ? `${Math.round(seconds)}s` : `${timeoutMs}ms`;
}

function formatFindTimeoutResult(args: {
	pattern: string;
	path: string;
	timeoutMs: number;
	entriesReturned: number;
	partialOutput?: string;
}) {
	const timeout = formatTimeoutSeconds(args.timeoutMs);
	const partial = args.partialOutput?.trim();
	const text = [
		`find timed out after ${timeout} while searching ${args.path}.`,
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
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	toolName?: "find" | "Find";
	label?: string;
	/** Custom operations for find. Default: local filesystem plus bfs/fd */
	operations?: FindOperations;
	/** Internal backend override for deterministic tests and fallback verification. */
	backend?: FindBackend | "auto";
}

function formatFindCall(
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

function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
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

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	const preferredBackend = options?.backend ?? "auto";
	const toolName = options?.toolName ?? "find";
	const label = options?.label ?? "Find";
	return {
		name: toolName,
		label,
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory, sorted by modification time when the rg backend is available. Use this tool for file discovery; do not invoke \`find\` via bash — those calls are blocked at runtime. Prefers rg for Claude Code-style mtime sorting, then bfs, then fd. The rg and fd backends respect .gitignore; bfs does not. Times out after ${DEFAULT_TIMEOUT_SECONDS}s by default; pass timeout up to ${MAX_TIMEOUT_SECONDS}s for intentional broad searches. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "Find files by glob pattern",
		executionMode: "parallel",
		parameters: findSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				limit,
				timeout,
				full,
			}: { pattern: string; path?: string; limit?: number; timeout?: number; full?: boolean },
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
						const effectiveLimit = full ? Number.MAX_SAFE_INTEGER : (limit ?? DEFAULT_LIMIT);
						const ops = customOps ?? defaultFindOperations;

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
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							const results =
								timeoutMs > 0 ? await Promise.race([globPromise, timeoutPromise]) : await globPromise;
							if (timeoutHandle) clearTimeout(timeoutHandle);
							if (customTimedOut) {
								settle(() =>
									resolve(
										formatFindTimeoutResult({
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
										content: [{ type: "text", text: "No files found matching pattern" }],
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
							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(
								rawOutput,
								full ? FULL_TRUNCATION : { maxLines: Number.MAX_SAFE_INTEGER },
							);
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(`${effectiveLimit} results limit reached`);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
							return;
						}

						const backendCommand = await resolveFindBackend({
							pattern,
							searchPath,
							limit: effectiveLimit,
							backend: preferredBackend,
						});
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!backendCommand) {
							settle(() => reject(new Error("fd is not available and could not be downloaded")));
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
							lines.push(line);
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
										formatFindTimeoutResult({
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
								if (!output) {
									settle(() => reject(new Error(errorMsg)));
									return;
								}
							}
							if (!output) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
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

							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(
								rawOutput,
								full ? FULL_TRUNCATION : { maxLines: Number.MAX_SAFE_INTEGER },
							);
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(
									`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
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
			text.setText(formatFindCall(args, theme, label));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
