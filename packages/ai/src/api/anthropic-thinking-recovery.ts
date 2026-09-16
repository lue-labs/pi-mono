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
import type { BetaMessageParam as MessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";

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

/** Result of stripping stale thinking blocks from the latest assistant turn. */
export interface ThinkingStripResult {
	messages: MessageParam[];
	removedThinkingBlocks: number;
	removedAssistantMessage: boolean;
}

export function stripThinkingFromLatestAssistantTurn(messages: MessageParam[]): ThinkingStripResult {
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

/**
 * Whether Anthropic keeps prior-turn thinking blocks in context for this model
 * ("keep all prior turns"), or strips them once a non-tool-result user message
 * arrives ("keep the last turn only").
 *
 * Per the extended-thinking docs (thinking block preservation by model):
 * keep-all is Claude Opus 4.5+, Claude Sonnet 4.6+, and every Fable / Mythos
 * model; last-turn-only is earlier Opus and Sonnet plus all Haiku through 4.5.
 * On a keep-all model "previous turns' thinking blocks stay cached and in
 * context", so stripping them client-side is what busts the cache — it rewrites
 * the transcript from the first thinking block at every real user turn
 * (measured: 74k-token rewrite on claude-fable-5-1, my-pi cache-prefix
 * attribution 2026-09-16). Unknown or non-Claude ids default to keep-all: the
 * last-turn-only set is a closed legacy list, and replaying is the safe
 * direction (the API strips what it does not keep, costing bytes, not
 * correctness).
 */
export function anthropicKeepsPriorTurnThinking(modelId: string): boolean {
	const id = modelId.toLowerCase();
	// Legacy naming (`claude-3-5-haiku`, `claude-3-7-sonnet`, `claude-3-opus`):
	// version precedes the family; every 3.x model is last-turn-only.
	if (/claude-3(?:[-.]\d+)?-(?:opus|sonnet|haiku)/.test(id)) return false;
	const match = /(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(id);
	if (!match) return true;
	const family = match[1];
	const major = Number(match[2]);
	// `claude-opus-4-20250514` / `claude-sonnet-4-5-20250929`: a trailing
	// 8-digit date is not a minor version.
	const minor = match[3] !== undefined && match[3].length < 8 ? Number(match[3]) : 0;
	const atLeast = (needMajor: number, needMinor: number) =>
		major > needMajor || (major === needMajor && minor >= needMinor);
	if (family === "opus") return atLeast(4, 5);
	if (family === "sonnet") return atLeast(4, 6);
	return atLeast(4, 6);
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
 * messages older than the last real user turn. Only correct for last-turn-only
 * models — gate the call on {@link anthropicKeepsPriorTurnThinking}.
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
