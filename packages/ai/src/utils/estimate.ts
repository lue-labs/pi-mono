import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	TextContent,
	ToolReferenceContent,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { getSystemMessageText } from "./text.ts";

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
const STALE_USAGE_RECOUNT_FACTOR = 2;
const STALE_USAGE_MIN_TOKENS = 5_000;

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

	if (message.role === "system") {
		return (
			estimateTextTokens(getSystemMessageText(message)) +
			estimateToolsTokens(message.toolsAdded) +
			estimateToolsTokens(message.toolsRemoved)
		);
	}
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

export function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate {
	const messages = "messages" in context ? context.messages : context;
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		const legacyContext = Array.isArray(context) ? undefined : (context as Context);
		if (legacyContext?.tools) {
			const addedNames = new Set(
				messages
					.slice(usageInfo.index + 1)
					.filter((message) => message.role === "toolResult")
					.flatMap((message) => message.addedToolNames ?? []),
			);
			trailingTokens += estimateToolsTokens(legacyContext.tools.filter((tool) => addedNames.has(tool.name)));
		}
		const anchoredTokens = usageTokens + trailingTokens;
		let recountTokens =
			legacyContext?.systemPrompt === undefined ? 0 : estimateTextTokens(legacyContext.systemPrompt);
		if (legacyContext?.tools) recountTokens += estimateToolsTokens(legacyContext.tools);
		for (const message of messages) recountTokens += estimateMessageTokens(message);
		if (
			anchoredTokens > STALE_USAGE_MIN_TOKENS &&
			recountTokens > 0 &&
			anchoredTokens > recountTokens * STALE_USAGE_RECOUNT_FACTOR
		) {
			return { tokens: recountTokens, usageTokens: 0, trailingTokens: recountTokens, lastUsageIndex: null };
		}
		return { tokens: anchoredTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	if (!Array.isArray(context)) {
		const legacyContext = context as Context;
		if (legacyContext.systemPrompt) tokens += estimateTextTokens(legacyContext.systemPrompt);
		if (legacyContext.tools) tokens += estimateToolsTokens(legacyContext.tools);
	}
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}
