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

/** Compact, display-only summary of one provider-executed tool result. */
export interface ServerToolResultSummary {
	toolName: string;
	status: "completed" | "error";
	sources?: ServerToolSource[];
	errorCode?: string;
}

/**
 * The one place this module inspects an untyped wire value. Everything below
 * reads through `fields`/`stringField` instead of asserting inline, so a shape
 * assumption cannot leak past this boundary.
 */
function fields(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Readonly<Record<string, unknown>>;
}

/** Reads one string field, or undefined when absent or not a string. */
function stringField(record: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Normalize a server tool result block (web_search/web_fetch) into a compact,
 * display-only summary. Never persisted or sent back to the API.
 */
export function summarizeServerToolResult(block: ServerToolResultBlockLike): ServerToolResultSummary {
	const toolName =
		block.type === "web_fetch_tool_result"
			? "web_fetch"
			: block.type === "advisor_tool_result"
				? "advisor"
				: "web_search";
	const content = block.content;

	// Error shape: { type: "web_search_tool_result_error" | ..., error_code: "..." }
	const errorCode = stringField(fields(content), "error_code");
	if (errorCode !== undefined) {
		return { toolName, status: "error", errorCode };
	}

	// web_search: content is an array of { title, url, ... } result blocks.
	if (Array.isArray(content)) {
		const sources: ServerToolSource[] = [];
		for (const item of content) {
			const record = fields(item);
			const url = stringField(record, "url");
			if (url !== undefined) {
				sources.push({ url, title: stringField(record, "title") });
			}
		}
		return { toolName, status: "completed", sources };
	}

	// web_fetch: content is a single retrieved-document object, often { url, ... }.
	const url = stringField(fields(content), "url");
	if (url !== undefined) {
		return { toolName, status: "completed", sources: [{ url }] };
	}

	return { toolName, status: "completed" };
}
