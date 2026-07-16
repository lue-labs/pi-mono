import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	TextContent,
	Tool,
	ToolReferenceContent,
	Usage,
} from "../types.ts";

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function estimateTextAndImageContentChars(
	content: string | Array<TextContent | ImageContent | ToolReferenceContent>,
): number {
	if (typeof content === "string") return content.length;

	let chars = 0;
	for (const block of content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
		else chars += block.name.length;
	}
	return chars;
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTextAndImageContentTokens(
	content: string | Array<TextContent | ImageContent | ToolReferenceContent>,
): number {
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
	let chars = 0;

	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else if (block.type === "toolCall") {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		} else {
			chars += block.name.length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			// A newer prefix message was inserted after this response (for example, a
			// compaction summary), so its usage cannot describe the current prefix.
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

function estimateMessages(messages: readonly Message[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: readonly Tool[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

function isMessageArray(value: Context | readonly Message[]): value is readonly Message[] {
	return Array.isArray(value);
}

/**
 * A usage anchor is trusted only while it plausibly reflects the messages still
 * present. After compaction the retained assistant message keeps its
 * pre-compaction `usage.totalTokens`, which counts messages that were dropped -
 * a stale anchor that over-counts the real context by multiples. Trusting it
 * collapses the available output budget in `clampMaxTokensToContext` and
 * truncates (or empties) the next turn. When the anchored estimate exceeds a
 * fresh recount of the current messages + prefix by more than this factor, the
 * anchor is treated as stale and the recount is used instead. The factor is
 * generous because the char/4 recount under-counts real tokenization; only a
 * compaction-scale mismatch trips it.
 */
const STALE_USAGE_RECOUNT_FACTOR = 2;

/**
 * Absolute floor an anchored estimate must clear before it is even considered
 * for staleness. Compaction-stale anchors are always large (a pre-compaction
 * budget in the tens-to-hundreds-of-thousands range); small anchors can
 * legitimately dwarf a char/4 recount of a short conversation (system prompt
 * and protocol overhead the recount cannot see), so applying the ratio check
 * below this floor would misfire on ordinary short conversations.
 */
const STALE_USAGE_MIN_TOKENS = 5_000;

export function estimateContextTokens(context: Context | readonly Message[]): ContextUsageEstimate {
	if (isMessageArray(context)) return estimateMessages(context);

	const estimate = estimateMessages(context.messages);
	const prefixTokens =
		(context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + estimateToolsTokens(context.tools);

	if (estimate.lastUsageIndex !== null) {
		const addedNames = new Set(
			context.messages
				.slice(estimate.lastUsageIndex + 1)
				.filter((message) => message.role === "toolResult")
				.flatMap((message) => message.addedToolNames ?? []),
		);
		const addedToolTokens = estimateToolsTokens(context.tools?.filter((tool) => addedNames.has(tool.name)));
		const anchored = {
			tokens: estimate.tokens + addedToolTokens,
			usageTokens: estimate.usageTokens,
			trailingTokens: estimate.trailingTokens + addedToolTokens,
			lastUsageIndex: estimate.lastUsageIndex,
		};

		// `anchored.tokens` (usage.totalTokens already includes the system + tools
		// prefix) is compared against an independent recount of everything currently
		// in context. A wide gap means the anchor still counts messages that
		// compaction dropped - use the recount instead of the stale usage total.
		let recountTokens = prefixTokens;
		for (const message of context.messages) recountTokens += estimateMessageTokens(message);
		if (
			anchored.tokens > STALE_USAGE_MIN_TOKENS &&
			recountTokens > 0 &&
			anchored.tokens > recountTokens * STALE_USAGE_RECOUNT_FACTOR
		) {
			return { tokens: recountTokens, usageTokens: 0, trailingTokens: recountTokens, lastUsageIndex: null };
		}
		return anchored;
	}

	return {
		tokens: estimate.tokens + prefixTokens,
		usageTokens: estimate.usageTokens,
		trailingTokens: estimate.trailingTokens + prefixTokens,
		lastUsageIndex: estimate.lastUsageIndex,
	};
}
