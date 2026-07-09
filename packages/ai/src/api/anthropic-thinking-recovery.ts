/**
 * Signed-thinking-block 400 recovery (fork-owned).
 *
 * Anthropic rejects a request when a thinking/redacted_thinking block in the
 * latest assistant message does not byte-match what it signed (drifted
 * signature from a crashed/paused turn, post-compaction replay, or content
 * mutation). `stream` in anthropic-messages.ts detects that specific 400 via
 * {@link isLatestThinkingModifiedError} and retries ONCE with
 * {@link stripThinkingFromMessageParams} applied. (#thinking-roundtrip)
 *
 * Fork provenance: extracted verbatim from anthropic-messages.ts (fork-delta
 * reforge slice 6); tier `platform` in pi-fork-patch-inventory.
 */
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

// Detect the specific 400 raised when a thinking/redacted_thinking block in the
// latest assistant message does not match the signature Anthropic issued.
export function isLatestThinkingModifiedError(error: unknown): boolean {
	const status = (error as { status?: number })?.status;
	if (status !== undefined && status !== 400) return false;
	const text =
		error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error ?? "");
	return /thinking|redacted_thinking/i.test(text) && /latest assistant message/i.test(text);
}

// Drop every thinking/redacted_thinking block from assistant message params so a
// session poisoned by a drifted signature can recover. Anthropic only validates
// replayed thinking blocks; sending none always passes. Messages left with no
// content are dropped (Anthropic rejects empty content arrays).
export function stripThinkingFromMessageParams(messages: MessageParam[]): MessageParam[] {
	const result: MessageParam[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || typeof message.content === "string") {
			result.push(message);
			continue;
		}
		const content = message.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
		if (content.length === 0) continue;
		result.push({ ...message, content });
	}
	return result;
}
