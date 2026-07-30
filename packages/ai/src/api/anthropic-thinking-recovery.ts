/**
 * Signed-thinking-block 400 recovery (fork-owned).
 *
 * Anthropic rejects a request when a thinking/redacted_thinking block in the
 * latest assistant turn does not byte-match what it signed (drifted signature
 * from a crashed/paused turn, post-compaction replay, or content mutation).
 * `stream` in anthropic-messages.ts detects that specific 400 via
 * {@link isLatestThinkingModifiedError} and retries ONCE with
 * {@link stripThinkingFromLatestAssistantTurn} applied. (#thinking-roundtrip)
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
	return /`?thinking`?\s+or\s+`?redacted_thinking`?\s+blocks in the latest assistant message cannot be modified/i.test(
		text,
	);
}

export function stripThinkingFromLatestAssistantTurn(messages: MessageParam[]): {
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
	if (latestAssistantIndex === -1) {
		return { messages, removedThinkingBlocks: 0, removedAssistantMessage: false };
	}

	let firstAssistantIndex = latestAssistantIndex;
	while (firstAssistantIndex > 0 && messages[firstAssistantIndex - 1].role === "assistant") {
		firstAssistantIndex--;
	}

	const recoveredMessages = [...messages];
	let removedThinkingBlocks = 0;
	let removedAssistantMessage = false;
	for (let index = latestAssistantIndex; index >= firstAssistantIndex; index--) {
		const assistant = messages[index];
		if (typeof assistant.content === "string") continue;

		const content = assistant.content.filter(
			(block) => block.type !== "thinking" && block.type !== "redacted_thinking",
		);
		removedThinkingBlocks += assistant.content.length - content.length;
		if (content.length === assistant.content.length) continue;

		if (content.length === 0) {
			recoveredMessages.splice(index, 1);
			removedAssistantMessage = true;
		} else {
			recoveredMessages[index] = { ...assistant, content };
		}
	}

	if (removedThinkingBlocks === 0) {
		return { messages, removedThinkingBlocks, removedAssistantMessage: false };
	}
	return { messages: recoveredMessages, removedThinkingBlocks, removedAssistantMessage };
}
