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
 *
 * Both return `undefined` when no change is needed so the caller can keep the
 * original content reference (identity-preserving fast path).
 *
 * Fork provenance: extracted verbatim from agent-session.ts (fork-delta
 * reforge slice 5b); tier `platform` in pi-fork-patch-inventory.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ImageContent, TextContent, ToolReferenceContent } from "@valkyriweb/pi-ai";

const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TOOL_ARTIFACTS_DIR = ".pi/tool-artifacts";
const TOOL_RESULT_TEXT_ARTIFACTS_DIR = ".pi/tool-results";
const MAX_MODEL_FACING_TOOL_RESULT_TEXT_CHARS = 100_000;

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
		const relativePath = `${TOOL_ARTIFACTS_DIR}/${sanitizeArtifactName(toolCallId)}-${index}${extensionForMimeType(block.mimeType)}`;
		const absolutePath = resolve(cwd, relativePath);
		try {
			mkdirSync(dirname(absolutePath), { recursive: true });
			writeFileSync(absolutePath, Buffer.from(block.data, "base64"));
			return {
				type: "text",
				text: `[Unsupported image MIME ${block.mimeType}; saved artifact to ${relativePath}]`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				type: "text",
				text: `[Unsupported image MIME ${block.mimeType}; image omitted because artifact save failed: ${message}]`,
			};
		}
	});

	return changed ? nextContent : undefined;
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
