import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTool } from "@valkyriweb/pi-agent-core";
import { Container, Text, truncateToWidth } from "@valkyriweb/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { highlightCode, theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import {
	BASH_MAX_OUTPUT_BYTES,
	type BashBgDetails,
	disposeBashTimeout,
	getBashBgJob,
	spawnBashBackground,
} from "../bash-bg-jobs.ts";
import {
	checkBashPolicy,
	checkNativeToolGuard,
	currentBashPolicy,
	redundantCdError,
	redundantCdToCurrentWorkingDirectory,
	semanticExitForBashCommand,
} from "../bash-policy.ts";
import { segmentCommand } from "../bash-script-segmenter.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	GUIDELINE_BASH_SHELL_WORK,
	GUIDELINE_NATIVE_FILE_TOOLS,
	GUIDELINE_READ_EDIT_WRITE,
} from "../prompt-guidelines.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	workdir: Type.Optional(
		Type.String({
			description:
				'Absolute path (or a path relative to the session working directory) to run the command in. Use this INSTEAD of `cd <dir> && …` whenever the command needs to run in a different directory — e.g. workdir: "/abs/path/to/project". Defaults to the session working directory.',
		}),
	),
	timeout: Type.Optional(
		Type.Union([
			Type.Number({
				description:
					"Timeout in seconds. Defaults to 300 seconds. On timeout the still-running command is automatically detached into a background job (returns a bgId) rather than being killed, so long work keeps running. Read it with bash_output(bgId), stop it with bash_kill(bgId).",
			}),
			Type.Literal(false, { description: "Disable timeout for this command." }),
		]),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to spawn the command in the background. Returns immediately with a bgId. Read accumulated output with bash_output(bgId) and stop it with bash_kill(bgId). Use this for any command likely to exceed ~30s when you do not need its stdout immediately. For continuous log streams that should wake the agent on each batch, prefer the Monitor tool (monitor_start) instead.",
		}),
	),
	tui_only: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to stream output live to the TUI but return only an exit/size summary to the model context. Use for long monitoring loops (reboot waits, log tails, progress meters) where the streaming output is for human eyes and would be wasted tokens in context. Incompatible with run_in_background.",
		}),
	),
	full: Type.Optional(
		Type.Boolean({
			description:
				"Return the entire command output with no line/byte truncation (and skip tokenjuice compaction). Use only when you genuinely need the complete output. Defaults to false.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null; backgroundedJobId?: string }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let backgroundedJobId: string | undefined;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Race real exit against the timeout. On timeout the disposition seam
				// decides what happens (core default: kill and fail). Consumers opt into
				// detach-on-timeout via onBashTimeout() — e.g. Luke's native-tool-aliases
				// extension adopts the live process into a background job (Claude Code
				// parity) so long work keeps running and stays readable/killable by bgId.
				const exitPromise = waitForChildProcess(child).then((code) => ({ kind: "exit" as const, code }));
				const timeoutPromise =
					timeoutMs !== undefined
						? new Promise<{ kind: "timeout" }>((resolveTimeout) => {
								timeoutHandle = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs);
							})
						: undefined;
				const outcome = timeoutPromise ? await Promise.race([exitPromise, timeoutPromise]) : await exitPromise;
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (outcome.kind === "timeout") {
					// Detach the foreground listeners first so the bg log is the single sink,
					// then hand off to the configured disposition.
					child.stdout?.off("data", onData);
					child.stderr?.off("data", onData);
					const disposition = disposeBashTimeout(child, command, cwd, timeoutMs ?? 0);
					if ("backgroundedJobId" in disposition) {
						backgroundedJobId = disposition.backgroundedJobId;
						return { exitCode: null, backgroundedJobId };
					}
					// Failed disposition (the default kills): surface the timeout sentinel so
					// the tool layer reports "Command timed out after Ns" instead of a bare exit code.
					throw new Error(`timeout:${timeout ?? 0}`);
				}
				return { exitCode: outcome.code };
			} finally {
				// Adopted children stay tracked — the background job owns the pid now.
				if (!backgroundedJobId && child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	toolName?: "bash" | "Bash";
	label?: string;
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;
const DEFAULT_BASH_TIMEOUT_SECONDS = 300;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function resolveBashTimeout(timeout: number | false | undefined): number | undefined {
	if (timeout === false) return undefined;
	return timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS;
}

function formatBashCall(
	args: { command?: string; timeout?: number | false; run_in_background?: boolean; tui_only?: boolean } | undefined,
	label: string,
): string {
	const command = str(args?.command);
	const timeout = resolveBashTimeout(args?.timeout as number | false | undefined);
	const isBackground = args?.run_in_background === true;
	const isTuiOnly = args?.tui_only === true;
	const modeSuffix = isBackground ? theme.fg("accent", " [bg]") : isTuiOnly ? theme.fg("accent", " [tui]") : "";
	const timeoutSuffix =
		modeSuffix || (timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : theme.fg("muted", " (no timeout)"));

	const prompt = `${theme.fg("toolTitle", theme.bold(label))} `;

	if (command === null) return prompt + invalidArgText(theme) + timeoutSuffix;
	if (!command) return prompt + theme.fg("toolOutput", "...") + timeoutSuffix;

	// Segment the command and highlight each portion in its own language
	const segments = segmentCommand(command);
	const allLines: string[] = [];
	for (const seg of segments) {
		const highlighted = highlightCode(seg.text, seg.lang);
		allLines.push(...highlighted);
	}
	const highlighted =
		allLines.length === 1
			? (allLines[0] ?? "")
			: (allLines[0] ?? "") +
				allLines
					.slice(1)
					.map((l) => `\n  ${l}`)
					.join("");

	return prompt + highlighted + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? BASH_MAX_OUTPUT_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const toolName = options?.toolName ?? "bash";
	const label = options?.label ?? "Bash";
	return {
		name: toolName,
		label,
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${BASH_MAX_OUTPUT_BYTES / 1024}KB (whichever is hit first); if truncated, full output is saved to a temp file (or pass full:true to return the complete output inline when you truly need all of it). Optionally provide a timeout in seconds. IMPORTANT: prefer native file tools for repo exploration (Glob for paths, Grep for content, Read/Edit/Write for files); standalone \`grep\`/\`rg\`/\`find\` in Bash is rejected, though pipeline filters on command output (e.g. \`kubectl ... | grep Ready\`) are fine. Pass run_in_background:true to run detached and return immediately with a bgId — a task_notification fires on completion (do not poll); read with bash_output(bgId), stop with bash_kill(bgId). Pass tui_only:true to stream output to the TUI but return only an exit/size summary to context (incompatible with run_in_background).`,
		promptSnippet:
			"Execute bash commands; set run_in_background:true for long-running work and read later with bash_output",
		executionMode: "sequential",
		promptGuidelines: [
			"Use run_in_background:true for any command likely to exceed ~30s when you don't need the output immediately (builds, installers, kubectl rollouts, long test suites, dev servers).",
			"A backgrounded bash job notifies you with a task_notification when it finishes (carrying the bgId + output log path). Do NOT poll it with sleep loops or re-run the command to check — continue other work and the harness re-invokes you on completion. Call bash_output(bgId) only to peek before it finishes, or use monitor_start to be woken on every output batch.",
			"Always stop background jobs you started but no longer need with bash_kill(bgId).",
			// Shared with system-prompt.ts via prompt-guidelines.ts so addGuideline
			// deduplicates by exact string match (a hand-copied variant drifted once
			// and sessions carried both near-duplicate bullets).
			GUIDELINE_NATIVE_FILE_TOOLS,
			GUIDELINE_BASH_SHELL_WORK,
			GUIDELINE_READ_EDIT_WRITE,
		],
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{
				command,
				workdir,
				timeout,
				run_in_background,
				tui_only,
				full,
			}: {
				command: string;
				workdir?: string;
				timeout?: number | false;
				run_in_background?: boolean;
				tui_only?: boolean;
				full?: boolean;
			},
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			// Per-call working directory (Codex exec_command parity). Absolute `workdir`
			// wins; a relative one resolves against the session cwd. A non-existent dir
			// surfaces downstream as a clear spawn error rather than running in the wrong
			// place. Omitting `workdir` is byte-identical to the previous behaviour.
			const effectiveCwd = workdir ? resolve(cwd, workdir) : cwd;
			const policy = currentBashPolicy();
			if (policy) {
				const denied = checkBashPolicy(command, policy);
				if (denied) {
					return {
						isError: true,
						content: [{ type: "text", text: denied }],
						details: undefined,
					};
				}
			}
			const nativeGuard = checkNativeToolGuard(command);
			if (nativeGuard) {
				return {
					isError: true,
					content: [{ type: "text", text: nativeGuard }],
					details: undefined,
				};
			}
			if (redundantCdToCurrentWorkingDirectory(command, effectiveCwd)) {
				return {
					isError: true,
					content: [{ type: "text", text: redundantCdError() }],
					details: undefined,
				};
			}

			if (tui_only && run_in_background) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "tui_only is incompatible with run_in_background. Background jobs already keep output out of context in the returned outputPath.",
						},
					],
					details: undefined,
				};
			}

			// Background fast-path: spawn detached, return immediately. No timeout, no output streaming.
			if (run_in_background) {
				const job = spawnBashBackground(command, effectiveCwd, options?.shellPath, commandPrefix);
				const text =
					`Backgrounded bash job ${job.id} (pid=${job.pid ?? "unknown"}).\n` +
					`Task id: ${job.id}\n` +
					`Command: ${command}\n` +
					`Output file: ${job.logPath}\n\n` +
					`Inspect output with Read(path="${job.logPath}", offset/limit as needed). Stop with TaskStop(task_id="${job.id}").`;
				return {
					content: [{ type: "text", text }],
					details: {
						bgId: job.id,
						taskId: job.id,
						pid: job.pid,
						logPath: job.logPath,
						outputPath: job.logPath,
						command,
						startedAt: job.startedAt,
					} as BashBgDetails as any,
				};
			}
			const timeoutSeconds = resolveBashTimeout(timeout);
			const startedAt = Date.now();
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, effectiveCwd, spawnHook);
			const output = new OutputAccumulator({
				tempFilePrefix: "pi-bash",
				maxBytes: full ? Number.POSITIVE_INFINITY : BASH_MAX_OUTPUT_BYTES,
				maxLines: full ? Number.POSITIVE_INFINITY : undefined,
			});
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(BASH_MAX_OUTPUT_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				let backgroundedJobId: string | undefined;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout: timeoutSeconds,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
					backgroundedJobId = result.backgroundedJobId;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					// A timed-out command whose disposition failed (the core default kills)
					// throws the `timeout:N` sentinel; detach dispositions return a bgId instead.
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (backgroundedJobId) {
					const job = getBashBgJob(backgroundedJobId);
					const status =
						`Command exceeded ${timeoutSeconds}s and is still running — detached into background job bgId=${backgroundedJobId}` +
						(job?.pid ? ` (pid=${job.pid})` : "") +
						`. The process was NOT killed. Read live output with bash_output(bgId="${backgroundedJobId}"); stop it with bash_kill(bgId="${backgroundedJobId}").`;
					return {
						content: [{ type: "text", text: appendStatus(outputText, status) }],
						details: job ? ({ ...job, fullOutputPath: job.logPath } as unknown as BashBgDetails) : details,
					};
				}
				if (tui_only) {
					const durationStr = formatDuration(Date.now() - startedAt);
					const sizeStr = `${snapshot.truncation.totalLines} lines, ${formatSize(snapshot.truncation.totalBytes)}`;
					const pathHint = snapshot.fullOutputPath ? ` Saved: ${snapshot.fullOutputPath}` : "";
					const summary =
						exitCode === 0 || exitCode === null
							? `[tui_only] Command exited ${exitCode ?? "null"} after ${durationStr} (${sizeStr}). Output streamed to TUI only.${pathHint}`
							: `[tui_only] Command exited ${exitCode} after ${durationStr} (${sizeStr}). Output streamed to TUI only.${pathHint}`;
					if (exitCode !== 0 && exitCode !== null && !semanticExitForBashCommand(command, exitCode)) {
						throw new Error(summary);
					}
					return { content: [{ type: "text", text: summary }], details };
				}
				if (exitCode !== 0 && exitCode !== null) {
					const semanticExit = semanticExitForBashCommand(command, exitCode);
					if (!semanticExit) {
						throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
					}
					const status = `Command exited with code ${exitCode} (${semanticExit.summary}; treated as success).`;
					return { content: [{ type: "text", text: appendStatus(outputText, status) }], details };
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args, label));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}

export function createUppercaseBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createBashToolDefinition(cwd, { ...options, toolName: "Bash", label: "Bash" });
}

export function createUppercaseBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createUppercaseBashToolDefinition(cwd, options));
}

// Fork seam: the background-job registry, bash policy/guards, script segmenter,
// and bash_output/bash_kill tools were extracted verbatim into fork-owned
// modules. Re-export the moved public surface so downstream imports (src/index.ts,
// core/tools/index.ts, tasks, extensions, tests) are unchanged.
export {
	assertBashBgCapacity,
	BASH_BG_LOG_MAX_AGE_MS,
	BASH_BG_MAX_CONCURRENT,
	type BashBgDetails,
	type BashBgJob,
	type BashBgJobStore,
	type BashTimeout,
	type BashTimeoutOutcome,
	createBashBgJobStore,
	getBashBgJob,
	getRunningBashBgJobsSorted,
	killAllBashBgJobs,
	killBashBgJob,
	listBashBgJobs,
	onBashTimeout,
	spawnBashBackground,
	subscribeBashBgJobs,
	subscribeBashBgTerminal,
	sweepStaleBashBgLogs,
} from "../bash-bg-jobs.ts";
export {
	type BashPolicy,
	checkBashPolicy,
	checkNativeToolGuard,
	EXPLORE_BASH_POLICY,
	redundantCdToCurrentWorkingDirectory,
	runWithBashPolicy,
	semanticExitForBashCommand,
} from "../bash-policy.ts";
export {
	type BashKillToolInput,
	createBashKillTool,
	createBashKillToolDefinition,
	createKillShellTool,
	createKillShellToolDefinition,
} from "./bash-kill.ts";
export {
	type BashOutputToolDetails,
	type BashOutputToolInput,
	createBashOutputNativeTool,
	createBashOutputNativeToolDefinition,
	createBashOutputTool,
	createBashOutputToolDefinition,
	renderBashBgOutput,
	renderOrphanedBashBgOutput,
} from "./bash-output.ts";
