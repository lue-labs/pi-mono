/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@valkyriweb/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { formatDimensionNote, type ImageResizeOptions, resizeImage } from "../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Optional image resize budget. Defaults preserve core's 2000x2000 / 4.5MB base64 behavior. */
	imageResizeOptions?: ImageResizeOptions;
}

function parsePositiveIntEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function getImageResizeOptionsFromEnv(): ImageResizeOptions | undefined {
	const maxDimension = parsePositiveIntEnv("PI_IMAGE_INLINE_MAX_DIMENSION");
	const maxBytes = parsePositiveIntEnv("PI_IMAGE_INLINE_MAX_BYTES");
	const jpegQuality = parsePositiveIntEnv("PI_IMAGE_INLINE_JPEG_QUALITY");
	if (maxDimension === undefined && maxBytes === undefined && jpegQuality === undefined) return undefined;
	return {
		...(maxDimension !== undefined ? { maxWidth: maxDimension, maxHeight: maxDimension } : {}),
		...(maxBytes !== undefined ? { maxBytes } : {}),
		...(jpegQuality !== undefined ? { jpegQuality: Math.min(jpegQuality, 100) } : {}),
	};
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const imageResizeOptions = options?.imageResizeOptions ?? getImageResizeOptionsFromEnv();
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// Check if file is empty
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// Handle image file
			const content = await readFile(absolutePath);

			let attachment: ImageContent;
			let dimensionNote: string | undefined;

			if (autoResizeImages) {
				const resized = await resizeImage(content, mimeType, imageResizeOptions);
				if (!resized) {
					text += `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`;
					continue;
				}
				dimensionNote = formatDimensionNote(resized);
				attachment = {
					type: "image",
					mimeType: resized.mimeType,
					data: resized.data,
				};
			} else {
				attachment = {
					type: "image",
					mimeType,
					data: content.toString("base64"),
				};
			}

			images.push(attachment);

			// Add text reference to image with optional dimension note
			if (dimensionNote) {
				text += `<file name="${absolutePath}">${dimensionNote}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			try {
				const content = await readFile(absolutePath, "utf-8");
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
