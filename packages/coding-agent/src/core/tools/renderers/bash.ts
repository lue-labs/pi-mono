/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

import { Container, Text, truncateToWidth } from "@lue-labs/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../../modes/interactive/components/visual-truncate.ts";
import { highlightCode, theme } from "../../../modes/interactive/theme/theme.ts";
import { BASH_MAX_OUTPUT_BYTES } from "../../bash-bg-jobs.ts";
import { segmentCommand } from "../../bash-script-segmenter.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { BashToolDetails } from "../bash.ts";
import { getTextOutput, invalidArgText, str } from "../render-utils.ts";
import { formatSize } from "../truncate.ts";

const BASH_PREVIEW_LINES = 5;
export const BASH_UPDATE_THROTTLE_MS = 100;
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
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}
export function resolveBashTimeout(
	timeout: number | false | undefined,
	defaultTimeoutSeconds: number | undefined,
): number | undefined {
	if (timeout === false) return undefined;
	if (timeout !== undefined) return timeout;
	return defaultTimeoutSeconds;
}

function formatBashCall(
	args: { command?: string; timeout?: number | false; run_in_background?: boolean; tui_only?: boolean } | undefined,
	label: string,
	defaultTimeoutSeconds: number | undefined,
): string {
	const command = str(args?.command);
	const timeout = resolveBashTimeout(args?.timeout as number | false | undefined, defaultTimeoutSeconds);
	const isBackground = args?.run_in_background === true;
	const isTuiOnly = args?.tui_only === true;
	const modeSuffix = isBackground ? theme.fg("accent", " [bg]") : isTuiOnly ? theme.fg("accent", " [tui]") : "";
	const timeoutSuffix =
		modeSuffix || (timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : theme.fg("muted", " (no timeout)"));
	const prompt = `${theme.fg("toolTitle", theme.bold(label))} `;
	if (command === null) return prompt + invalidArgText(theme) + timeoutSuffix;
	if (!command) return prompt + theme.fg("toolOutput", "...") + timeoutSuffix;
	const segments = segmentCommand(command);
	const allLines: string[] = [];
	for (const seg of segments) allLines.push(...highlightCode(seg.text, seg.lang));
	const highlighted =
		allLines.length === 1
			? (allLines[0] ?? "")
			: (allLines[0] ?? "") +
				allLines
					.slice(1)
					.map((line) => `\n  ${line}`)
					.join("");
	return prompt + highlighted + timeoutSuffix;
}
function formatShellCall(args: { command?: string; timeout?: number | false } | undefined, prompt: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
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

/** Shell renderers are shared by bash and powershell, which differ only in the prompt they display. */
/** Options for the `bash` tool's richer call line (segmented highlighting, timeout and mode suffixes). */
export type BashCallRenderOptions = {
	label: string;
	defaultTimeoutSeconds: number | undefined;
};

export function createShellRenderers(
	prompt: string,
	bashCall?: BashCallRenderOptions,
): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				bashCall
					? formatBashCall(args as any, bashCall.label, bashCall.defaultTimeoutSeconds)
					: formatShellCall(args as { command?: string; timeout?: number | false } | undefined, prompt),
			);
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
