/**
 * Presentation for the edit tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `edit.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Box, Container, Spacer, Text } from "@lue-labs/pi-tui";
import { renderDiff } from "../../../modes/interactive/components/diff.ts";
import { type Theme, theme } from "../../../modes/interactive/theme/theme.ts";
import { renderHunks } from "../../../utils/color-diff.ts";
import { isPierreDiffRendererEnabled, renderPierrePatchToAnsi } from "../../../utils/pierre-diff.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { EditToolDetails } from "../edit.ts";
import {
	type DiffHunk,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	normalizeToLF,
} from "../edit-diff.ts";
import { renderToolPath, str } from "../render-utils.ts";

type EditPreview = EditDiffResult | EditDiffError;
export type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

/**
 * A TUI component that renders diff hunks with syntax highlighting and
 * background colours (green/red lines, word-level changes) using the
 * ColorDiff engine adapted from Claude Code.
 */
type PierreRenderCacheEntry = {
	lines?: string[];
	promise?: Promise<void>;
	failed?: boolean;
};

const pierreRenderCache = new Map<string, PierreRenderCacheEntry>();

class PierreBackedDiffComponent {
	private readonly patch?: string;
	private readonly invalidateHost?: () => void;

	constructor(patch?: string, invalidateHost?: () => void) {
		this.patch = patch;
		this.invalidateHost = invalidateHost;
	}

	protected tryRenderPierre(width: number): string[] | undefined {
		const themeName = (theme.name?.toLowerCase() ?? "").includes("light") ? "light" : "dark";
		if (!isPierreDiffRendererEnabled() || !this.patch) {
			return undefined;
		}
		const cacheKey = `${themeName}:${width}:${this.patch}`;
		const cached = pierreRenderCache.get(cacheKey);
		if (cached?.lines) {
			return cached.lines;
		}
		if (cached?.failed) {
			return undefined;
		}
		if (!cached?.promise) {
			const entry: PierreRenderCacheEntry = {};
			entry.promise = renderPierrePatchToAnsi(this.patch, width, { theme: themeName })
				.then((lines) => {
					entry.lines = lines;
					entry.promise = undefined;
					this.invalidateHost?.();
				})
				.catch(() => {
					entry.failed = true;
					entry.promise = undefined;
				});
			pierreRenderCache.set(cacheKey, entry);
		}
		return undefined;
	}

	invalidate(): void {
		// Pierre render results are cached across component rebuilds because
		// ToolExecutionComponent invalidation reconstructs renderer children.
	}
}

class ColorDiffComponent extends PierreBackedDiffComponent {
	private readonly hunks: DiffHunk[];
	private readonly filePath: string;
	private readonly originalContent: string | null;
	private readonly dim: boolean;
	private cachedWidth?: number;
	private cachedTheme?: string;
	private cachedLines?: string[];

	constructor(
		hunks: DiffHunk[],
		filePath: string,
		originalContent: string | null,
		dim: boolean,
		patch?: string,
		invalidateHost?: () => void,
	) {
		super(patch, invalidateHost);
		this.hunks = hunks;
		this.filePath = filePath;
		this.originalContent = originalContent;
		this.dim = dim;
	}

	render(width: number): string[] {
		const pierreLines = this.tryRenderPierre(width);
		if (pierreLines) return pierreLines;

		const themeName = (theme.name?.toLowerCase() ?? "").includes("light") ? "light" : "dark";
		if (this.cachedLines && this.cachedWidth === width && this.cachedTheme === themeName) {
			return this.cachedLines;
		}
		const firstLine = this.originalContent?.split("\n")[0] ?? null;
		const lines = renderHunks(this.hunks, firstLine, this.filePath, this.originalContent, themeName, width, this.dim);
		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedTheme = themeName;
		return lines;
	}

	override invalidate(): void {
		super.invalidate();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.cachedTheme = undefined;
	}
}

class PlainDiffComponent extends PierreBackedDiffComponent {
	private readonly diff: string;
	private readonly filePath?: string;
	private cachedText?: string;

	constructor(diff: string, filePath?: string, patch?: string, invalidateHost?: () => void) {
		super(patch, invalidateHost);
		this.diff = diff;
		this.filePath = filePath;
	}

	render(width: number): string[] {
		const pierreLines = this.tryRenderPierre(width);
		if (pierreLines) return pierreLines;
		this.cachedText ??= renderDiff(this.diff, { filePath: this.filePath });
		return this.cachedText.split("\n");
	}
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	settled?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		settled: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

function hasRenderableStreamingDiff(previewInput: { path: string; edits: Edit[] } | null): previewInput is {
	path: string;
	edits: Edit[];
} {
	return previewInput?.edits.every((edit) => edit.oldText.length > 0) ?? false;
}

function createArgumentEditPreview(edits: Edit[]): EditDiffResult {
	const diffs: string[] = [];
	const hunks: DiffHunk[] = [];
	const originals: string[] = [];
	let firstChangedLine: number | undefined;
	let oldOffset = 0;
	let newOffset = 0;
	for (const edit of edits) {
		const originalContent = normalizeToLF(edit.oldText);
		const newContent = normalizeToLF(edit.newText);
		const result = generateDiffString(originalContent, newContent);
		diffs.push(result.diff);
		originals.push(originalContent);
		if (firstChangedLine === undefined && result.firstChangedLine !== undefined) {
			firstChangedLine = newOffset + result.firstChangedLine;
		}
		for (const hunk of result.hunks) {
			hunks.push({ ...hunk, oldStart: oldOffset + hunk.oldStart, newStart: newOffset + hunk.newStart });
		}
		oldOffset += originalContent.split("\n").length;
		newOffset += newContent.split("\n").length;
	}
	return { diff: diffs.join("\n"), patch: "", firstChangedLine, hunks, originalContent: originals.join("\n") };
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, label: string, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold(label))} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
	expanded: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}
	if (!expanded) return undefined;

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		// Prefer rich rendering if structured hunks are available
		if (result.details?.hunks?.length) {
			return "__COLOR_DIFF__"; // sentinel: caller will use ColorDiffComponent
		}
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settled: boolean | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (settledError || (settled && preview && "error" in preview)) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	if (settled && preview && !("error" in preview)) {
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

function getDiffSummary(preview: Exclude<EditPreview, EditDiffError>): string {
	const lines = preview.hunks?.flatMap((hunk) => hunk.lines) ?? preview.diff.split("\n");
	let additions = 0;
	let removals = 0;
	for (const line of lines) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return `+${additions} -${removals}`;
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	label: string,
	cwd: string,
	expanded: boolean,
	executionStarted: boolean,
	invalidateHost?: () => void,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settled, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, label, cwd), 0, 0));

	if (!component.preview) {
		if (executionStarted) {
			component.addChild(new Text(theme.fg("muted", "Running…"), 0, 0));
		}
		return component;
	}

	component.addChild(new Spacer(1));
	if ("error" in component.preview) {
		component.addChild(new Text(theme.fg("error", component.preview.error), 0, 0));
	} else if (!expanded) {
		component.addChild(new Text(theme.fg("muted", getDiffSummary(component.preview)), 0, 0));
	} else if (component.preview.hunks?.length && args) {
		const rawPath = str((args as RenderableEditArgs)?.file_path ?? (args as RenderableEditArgs)?.path);
		const filePath = rawPath ?? "";
		component.addChild(
			new ColorDiffComponent(
				component.preview.hunks,
				filePath,
				component.preview.originalContent ?? null,
				false,
				component.preview.patch,
				invalidateHost,
			),
		);
	} else {
		const rawPath = str((args as RenderableEditArgs)?.file_path ?? (args as RenderableEditArgs)?.path);
		component.addChild(
			new PlainDiffComponent(component.preview.diff, rawPath ?? undefined, component.preview.patch, invalidateHost),
		);
	}
	return component;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	return changed;
}

export type EditRenderers = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;

/** The edit tool is registered under more than one label, so the rendered title follows the definition. */
export function createEditRenderers(label = "Edit"): EditRenderers {
	return {
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = hasRenderableStreamingDiff(previewInput)
					? createArgumentEditPreview(previewInput.edits)
					: undefined;
				component.previewArgsKey = argsKey;
				component.settled = false;
				component.settledError = false;
			}

			return buildEditCallComponent(
				component,
				args as RenderableEditArgs | undefined,
				theme,
				label,
				context.cwd,
				context.expanded,
				context.executionStarted,
				context.invalidate,
			);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				callComponent.settled = true;
				if (context.isError) callComponent.preview = undefined;
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{
								diff: resultDiff,
								firstChangedLine: typedResult.details?.firstChangedLine,
								hunks: typedResult.details?.hunks ?? [],
								originalContent: "",
								patch: typedResult.details?.patch ?? "",
							},
							argsKey,
						) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						label,
						context.cwd,
						context.expanded,
						context.executionStarted,
						context.invalidate,
					);
				}
			}

			const output = formatEditResult(
				context.args as RenderableEditArgs | undefined,
				callComponent?.preview,
				typedResult,
				theme,
				context.isError,
				context.expanded,
			);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			if (context.isError) {
				component.addChild(new Text(output, 0, 0));
			} else if (output === "__COLOR_DIFF__" && typedResult.details?.hunks?.length) {
				// Use rich ColorDiff rendering when structured hunks are available
				const rawPath = str(
					(context.args as RenderableEditArgs | undefined)?.file_path ??
						(context.args as RenderableEditArgs | undefined)?.path,
				);
				component.addChild(
					new ColorDiffComponent(
						typedResult.details.hunks,
						rawPath ?? "",
						null,
						false,
						typedResult.details.patch,
						context.invalidate,
					),
				);
			} else {
				const rawPath = str(
					(context.args as RenderableEditArgs | undefined)?.file_path ??
						(context.args as RenderableEditArgs | undefined)?.path,
				);
				component.addChild(
					new PlainDiffComponent(output, rawPath ?? undefined, typedResult.details?.patch, context.invalidate),
				);
			}
			return component;
		},
	};
}

export const editRenderers: EditRenderers = createEditRenderers();
