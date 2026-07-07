import type { AgentTool } from "@valkyriweb/pi-agent-core";
import { Box, Container, Spacer, Text } from "@valkyriweb/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import { renderHunks } from "../../utils/color-diff.ts";
import { isPierreDiffRendererEnabled, renderPierrePatchToAnsi } from "../../utils/pierre-diff.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	computeEditsDiff,
	type DiffHunk,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{ additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Structured hunks for rich syntax-highlighted diff rendering */
	hunks?: DiffHunk[];
	/** Small original-file prefix for syntax context; never the full file. */
	originalContentPreview?: string;
}

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

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	toolName?: "edit" | "Edit";
	label?: string;
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
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
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
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
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	label: string,
	cwd: string,
	invalidateHost?: () => void,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, label, cwd), 0, 0));

	if (!component.preview) {
		return component;
	}

	component.addChild(new Spacer(1));
	if ("error" in component.preview) {
		component.addChild(new Text(theme.fg("error", component.preview.error), 0, 0));
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
	component.previewPending = false;
	return changed;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const toolName = options?.toolName ?? "edit";
	const label = options?.label ?? "Edit";
	return {
		name: toolName,
		label,
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet:
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"edits[].oldText must match the file exactly, including whitespace and newlines. Prefer text copied from recent Read output or another current tool result.",
			"When using text from Read output, preserve the actual file content exactly; do not include display-only line numbers, prefixes, or separators.",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Prefer the shortest stable surrounding lines over large copied blocks.",
			"If edit reports that oldText was not found, read the target region and retry with exact current text; do not repeat the same oldText.",
			"After edit succeeds, do not re-read the file to confirm the change landed — edit returns an error if it failed. Re-read only when you need the updated content for a later change.",
		],
		executionMode: "sequential",
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, cwd);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists.
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					details: {
						diff: diffResult.diff,
						patch,
						firstChangedLine: diffResult.firstChangedLine,
						hunks: diffResult.hunks,
						originalContentPreview: diffResult.originalContent.slice(0, 4_000),
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (hasRenderableStreamingDiff(previewInput) && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args, theme, label, context.cwd, context.invalidate);
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
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{
								diff: resultDiff,
								firstChangedLine: typedResult.details?.firstChangedLine,
								hunks: typedResult.details?.hunks ?? [],
								originalContent: typedResult.details?.originalContentPreview ?? "",
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
						context.invalidate,
					);
				}
			}

			const output = formatEditResult(context.args, callComponent?.preview, typedResult, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			if (context.isError) {
				component.addChild(new Text(output, 0, 0));
				return component;
			}
			// Use rich ColorDiff rendering when structured hunks are available
			if (output === "__COLOR_DIFF__" && typedResult.details?.hunks?.length) {
				const rawPath = str(
					(context.args as RenderableEditArgs | undefined)?.file_path ??
						(context.args as RenderableEditArgs | undefined)?.path,
				);
				component.addChild(
					new ColorDiffComponent(
						typedResult.details.hunks,
						rawPath ?? "",
						typedResult.details.originalContentPreview ?? null,
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

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
