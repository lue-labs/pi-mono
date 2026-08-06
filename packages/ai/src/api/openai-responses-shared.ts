import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolReferenceContent,
	Usage,
} from "../types.ts";
import { stripSystemPromptDynamicBoundary } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
	appendGrammarToolInputJsonDelta,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { splitSystemPromptAtDynamicBoundary } from "./openai-prompt-cache.ts";
import { transformMessages } from "./transform-messages.ts";

// =============================================================================
// Utilities
// =============================================================================

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;

function convertToolResultOutput<TApi extends Api>(
	model: Model<TApi>,
	// Fork: tool result content may carry tool_reference items; the filters below drop them.
	content: readonly (TextContent | ImageContent | ToolReferenceContent)[],
): string | ToolResultOutputContent {
	const textResult = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = content.filter((c): c is ImageContent => c.type === "image");
	const hasText = textResult.length > 0;

	if (images.length === 0 || !model.input.includes("image")) {
		return sanitizeSurrogates(hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)");
	}

	const output: ToolResultOutputContent = [];
	if (hasText) {
		output.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
	}
	for (const image of images) {
		output.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.data}`,
		});
	}
	return output;
}

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	deferredTools?: ReadonlyMap<string, Tool>;
	/**
	 * Emit explicit `prompt_cache_breakpoint` markers (GPT-5.6+ prompt-cache API).
	 * Places one breakpoint at the end of the stable system-prompt prefix (split at
	 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) and one on the previous user message, leaving
	 * the implicit latest-message breakpoint and one spare write slot free (max 4
	 * cache writes per request). Older models reject these fields — opt-in per model
	 * via `OpenAIResponsesCompat.promptCacheApi: "breakpoints"`.
	 */
	promptCacheBreakpoints?: boolean;
	toolOptions?: ConvertResponsesToolsOptions;
}

const EXPLICIT_PROMPT_CACHE_BREAKPOINT = { mode: "explicit" } as const;

/**
 * Mark the last breakpoint-capable content block of the previous (second-to-last)
 * user message. Earlier-turn breakpoints stay readable server-side (latest 50), so
 * this creates a durable mid-conversation anchor: if the implicit latest-message
 * cache entry is evicted, reads fall back to this prefix instead of a full re-write.
 * The prefix up to here was already cached by the prior turn, so the incremental
 * write cost is ~0.
 */
function markPreviousUserMessageBreakpoint(messages: ResponseInput): void {
	let seenLatestUserMessage = false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const item = messages[i] as { role?: string; content?: unknown };
		if (item.role !== "user" || !Array.isArray(item.content) || item.content.length === 0) continue;
		if (!seenLatestUserMessage) {
			seenLatestUserMessage = true;
			continue;
		}
		const lastBlock = item.content[item.content.length - 1] as { type?: string; prompt_cache_breakpoint?: unknown };
		if (lastBlock.type === "input_text" || lastBlock.type === "input_image") {
			lastBlock.prompt_cache_breakpoint = EXPLICIT_PROMPT_CACHE_BREAKPOINT;
		}
		return;
	}
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	/** Sort tools and JSON Schema object keys for byte-stable prompt-cache prefixes. */
	deterministic?: boolean;
	/** Force `defer_loading: true` on every tool passed (used for a newly-surfaced deferred-tool batch). */
	deferLoading?: boolean;
	/**
	 * Emit native `defer_loading: true` on tools with `deferLoading && !alwaysLoad`,
	 * matching Codex CLI's `ResponsesApiTool` shape. The Codex backend honors this
	 * field; the public OpenAI Responses API is not known to honor it, so callers
	 * (i.e. `openai-codex-responses`) opt in explicitly.
	 */
	emitDeferLoading?: boolean;
}

type ResponsesUsageLike = {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
	};
	cache_creation_input_tokens?: number;
	cache_creation?: {
		ephemeral_5m_input_tokens?: number;
		ephemeral_1h_input_tokens?: number;
	};
	cache_creation_ephemeral_5m_input_tokens?: number;
	cache_creation_ephemeral_1h_input_tokens?: number;
};

function positiveNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseOpenAIResponsesUsage(usage: ResponsesUsageLike): Usage {
	const cacheRead = positiveNumber(usage.input_tokens_details?.cached_tokens);
	const nestedCacheWrite5m = positiveNumber(usage.cache_creation?.ephemeral_5m_input_tokens);
	const nestedCacheWrite1h = positiveNumber(usage.cache_creation?.ephemeral_1h_input_tokens);
	const flatCacheWrite5m = positiveNumber(usage.cache_creation_ephemeral_5m_input_tokens);
	const flatCacheWrite1h = positiveNumber(usage.cache_creation_ephemeral_1h_input_tokens);
	const cacheWriteBreakdown = nestedCacheWrite5m + nestedCacheWrite1h || flatCacheWrite5m + flatCacheWrite1h;
	const cacheWrite =
		positiveNumber(usage.input_tokens_details?.cache_write_tokens) ||
		positiveNumber(usage.cache_creation_input_tokens) ||
		cacheWriteBreakdown;
	const cacheWrite1h = cacheWrite > 0 ? nestedCacheWrite1h || flatCacheWrite1h || undefined : undefined;
	const inputTokens = positiveNumber(usage.input_tokens);
	return {
		// OpenAI includes cached tokens in input_tokens; provider-compatible cache
		// write fields are also prompt-side tokens, so subtract both buckets.
		input: Math.max(0, inputTokens - cacheRead - cacheWrite),
		output: positiveNumber(usage.output_tokens),
		cacheRead,
		cacheWrite,
		...(cacheWrite1h ? { cacheWrite1h } : {}),
		reasoning: positiveNumber(usage.output_tokens_details?.reasoning_tokens),
		totalTokens: positiveNumber(usage.total_tokens),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// =============================================================================
// Message conversion
// =============================================================================

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	const loadedToolNames = new Set<string>();

	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
		const role = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
		if (options?.promptCacheBreakpoints) {
			// Stable prefix carries an explicit breakpoint; the dynamic tail stays
			// unmarked so per-session content never busts the shared static prefix.
			const { stable, dynamic } = splitSystemPromptAtDynamicBoundary(context.systemPrompt);
			const content: ResponseInputContent[] = [];
			if (stable) {
				content.push({
					type: "input_text",
					text: sanitizeSurrogates(stable),
					prompt_cache_breakpoint: EXPLICIT_PROMPT_CACHE_BREAKPOINT,
				} satisfies ResponseInputText);
			}
			if (dynamic) {
				content.push({ type: "input_text", text: sanitizeSurrogates(dynamic) } satisfies ResponseInputText);
			}
			if (content.length > 0) {
				messages.push({ role, content });
			}
		} else {
			messages.push({
				role,
				content: sanitizeSurrogates(stripSystemPromptDynamicBoundary(context.systemPrompt)),
			});
		}
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;
			let textBlockIndex = 0;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					const fallbackMessageId =
						textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = fallbackMessageId;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					// When replaying custom-tool calls as a function_call, also drop non-fc_* ids such as
					// ctc_* custom-tool ids because function_call item ids must be fc_*.
					if (
						(isDifferentModel && itemId?.startsWith("fc_")) ||
						(customInputProperty === undefined && !itemId?.startsWith("fc_"))
					) {
						itemId = undefined;
					}

					if (customInputProperty !== undefined) {
						output.push({
							type: "custom_tool_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							input: sanitizeSurrogates(
								getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty),
							),
						} satisfies ResponseOutputItem);
					} else {
						output.push({
							type: "function_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.arguments),
						});
					}
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const [callId] = msg.toolCallId.split("|");
			const output = convertToolResultOutput(model, msg.content);

			if (options?.grammarToolInputProperties?.has(msg.toolName)) {
				messages.push({
					type: "custom_tool_call_output",
					call_id: callId,
					output,
				});
			} else {
				messages.push({
					type: "function_call_output",
					call_id: callId,
					output,
				});
			}

			const deferredTools: Tool[] = [];
			for (const name of msg.addedToolNames ?? []) {
				const tool = options?.deferredTools?.get(name);
				if (!tool || loadedToolNames.has(name)) continue;
				loadedToolNames.add(name);
				deferredTools.push(tool);
			}
			if (deferredTools.length > 0) {
				const names = deferredTools.map((tool) => tool.name);
				const searchCallId = `pi_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
				messages.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					arguments: { query: names.join(" "), limit: names.length },
				} satisfies ResponseInputItem);
				messages.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					tools: convertResponsesTools(deferredTools, {
						...options?.toolOptions,
						deferLoading: true,
					}),
				} satisfies ResponseToolSearchOutputItemParam);
			}
		}
		msgIndex++;
	}

	if (options?.promptCacheBreakpoints) {
		markPreviousUserMessageBreakpoint(messages);
	}

	return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================

function sortJsonSchemaForCache(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		return value.map((item) => sortJsonSchemaForCache(item));
	}

	const input = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		const child = input[key];
		out[key] = key === "required" && Array.isArray(child) ? child.slice().sort() : sortJsonSchemaForCache(child);
	}
	return out;
}

export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;
	const emitDeferLoading = options?.emitDeferLoading === true;
	const sourceTools = options?.deterministic
		? tools.slice().sort((a, b) => a.name.localeCompare(b.name) || a.description.localeCompare(b.description))
		: tools;

	return sourceTools.map((tool) => {
		const deferLoading =
			options?.deferLoading || (emitDeferLoading && tool.deferLoading === true && tool.alwaysLoad !== true);
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: {
					type: "grammar",
					syntax: grammar.format,
					definition: grammar.definition,
				},
				...(deferLoading ? { defer_loading: true } : {}),
			} satisfies OpenAITool;
		}

		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const functionTool: Omit<Extract<OpenAITool, { type: "function" }>, "strict"> & {
			strict?: Extract<OpenAITool, { type: "function" }>["strict"];
		} = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: (options?.deterministic ? sortJsonSchemaForCache(tool.parameters) : tool.parameters) as Record<
				string,
				unknown
			>, // TypeBox already generates JSON Schema
			...(deferLoading ? { defer_loading: true } : {}),
		};
		if (supportsStrictMode) {
			functionTool.strict = constrainedStrict ?? defaultStrict;
		}
		return functionTool as OpenAITool;
	});
}

// =============================================================================
// Stream processing
// =============================================================================

type StreamingToolCall = ToolCall & {
	partialJson?: string;
	customInput?: {
		property: string;
		jsonBuffer: GrammarToolInputJsonBuffer;
	};
};

function getCustomToolCallInput(block: StreamingToolCall): string {
	const property = block.customInput?.property;
	if (property === undefined) return "";
	const value = block.arguments[property];
	return typeof value === "string" ? value : "";
}

function appendCustomToolCallInput(block: StreamingToolCall, nextInput: string, close: boolean): string | undefined {
	const customInput = block.customInput;
	if (!customInput) return undefined;
	const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);
	block.arguments = { [customInput.property]: nextInput };
	return delta;
}

type ResponsesOutputSlot =
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	| { type: "text"; block: TextContent; contentIndex: number }
	| { type: "toolCall"; block: StreamingToolCall; contentIndex: number };

type ToolCallOutputSlot = Extract<ResponsesOutputSlot, { type: "toolCall" }>;

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	let sawTerminalResponseEvent = false;
	const outputSlots = new Map<number, ResponsesOutputSlot>();
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	const applyMessagePhaseStopReason = (item: ResponseOutputItem): void => {
		if (item.type === "message" && item.phase === "final_answer") {
			output.stopReason = "stop";
		}
	};
	const getSlot = <TType extends ResponsesOutputSlot["type"]>(
		outputIndex: number,
		type: TType,
	): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
		const slot = outputSlots.get(outputIndex);
		return slot?.type === type ? (slot as Extract<ResponsesOutputSlot, { type: TType }>) : undefined;
	};
	const pushToolCallDelta = (slot: ToolCallOutputSlot, delta: string | undefined): void => {
		if (delta === undefined) return;
		stream.push({
			type: "toolcall_delta",
			contentIndex: slot.contentIndex,
			delta,
			partial: output,
		});
	};
	const createSlot = (outputIndex: number, item: ResponseOutputItem): ResponsesOutputSlot | undefined => {
		if (item.type === "reasoning") {
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output.content.push(block);
			const slot = {
				type: "thinking",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "message") {
			applyMessagePhaseStopReason(item);
			const block: TextContent = { type: "text", text: "" };
			output.content.push(block);
			const slot = { type: "text", block, contentIndex: output.content.length - 1 } satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "function_call") {
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				partialJson: item.arguments || "",
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "custom_tool_call") {
			const inputProperty = options?.grammarToolInputProperties?.get(item.name) ?? "input";
			const input = item.input || "";
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: { [inputProperty]: input },
				customInput: {
					property: inputProperty,
					jsonBuffer: { input: "", started: false, closed: false },
				},
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		return undefined;
	};
	const getOrCreateSlot = (outputIndex: number, item: ResponseOutputItem): ResponsesOutputSlot | undefined => {
		return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
	};
	// Azure OpenAI can omit reasoning.encrypted_content from response.output_item.done
	// and provide it only in response.completed.response.output. Backfill the
	// persisted reasoning signature from the terminal response to keep store:false
	// multi-turn replay stateless. See https://github.com/earendil-works/pi/issues/6409.
	const backfillReasoningSignatures = (responseOutput: ResponseOutputItem[]): void => {
		for (const item of responseOutput) {
			if (item.type !== "reasoning" || !item.encrypted_content) continue;
			const block = reasoningBlocksById.get(item.id);
			if (!block?.thinkingSignature) continue;

			const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
			if (storedItem.encrypted_content) continue;
			block.thinkingSignature = JSON.stringify({
				...storedItem,
				encrypted_content: item.encrypted_content,
			});
		}
	};
	const finalizeResponse = (
		response: Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"],
	): void => {
		sawTerminalResponseEvent = true;
		backfillReasoningSignatures(response.output ?? []);
		if (response?.id) {
			output.responseId = response.id;
		}
		if (response?.usage) {
			output.usage = parseOpenAIResponsesUsage(response.usage);
		}
		calculateCost(model, output.usage);
		if (options?.applyServiceTierPricing) {
			const serviceTier = options.resolveServiceTier
				? options.resolveServiceTier(response?.service_tier, options.serviceTier)
				: (response?.service_tier ?? options.serviceTier);
			options.applyServiceTierPricing(output.usage, serviceTier);
		}
		// Map status to stop reason. For incomplete responses, retain the provider's
		// specific reason so max-output truncation and content filtering stay distinct.
		const status = response?.status;
		const incompleteDetails = response?.incomplete_details as { reason?: unknown } | null | undefined;
		const incompleteReason = typeof incompleteDetails?.reason === "string" ? incompleteDetails.reason : undefined;
		output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;
		const mappedStop = mapStopReason(status, incompleteReason);
		output.stopReason = mappedStop.stopReason;
		output.errorMessage = mappedStop.errorMessage;
		if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
			output.stopReason = "toolUse";
		}
	};

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			createSlot(event.output_index, event.item);
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.reasoning_summary_part.done") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += "\n\n";
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: "\n\n",
				partial: output,
			});
		} else if (event.type === "response.reasoning_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.output_text.delta") {
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.refusal.delta") {
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.function_call_arguments.delta") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			slot.block.partialJson += event.delta;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);
			pushToolCallDelta(slot, event.delta);
		} else if (event.type === "response.function_call_arguments.done") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			const previousPartialJson = slot.block.partialJson;
			slot.block.partialJson = event.arguments;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);

			if (event.arguments.startsWith(previousPartialJson)) {
				const delta = event.arguments.slice(previousPartialJson.length);
				if (delta.length > 0) pushToolCallDelta(slot, delta);
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || !slot.block.customInput) continue;
			pushToolCallDelta(
				slot,
				appendCustomToolCallInput(slot.block, getCustomToolCallInput(slot.block) + event.delta, false),
			);
		} else if (event.type === "response.custom_tool_call_input.done") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || !slot.block.customInput) continue;
			pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, event.input, true));
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			applyMessagePhaseStopReason(item);
			const slot = getOrCreateSlot(event.output_index, item);

			if (item.type === "reasoning" && slot?.type === "thinking") {
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				slot.block.thinking = summaryText || contentText || slot.block.thinking;
				slot.block.thinkingSignature = JSON.stringify(item);
				reasoningBlocksById.set(item.id, slot.block);
				stream.push({
					type: "thinking_end",
					contentIndex: slot.contentIndex,
					content: slot.block.thinking,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "message" && slot?.type === "text") {
				slot.block.text = item.content?.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("") || "";
				slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: slot.contentIndex,
					content: slot.block.text,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (
				item.type === "function_call" &&
				slot?.type === "toolCall" &&
				slot.block.partialJson !== undefined
			) {
				slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");
				// Finalize in-place and strip the scratch buffer so replay only
				// carries parsed arguments.
				delete slot.block.partialJson;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "custom_tool_call" && slot?.type === "toolCall" && slot.block.customInput) {
				pushToolCallDelta(
					slot,
					appendCustomToolCallInput(slot.block, item.input ?? getCustomToolCallInput(slot.block), true),
				);
				delete slot.block.customInput;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			finalizeResponse(event.response);
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			sawTerminalResponseEvent = true;
			output.rawStopReason = event.response?.status;
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}
	if (!sawTerminalResponseEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
}

function mapStopReason(
	status: OpenAI.Responses.ResponseStatus | undefined,
	incompleteReason?: string,
): { stopReason: StopReason; errorMessage?: string } {
	if (!status) return { stopReason: "stop" };
	switch (status) {
		case "completed":
			return { stopReason: "stop" };
		case "incomplete":
			if (incompleteReason === "max_output_tokens") {
				return { stopReason: "length" };
			}
			return {
				stopReason: "error",
				errorMessage: incompleteReason
					? `Response incomplete: ${incompleteReason}`
					: "Response incomplete without a provider reason",
			};
		case "failed":
		case "cancelled":
			return { stopReason: "error" };
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return { stopReason: "stop" };
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
