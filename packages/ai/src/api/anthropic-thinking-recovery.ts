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

// A real user turn, as opposed to the `role:"user"` envelopes that carry tool
// results back into an agentic loop. Anthropic keeps replayed thinking blocks
// across tool results but discards them across a real user turn, so only the
// latter is a stripping boundary.
function isRealUserTurn(message: MessageParam): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return true;
	return !message.content.some((block) => block.type === "tool_result");
}

/**
 * Drop thinking blocks that Anthropic will discard anyway: those in assistant
 * messages older than the last real user turn.
 *
 * Replaying them makes the bytes we send diverge from the history Anthropic
 * retains, starting at the earliest thinking block in the session. Every later
 * user turn re-derives that divergence and rewrites the whole transcript after
 * the tools+system anchor. Stripping them keeps every message before the last
 * boundary byte-identical across turns, so a rewrite can only ever cover the
 * most recent loop.
 *
 * Blocks at or after the boundary are preserved: Anthropic validates the latest
 * assistant message's signed blocks and rejects any modification, and the
 * active tool loop needs them to continue. (#thinking-roundtrip)
 *
 * Only signed and redacted blocks are dropped. An empty signature means a
 * compat provider that never signed anything and never discards history
 * (`allowEmptySignature`), so its reasoning trace is left to replay as-is.
 */
export function stripStaleThinkingFromMessageParams(messages: MessageParam[]): MessageParam[] {
	let boundary = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isRealUserTurn(messages[i])) {
			boundary = i;
			break;
		}
	}
	if (boundary <= 0) return messages;

	const stale: MessageParam[] = [];
	for (const message of messages.slice(0, boundary)) {
		if (message.role !== "assistant" || typeof message.content === "string") {
			stale.push(message);
			continue;
		}
		const content = message.content.filter((block) => {
			if (block.type === "redacted_thinking") return false;
			if (block.type !== "thinking") return true;
			return (block.signature ?? "").trim().length === 0;
		});
		if (content.length === 0) continue;
		stale.push({ ...message, content });
	}
	return [...stale, ...messages.slice(boundary)];
}
