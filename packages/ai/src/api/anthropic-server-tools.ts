/**
 * Provider-executed (server-side) tool result summarization (fork-owned).
 *
 * Server tools (web_search / web_fetch / advisor) stream result blocks whose
 * full content must never round-trip to the API or perturb the cache prefix.
 * `stream` in anthropic-messages.ts surfaces them as compact display-only
 * `server_tool_result` events built here.
 *
 * Fork provenance: extracted verbatim from anthropic-messages.ts (fork-delta
 * reforge slice 6); tier `platform` in pi-fork-patch-inventory.
 */
import type { ServerToolSource } from "../types.ts";

/**
 * Provider-executed (server-side) web tool result block, loosely typed because
 * `web_fetch_tool_result` is not in the non-beta SDK content-block union while
 * `web_search_tool_result` is. Both arrive over the wire when bridged.
 */
export interface ServerToolResultBlockLike {
	type: string;
	tool_use_id: string;
	content: unknown;
}

/**
 * Normalize a server tool result block (web_search/web_fetch) into a compact,
 * display-only summary. Never persisted or sent back to the API.
 */
export function summarizeServerToolResult(block: ServerToolResultBlockLike): {
	toolName: string;
	status: "completed" | "error";
	sources?: ServerToolSource[];
	errorCode?: string;
} {
	const toolName =
		block.type === "web_fetch_tool_result"
			? "web_fetch"
			: block.type === "advisor_tool_result"
				? "advisor"
				: "web_search";
	const content = block.content as Record<string, unknown> | unknown[] | null | undefined;

	// Error shape: { type: "web_search_tool_result_error" | ..., error_code: "..." }
	if (content && !Array.isArray(content) && typeof (content as Record<string, unknown>).error_code === "string") {
		return { toolName, status: "error", errorCode: (content as Record<string, unknown>).error_code as string };
	}

	// web_search: content is an array of { title, url, ... } result blocks.
	if (Array.isArray(content)) {
		const sources: ServerToolSource[] = [];
		for (const item of content) {
			if (item && typeof item === "object" && typeof (item as Record<string, unknown>).url === "string") {
				const record = item as Record<string, unknown>;
				sources.push({
					url: record.url as string,
					title: typeof record.title === "string" ? (record.title as string) : undefined,
				});
			}
		}
		return { toolName, status: "completed", sources };
	}

	// web_fetch: content is a single retrieved-document object, often { url, ... }.
	if (content && typeof content === "object" && typeof (content as Record<string, unknown>).url === "string") {
		return { toolName, status: "completed", sources: [{ url: (content as Record<string, unknown>).url as string }] };
	}

	return { toolName, status: "completed" };
}
