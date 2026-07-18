/**
 * Model-facing tool-result hygiene (fork-owned).
 *
 * Two pure boundary filters applied in AgentSession's `afterToolCall` hook:
 * - {@link capModelFacingToolResultText}: caps aggregate tool-result text at
 *   100k chars for the model, persisting the full text to
 *   `.pi/tool-results/<toolCallId>-<tool>.txt` and appending a truncation hint.
 * - {@link replaceUnsupportedToolResultImages}: replaces image blocks whose
 *   MIME type Anthropic cannot inline with a text pointer to a saved artifact
 *   under `.pi/tool-artifacts/`.
 * - {@link replaceOversizedToolResultImages}: saves a single oversized image
 *   as an artifact before it reaches session history.
 * - {@link boundModelFacingContextImages}: keeps only the newest images that
 *   fit a conservative request budget on the transient provider view.
 * - {@link stripModelFacingContextImages}: removes media from compaction
 *   contexts while preserving surrounding text and paths.
 *
 * All functions preserve their input identity when no change is needed.
 *
 * Fork provenance: extracted verbatim from agent-session.ts (fork-delta
 * reforge slice 5b); tier `platform` in pi-fork-patch-inventory.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ImageContent, TextContent, ToolReferenceContent } from "@valkyriweb/pi-ai";

const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TOOL_ARTIFACTS_DIR = ".pi/tool-artifacts";
const TOOL_RESULT_TEXT_ARTIFACTS_DIR = ".pi/tool-results";
const MAX_MODEL_FACING_TOOL_RESULT_TEXT_CHARS = 100_000;
export const MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS = 3 * 1024 * 1024;
const TOOL_RESULT_IMAGE_OMITTED =
	"[Image omitted because it exceeds the model-facing image limit. Refer to the saved artifact.]";
const CONTEXT_IMAGE_OMITTED =
	"[Image omitted from this provider request because the aggregate image budget was exceeded.]";
const COMPACTION_IMAGE_OMITTED = "[Image omitted from compaction context; refer to surrounding text or file paths.]";

type ToolResultContentBlock = TextContent | ImageContent | ToolReferenceContent;

export function capModelFacingToolResultText(
	content: ToolResultContentBlock[],
	cwd: string,
	toolCallId: string,
	toolName: string,
): ToolResultContentBlock[] | undefined {
	const totalTextChars = content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
	if (totalTextChars <= MAX_MODEL_FACING_TOOL_RESULT_TEXT_CHARS) {
		return undefined;
	}

	const relativePath = `${TOOL_RESULT_TEXT_ARTIFACTS_DIR}/${sanitizeArtifactName(toolCallId)}-${sanitizeArtifactName(toolName)}.txt`;
	let saveError: string | undefined;
	try {
		const absolutePath = resolve(cwd, relativePath);
		mkdirSync(dirname(absolutePath), { recursive: true });
		writeFileSync(
			absolutePath,
			content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("\n\n"),
			"utf8",
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		saveError = message.slice(0, 500);
	}

	const makeHint = (omittedChars: number) =>
		saveError
			? `\n\n[Tool result truncated: ${omittedChars} text chars omitted. Full-text artifact save failed: ${saveError}.]`
			: `\n\n[Tool result truncated: ${omittedChars} text chars omitted. Full text saved to ${relativePath}.]`;

	let omittedChars = 0;
	let previewBudget = MAX_MODEL_FACING_TOOL_RESULT_TEXT_CHARS;
	for (let i = 0; i < 3; i++) {
		const hint = makeHint(omittedChars);
		previewBudget = Math.max(0, MAX_MODEL_FACING_TOOL_RESULT_TEXT_CHARS - hint.length);
		const nextOmittedChars = Math.max(0, totalTextChars - previewBudget);
		if (nextOmittedChars === omittedChars) break;
		omittedChars = nextOmittedChars;
	}

	let remainingTextChars = previewBudget;
	const nextContent: ToolResultContentBlock[] = [];
	for (const block of content) {
		if (block.type !== "text") {
			nextContent.push(block);
			continue;
		}

		if (remainingTextChars <= 0) {
			continue;
		}

		if (block.text.length <= remainingTextChars) {
			nextContent.push(block);
			remainingTextChars -= block.text.length;
			continue;
		}

		nextContent.push({ type: "text", text: block.text.slice(0, remainingTextChars) });
		remainingTextChars = 0;
	}

	nextContent.push({ type: "text", text: makeHint(omittedChars) });
	return nextContent;
}

export function replaceOversizedToolResultImages(
	content: ToolResultContentBlock[],
	cwd: string,
	toolCallId: string,
): ToolResultContentBlock[] | undefined {
	let changed = false;
	const nextContent: ToolResultContentBlock[] = [];
	for (const [index, block] of content.entries()) {
		if (block.type !== "image" || block.data.length <= MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS) {
			nextContent.push(block);
			continue;
		}

		const artifact = saveToolResultImageArtifact(block, cwd, toolCallId, index);
		if (artifact.relativePath) {
			changed = true;
			nextContent.push({
				type: "text",
				text: `${TOOL_RESULT_IMAGE_OMITTED} Saved artifact to ${artifact.relativePath}`,
			});
			continue;
		}

		nextContent.push(block, {
			type: "text",
			text: `${TOOL_RESULT_IMAGE_OMITTED} Artifact save failed: ${artifact.error}; image retained in session history.`,
		});
		changed = true;
	}

	return changed ? nextContent : undefined;
}

/**
 * Bounds images on the transient provider view, retaining newest images first.
 * Stored session messages are never mutated.
 */
export function boundModelFacingContextImages<T extends object>(messages: T[]): T[] {
	return replaceContextImages(messages, MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS, CONTEXT_IMAGE_OMITTED);
}

/** Replaces every image only in the compaction request context. */
export function stripModelFacingContextImages<T extends object>(messages: T[]): T[] {
	return replaceContextImages(messages, 0, COMPACTION_IMAGE_OMITTED);
}

/**
 * Permanently retires out-of-budget images from STORED session messages.
 *
 * The transient provider view ({@link boundModelFacingContextImages}) already
 * replaces images beyond the newest-first budget with placeholder text on every
 * request, so those base64 payloads can never reach the model again — but they
 * stayed resident in `agent.state.messages`/session entries for the process
 * lifetime (my-pi#1147: multi-GB JS heaps). Because out-of-budget images cost
 * zero context tokens, they never trigger compaction and accumulate without
 * bound in long sessions.
 *
 * Mutates message content arrays in place with the exact placeholder block the
 * transient view emits, so provider request bytes are unchanged (cache-neutral:
 * both this function and the pre-extension-transform provider bound share
 * {@link collectOverBudgetImageLocations}, so they select the identical block
 * set) and every holder of the message object observes the same stub. Durable JSONL
 * is not rewritten: entries are serialized at append time. Branch/copy
 * operations that re-serialize in-memory entries carry the placeholder,
 * matching the resident-prune precedent; the original transcript keeps the
 * full payload.
 *
 * @returns number of image blocks retired.
 */
export function retireOutOfBudgetContextImages(messages: readonly object[]): number {
	const locations = collectOverBudgetImageLocations(messages, MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS);
	for (const { messageIndex, blockIndex } of locations) {
		const content = (messages[messageIndex] as { content: unknown[] }).content;
		content[blockIndex] = { type: "text", text: CONTEXT_IMAGE_OMITTED };
	}
	return locations.length;
}

/**
 * The single newest-first image-budget walk. Both the transient provider bound
 * ({@link replaceContextImages}) and persistent retirement
 * ({@link retireOutOfBudgetContextImages}) select blocks through this function,
 * so their replaced sets cannot drift — that identity is what makes persistent
 * retirement cache-neutral.
 */
function collectOverBudgetImageLocations(
	messages: readonly object[],
	imageBudget: number,
): Array<{ messageIndex: number; blockIndex: number }> {
	let remainingImageChars = imageBudget;
	const locations: Array<{ messageIndex: number; blockIndex: number }> = [];

	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const message = messages[messageIndex];
		const content = "content" in message ? (message as { content?: unknown }).content : undefined;
		if (!Array.isArray(content)) continue;

		for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
			const block = content[blockIndex];
			if (!isImageContent(block)) continue;
			if (block.data.length <= remainingImageChars) {
				remainingImageChars -= block.data.length;
				continue;
			}
			locations.push({ messageIndex, blockIndex });
		}
	}

	return locations;
}

function replaceContextImages<T extends object>(messages: T[], imageBudget: number, placeholder: string): T[] {
	const locations = collectOverBudgetImageLocations(messages, imageBudget);
	if (locations.length === 0) return messages;

	const nextMessages = messages.slice();
	const copiedContent = new Map<number, unknown[]>();
	for (const { messageIndex, blockIndex } of locations) {
		let content = copiedContent.get(messageIndex);
		if (!content) {
			content = [...(nextMessages[messageIndex] as unknown as { content: unknown[] }).content];
			nextMessages[messageIndex] = { ...nextMessages[messageIndex], content } as T;
			copiedContent.set(messageIndex, content);
		}
		content[blockIndex] = { type: "text", text: placeholder };
	}
	return nextMessages;
}

function isImageContent(block: unknown): block is ImageContent {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "image" &&
		typeof (block as { data?: unknown }).data === "string"
	);
}

export function replaceUnsupportedToolResultImages(
	content: ToolResultContentBlock[],
	cwd: string,
	toolCallId: string,
): ToolResultContentBlock[] | undefined {
	let changed = false;
	const nextContent = content.map((block, index): ToolResultContentBlock => {
		if (block.type !== "image" || SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(block.mimeType)) {
			return block;
		}

		changed = true;
		const artifact = saveToolResultImageArtifact(block, cwd, toolCallId, index);
		return {
			type: "text",
			text: artifact.relativePath
				? `[Unsupported image MIME ${block.mimeType}; saved artifact to ${artifact.relativePath}]`
				: `[Unsupported image MIME ${block.mimeType}; image omitted because artifact save failed: ${artifact.error}]`,
		};
	});

	return changed ? nextContent : undefined;
}

function saveToolResultImageArtifact(
	block: ImageContent,
	cwd: string,
	toolCallId: string,
	index: number,
): { relativePath?: string; error?: string } {
	const baseName = `${sanitizeArtifactName(toolCallId)}-${index}`;
	const extension = extensionForMimeType(block.mimeType);
	try {
		const artifactDirectory = resolve(cwd, TOOL_ARTIFACTS_DIR);
		mkdirSync(artifactDirectory, { recursive: true });
		const data = Buffer.from(block.data, "base64");
		let collisionSuffix: string | undefined;
		while (true) {
			const fileName = collisionSuffix ? `${baseName}-${collisionSuffix}${extension}` : `${baseName}${extension}`;
			const relativePath = `${TOOL_ARTIFACTS_DIR}/${fileName}`;
			try {
				writeFileSync(resolve(artifactDirectory, fileName), data, { flag: "wx" });
				return { relativePath };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					collisionSuffix = randomUUID();
					continue;
				}
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function sanitizeArtifactName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "tool-result";
}

function extensionForMimeType(mimeType: string): string {
	const subtype =
		mimeType
			.split("/")[1]
			?.toLowerCase()
			.replace(/[^a-z0-9.+-]/g, "") || "bin";
	return `.${subtype.replace("+", ".")}`;
}
