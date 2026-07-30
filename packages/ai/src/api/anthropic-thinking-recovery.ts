/**
 * Signed-thinking-block 400 recovery (fork-owned).
 *
 * Anthropic rejects a request when a thinking/redacted_thinking block in the
 * latest assistant message does not byte-match what it signed (drifted
 * signature from a crashed/paused turn, post-compaction replay, or content
 * mutation). `stream` in anthropic-messages.ts detects that specific 400 via
 * {@link isLatestThinkingModifiedError} and retries ONCE with
 * {@link stripThinkingFromLatestAssistantMessage} applied. (#thinking-roundtrip)
 *
 * Fork provenance: extracted verbatim from anthropic-messages.ts (fork-delta
 * reforge slice 6); tier `platform` in pi-fork-patch-inventory.
 */
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

// Detect the specific 400 raised when a thinking/redacted_thinking block in the
// latest assistant message does not match the signature Anthropic issued.
export function isLatestThinkingModifiedError(error: unknown): boolean {
	if ((error as { status?: unknown })?.status !== 400) return false;
	const text =
		error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error ?? "");
	return /thinking|redacted_thinking/i.test(text) && /latest assistant message/i.test(text);
}

export function stripThinkingFromLatestAssistantMessage(messages: MessageParam[]): {
	messages: MessageParam[];
	removedThinkingBlocks: number;
	removedAssistantMessage: boolean;
} {
	let latestAssistantIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "assistant") {
			latestAssistantIndex = index;
			break;
		}
	}

	const latestAssistant = messages[latestAssistantIndex];
	if (!latestAssistant || typeof latestAssistant.content === "string") {
		return { messages, removedThinkingBlocks: 0, removedAssistantMessage: false };
	}

	const content = latestAssistant.content.filter(
		(block) => block.type !== "thinking" && block.type !== "redacted_thinking",
	);
	const removedThinkingBlocks = latestAssistant.content.length - content.length;
	if (removedThinkingBlocks === 0) {
		return { messages, removedThinkingBlocks, removedAssistantMessage: false };
	}

	const recoveredMessages = [...messages];
	if (content.length === 0) {
		recoveredMessages.splice(latestAssistantIndex, 1);
		return { messages: recoveredMessages, removedThinkingBlocks, removedAssistantMessage: true };
	}

	recoveredMessages[latestAssistantIndex] = { ...latestAssistant, content };
	return { messages: recoveredMessages, removedThinkingBlocks, removedAssistantMessage: false };
}
