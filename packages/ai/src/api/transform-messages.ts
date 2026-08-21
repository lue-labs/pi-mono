import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolReferenceContent,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(
	content: (TextContent | ImageContent | ToolReferenceContent)[],
	placeholder: string,
): (TextContent | ToolReferenceContent)[] {
	const result: (TextContent | ToolReferenceContent)[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		if (block.type === "tool_reference") {
			result.push(block);
			previousWasPlaceholder = false;
			continue;
		}

		if (block.type !== "text") continue;
		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER).filter(
					(block): block is TextContent => block.type === "text",
				),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

function hasVisibleUserContent(message: Message): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return message.content.trim().length > 0;
	return message.content.some((block) => block.type !== "text" || block.text.trim().length > 0);
}

/**
 * Restore `tool_use` -> `tool_result` adjacency in a recorded history.
 *
 * Anthropic requires every `tool_result` to lead the message immediately after
 * the assistant turn that opened the call. A message injected while a tool is
 * still running (extension steer, captain wake, monitor notification) is
 * persisted *between* the `toolCall` entry and its `toolResult`, so the rebuilt
 * history reads assistant -> user -> toolResult and the provider rejects the
 * whole request with `unexpected tool_use_id found in tool_result blocks`. The
 * malformed shape is already committed to the session file, so the rejection
 * repeats forever and the session is unrecoverable (pi-mono#479, mirror of
 * #406/#380).
 *
 * This seam repairs the transcript on the way out: results for the open batch
 * are pulled back next to their assistant turn and the displaced messages are
 * re-emitted after them, so no content is lost and only the ordering changes.
 * It also drops the two shapes the provider can never accept — a `tool_result`
 * whose `tool_use` is absent from the history entirely, and a duplicate result
 * for an already-settled call.
 *
 * Returns the input array unchanged when the history is already well formed, so
 * valid requests serialise byte-identically and the prompt cache is untouched.
 */
export function restoreToolResultAdjacency(messages: Message[]): Message[] {
	const result: Message[] = [];
	const openedToolCallIds = new Set<string>();
	const settledToolCallIds = new Set<string>();
	let changed = false;

	const pushToolResult = (msg: ToolResultMessage): void => {
		// Orphan (no matching tool_use anywhere) or duplicate result: both are hard
		// 400s, and neither carries information the model can act on.
		if (!openedToolCallIds.has(msg.toolCallId) || settledToolCallIds.has(msg.toolCallId)) {
			changed = true;
			return;
		}
		settledToolCallIds.add(msg.toolCallId);
		result.push(msg);
	};

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;

		if (msg.role === "toolResult") {
			pushToolResult(msg as ToolResultMessage);
			continue;
		}

		result.push(msg);
		if (msg.role !== "assistant") continue;

		const batchIds = new Set(
			(msg as AssistantMessage).content.filter((b) => b.type === "toolCall").map((b) => (b as ToolCall).id),
		);
		if (batchIds.size === 0) continue;
		for (const id of batchIds) openedToolCallIds.add(id);

		// Scan to the next assistant turn: that is the window an injected message can
		// land in. Results for this batch are emitted first, everything else after.
		const displaced: Message[] = [];
		let j = i + 1;
		for (; j < messages.length; j++) {
			const next = messages[j]!;
			if (next.role === "assistant") break;
			if (next.role === "toolResult" && batchIds.has((next as ToolResultMessage).toolCallId)) {
				if (displaced.length > 0) changed = true;
				pushToolResult(next as ToolResultMessage);
				continue;
			}
			displaced.push(next);
		}
		for (const held of displaced) {
			if (held.role === "toolResult") pushToolResult(held as ToolResultMessage);
			else result.push(held);
		}
		i = j - 1;
	}

	return changed ? result : messages;
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	const transformed = imageAwareMessages.map((msg) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Redacted thinking is opaque encrypted content, only valid for the same model.
					// Drop it for cross-model to avoid API errors.
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// For same model: keep thinking blocks with signatures (needed for replay)
					// even if the thinking text is empty (OpenAI encrypted reasoning)
					if (isSameModel && block.thinkingSignature) return block;
					// Skip empty thinking blocks, convert others to plain text
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements.
	// Adjacency is restored first so a message injected mid-tool-call cannot make
	// the pass below synthesise a result for a call the history already settles
	// (that duplicate is itself an Anthropic 400 — pi-mono#479).
	const adjacent = restoreToolResultAdjacency(transformed);
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const droppedToolCallIds = new Set<string>();
	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
	};

	for (let i = 0; i < adjacent.length; i++) {
		const msg = adjacent[i];

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			insertSyntheticToolResults();

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				// Dropping the assistant message orphans any tool_result that references
				// its tool calls (recorded results, or fork-placeholder results that
				// context:"fork" synthesizes for unresolved calls). Providers reject
				// orphans — Anthropic 400s with "unexpected tool_use_id" — so drop the
				// dependent results with it.
				for (const block of assistantMsg.content) {
					if (block.type === "toolCall") droppedToolCallIds.add(block.id);
				}
				continue;
			}

			// Track tool calls from this assistant message
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			if (droppedToolCallIds.has(msg.toolCallId)) continue;
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// CACHE CRITICAL: hidden/empty hook messages must not interrupt the
			// assistant tool_use -> toolResult adjacency. Providers drop these
			// messages later; synthesizing missing results before that creates
			// duplicate tool_result blocks and Anthropic rejects the request.
			if (!hasVisibleUserContent(msg)) continue;

			// User message interrupts tool flow - insert synthetic results for orphaned calls
			insertSyntheticToolResults();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	insertSyntheticToolResults();

	return result;
}
