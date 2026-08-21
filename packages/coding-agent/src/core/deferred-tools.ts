import type { ToolReferenceContent } from "@lue-labs/pi-ai";
import type { ToolDefinition } from "./extensions/types.ts";

export type DeferredToolReferenceBlock = ToolReferenceContent;

interface MessageLike {
	content?: unknown;
}

export function isDeferredTool(definition: ToolDefinition): boolean {
	return definition.deferLoading === true && definition.alwaysLoad !== true;
}

/**
 * CACHE CRITICAL: reconstruct which deferred tools have been loaded into the
 * prompt from `tool_reference` blocks embedded in transcript history. Used by
 * context-usage accounting to distinguish loaded vs still-deferred schemas.
 */
export function scanPromptVisibleDeferredToolNames(messages: Iterable<unknown>): string[] {
	const discovered = new Set<string>();
	for (const rawMessage of messages) {
		const message = rawMessage as MessageLike;
		for (const block of contentBlocks(message.content)) {
			if (isDeferredToolReferenceBlock(block)) discovered.add(block.name);
		}
	}
	return Array.from(discovered);
}

function contentBlocks(content: unknown): unknown[] {
	if (Array.isArray(content)) return content;
	if (content && typeof content === "object" && "content" in content)
		return contentBlocks((content as { content: unknown }).content);
	return [];
}

function isDeferredToolReferenceBlock(value: unknown): value is DeferredToolReferenceBlock {
	return (
		value !== null &&
		typeof value === "object" &&
		(value as { type?: unknown }).type === "tool_reference" &&
		typeof (value as { name?: unknown }).name === "string"
	);
}
