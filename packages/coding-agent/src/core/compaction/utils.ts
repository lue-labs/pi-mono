/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@valkyriweb/pi-agent-core";
import type { Message } from "@valkyriweb/pi-ai";

// ============================================================================
// Auto-compaction thrashing detector
//
// Ports the auto-compaction breaker behavior observed in Claude Code 2.1.201:
// if auto-compaction keeps refilling the context back to the threshold within
// a handful of turns, something structural (an oversized tool result, a huge
// file read) is at fault, not the conversation itself - repeatedly compacting
// is expensive and gives the user no signal. This module only implements the
// pure rapid-refill streak calculation; the pi-native wiring, session state,
// and message text live in AgentSession.
// ============================================================================

/** Turns-since-compaction window used to decide whether a refill was "rapid". */
export const RAPID_REFILL_WINDOW = 3;

/** Consecutive rapid refills required to trip the thrashing breaker. */
export const RAPID_REFILL_TRIP_COUNT = 3;

/** Consecutive compaction failures required to trip the failure breaker. */
export const COMPACTION_FAILURE_TRIP_COUNT = 3;

/**
 * Provider-availability failures that self-resolve: rate limits / usage-limit
 * windows (OpenAI 429 usage_limit_reached responses even carry
 * resets_in_seconds), overload shedding (Anthropic 529 overloaded_error), and
 * transient gateway errors (502/503/504). Matched on the flattened error
 * message because provider errors reach the compaction catch as plain Error
 * messages, e.g.
 * `Summarization failed: OpenAI API error (429): {"type":"usage_limit_reached",...}`.
 */
const TRANSIENT_COMPACTION_ERROR_PATTERN =
	/\b(?:429|502|503|504|529)\b|rate.?limit|usage.?limit|too many requests|RESOURCE_EXHAUSTED|overloaded|service unavailable|resets_in_seconds/i;

/**
 * Whether a compaction failure is a transient provider-availability error
 * (rate limit, usage-limit window, overload) rather than a structural one
 * (oversized payload, broken auth, missing model). Transient failures must
 * not count toward the failure circuit breaker: the breaker permanently
 * disables auto-compaction for the session, but a rate-limited provider
 * recovers on its own (usage-limit 429s carry an explicit reset time) — the
 * session keeps working after the reset, so tripping the breaker would leave
 * a healthy session unable to compact until it dies at the context-window
 * limit. Transient failures also must not reset a real-failure streak: they
 * carry no signal about whether the underlying structural problem went away.
 */
export function isTransientCompactionError(errorMessage: string): boolean {
	return TRANSIENT_COMPACTION_ERROR_PATTERN.test(errorMessage);
}

export interface RapidRefillInput {
	/** Whether a compaction has already happened earlier in this session. */
	hadPriorCompaction: boolean;
	/** Assistant turns elapsed since the most recent compaction. */
	turnsSinceCompaction: number;
	/** Current consecutive-rapid-refill streak carried from prior evaluations. */
	consecutiveRapidRefills: number;
}

export interface RapidRefillResult {
	/** "trip" once the rapid-refill streak reaches RAPID_REFILL_TRIP_COUNT. */
	action: "trip" | "proceed";
	/** Updated streak to persist for the next evaluation. */
	consecutiveRapidRefills: number;
}

/**
 * Evaluate whether a new auto-compaction is part of a rapid-refill thrashing
 * streak. A refill counts as "rapid" when a prior compaction is still active
 * and fewer than RAPID_REFILL_WINDOW assistant turns have happened since it -
 * i.e. context refilled to the compaction threshold almost immediately after
 * being compacted. Any non-rapid refill resets the streak to zero.
 */
export function evaluateRapidRefill(input: RapidRefillInput): RapidRefillResult {
	const isRapid = input.hadPriorCompaction && input.turnsSinceCompaction < RAPID_REFILL_WINDOW;
	const consecutiveRapidRefills = isRapid ? input.consecutiveRapidRefills + 1 : 0;
	const action: "trip" | "proceed" = consecutiveRapidRefills >= RAPID_REFILL_TRIP_COUNT ? "trip" : "proceed";
	return { action, consecutiveRapidRefills };
}

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
