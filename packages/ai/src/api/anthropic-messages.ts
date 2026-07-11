import Anthropic from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
	RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/messages.js";
import { calculateCost } from "../models.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

import { splitSystemPromptForCache } from "./anthropic-cache-split.ts";
import { type ServerToolResultBlockLike, summarizeServerToolResult } from "./anthropic-server-tools.ts";
import { isLatestThinkingModifiedError, stripThinkingFromMessageParams } from "./anthropic-thinking-recovery.ts";
import {
	convertedToolCache,
	convertOneTool,
	hasDeferredTool,
	hasToolReferenceContent,
} from "./anthropic-tool-serialization.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	MIN_THINKING_BUDGET,
} from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * Resolve cache retention preference.
 * Defaults to "long"; set PI_CACHE_RETENTION=short or PI_CACHE_RETENTION=none to override process-wide.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	const envRetention = getProviderEnvValue("PI_CACHE_RETENTION", env);
	if (envRetention === "short" || envRetention === "none" || envRetention === "long") {
		return envRetention;
	}
	return "long";
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

function usesExtendedCacheTtl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): boolean {
	return getCacheControl(model, cacheRetention, env).cacheControl?.ttl === "1h";
}

// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.75";

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;

const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

// Anthropic has no structural tool-namespace object; grouping is a name-prefix
// convention (`github_`, `slack_`), and the deferred-tool flow requires that a
// `tool_reference.tool_name` EXACTLY matches a tool defined in `tools[]`. So when
// pi-tool-search stamps `tool.namespace`, we wire-prefix deferred tools as a full
// round-trip: tools[] defs, tool_reference blocks, replayed tool_use, and response
// dispatch all consult ONE pair of maps (built per request) so names always agree.
// Kill-switch (collapse to flat): PI_ANTHROPIC_NAMESPACE_WIRE=0. Flag-off / no
// namespace stamped => the maps are empty => byte-identical to before.
const namespaceWireEnabled = () => process.env.PI_ANTHROPIC_NAMESPACE_WIRE !== "0";
const toBaseToolName = (tool: Tool, isOAuth: boolean) => (isOAuth ? toClaudeCodeName(tool.name) : tool.name);
// Server tools (anthropicServerTool / server-side advisor) are emitted verbatim by
// convertOneTool BEFORE any name rewrite, so they must never be wire-prefixed.
// This mirrors convertOneTool's early-return conditions exactly.
const isAnthropicServerTool = (tool: Tool, model: Model<any>): boolean => {
	if (model.provider !== "claude-bridge") return false;
	if (tool.anthropicServerTool) return true;
	if (tool.name === "advisor") {
		const schema = tool.parameters as { properties?: { model?: { default?: string } } };
		const advisorModel = schema.properties?.model?.default;
		return typeof advisorModel === "string" && advisorModel.length > 0;
	}
	return false;
};
interface WireNameMaps {
	canonicalToWire: Map<string, string>;
	wireToCanonical: Map<string, string>;
}
// Authoritative per-request name maps. Collision-safe: every base name is reserved
// first, so a `<namespace>_<base>` prefix that would shadow another tool's name is
// skipped (the namespaced tool keeps its canonical name) rather than silently
// dropped by the convertTools `seenNames` dedup.
const buildWireNameMaps = (tools: Tool[] | undefined, model: Model<any>, isOAuth: boolean): WireNameMaps => {
	const canonicalToWire = new Map<string, string>();
	const wireToCanonical = new Map<string, string>();
	if (!tools || !namespaceWireEnabled()) return { canonicalToWire, wireToCanonical };
	const claimed = new Set(tools.map((tool) => toBaseToolName(tool, isOAuth)));
	for (const tool of tools) {
		if (!tool.namespace || isAnthropicServerTool(tool, model)) continue;
		const wire = `${tool.namespace}_${toBaseToolName(tool, isOAuth)}`;
		if (claimed.has(wire) || wireToCanonical.has(wire)) continue; // collision -> stay canonical
		claimed.add(wire);
		canonicalToWire.set(tool.name, wire);
		wireToCanonical.set(wire, tool.name);
	}
	return { canonicalToWire, wireToCanonical };
};

/**
 * Convert content blocks to Anthropic API format
 */
const ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function convertContentBlocks(
	content: (TextContent | ImageContent | { type: "tool_reference"; name: string })[],
	canonicalToWire?: Map<string, string>,
):
	| string
	| Array<
			| { type: "text"; text: string }
			| { type: "tool_reference"; tool_name: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	const hasToolReferences = content.some((c) => c.type === "tool_reference");
	if (hasToolReferences) {
		return content
			.filter((block): block is { type: "tool_reference"; name: string } => block.type === "tool_reference")
			.map((block) => ({
				type: "tool_reference" as const,
				tool_name: canonicalToWire?.get(block.name) ?? block.name,
			}));
	}

	// If only text blocks, return as concatenated string for simplicity
	const hasStructuredBlocks = content.some((c) => c.type === "image");
	if (!hasStructuredBlocks) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		if (block.type === "tool_reference") {
			return {
				type: "tool_reference" as const,
				tool_name: canonicalToWire?.get(block.name) ?? block.name,
			};
		}
		if (!ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES.has(block.mimeType)) {
			return {
				type: "text" as const,
				text: `[Unsupported image MIME ${block.mimeType}; image omitted from Anthropic request]`,
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

function stripToolReferencesFromContent(
	content: (TextContent | ImageContent | { type: "tool_reference"; name: string })[],
): ReturnType<typeof convertContentBlocks> {
	const filtered = content.filter((block) => block.type !== "tool_reference");
	if (filtered.length === 0) return "[Tool references removed - tool search not enabled]";
	return convertContentBlocks(filtered);
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const TOOL_SEARCH_BETA = "advanced-tool-use-2025-11-20";
const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";

function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<Omit<AnthropicMessagesCompat, "forceAdaptiveThinking">> {
	const modelSupportsDeferredTools = !model.id.toLowerCase().includes("haiku");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsDeferredTools: model.compat?.supportsDeferredTools ?? modelSupportsDeferredTools,
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? false,
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsToolReferences: model.compat?.supportsToolReferences ?? defaultSupportsToolReferences(model),
	};
}

/**
 * Default for `supportsToolReferences`: first-party Anthropic models except
 * Haiku (rejects client-side tool_reference blocks) and models that predate
 * tool search (Claude 3.x, Opus/Sonnet 4.0, Opus 4.1).
 */
function defaultSupportsToolReferences(model: Model<"anthropic-messages">): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For adaptive thinking models: the model decides when/how much to think.
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 * Default: undefined (thinking is omitted unless `streamSimple()` maps
	 * a simple reasoning level to this option, or callers set it explicitly).
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for adaptive thinking models.
	 * Default: 1024 when `thinkingEnabled` is true and no budget is provided.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking models.
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7+, Fable 5)
	 * - "high": Always thinks, deep reasoning
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 * Default: omitted unless `streamSimple()` maps a simple reasoning
	 * level to this option.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text.
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 * Default: "summarized" when thinking is enabled.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Whether to request the interleaved thinking beta header for non-adaptive
	 * thinking models. Adaptive thinking models have interleaved thinking built in,
	 * so the header is skipped for them regardless of this setting.
	 * Default: true.
	 */
	interleavedThinking?: boolean;
	/**
	 * Anthropic tool choice behavior. String values map to Anthropic's built-in
	 * choices; `{ type: "tool", name }` forces a specific tool.
	 * Default: omitted (Anthropic default behavior, currently equivalent to auto).
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function assertRequestAuth(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): void {
	if (apiKey) return;
	if (
		hasHeader(headers, "authorization") ||
		hasHeader(headers, "x-api-key") ||
		hasHeader(headers, "cf-aig-authorization")
	) {
		return;
	}
	throw new Error(`No API key for provider: ${provider}`);
}

function mergeHeadersWithAnthropicBetas(
	requiredBetas: string[],
	...headerSources: (Record<string, string | null> | undefined)[]
): Record<string, string | null> {
	const merged = mergeHeaders(...headerSources);
	const betaSet = new Set<string>();
	for (const [key, value] of Object.entries(merged)) {
		if (key.toLowerCase() !== "anthropic-beta") continue;
		if (typeof value !== "string") continue;
		for (const beta of value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean)) {
			betaSet.add(beta);
		}
		if (key !== "anthropic-beta") delete merged[key];
	}
	for (const beta of requiredBetas) betaSet.add(beta);
	if (betaSet.size > 0) merged["anthropic-beta"] = Array.from(betaSet).join(",");
	return merged;
}

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			let client: Anthropic;
			let isOAuth: boolean;

			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey;
				assertRequestAuth(model.provider, apiKey, options?.headers);

				let copilotDynamicHeaders: Record<string, string> | undefined;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(context.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages,
					});
				}

				const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
				const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;

				const created = createClient(
					model,
					apiKey,
					options?.interleavedThinking ?? true,
					shouldUseFineGrainedToolStreamingBeta(model, context),
					shouldUseToolSearchBeta(model, context),
					usesExtendedCacheTtl(model, options?.cacheRetention, options?.env),
					options?.headers,
					copilotDynamicHeaders,
					cacheSessionId,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			let params = buildParams(model, context, isOAuth, options);
			// Reverse map for response dispatch: a namespaced wire tool name (e.g.
			// `context_ctx_search`) must be stripped back to the canonical name the tool
			// is registered under, for BOTH OAuth and API-key requests. Empty when
			// namespacing is off => no behavior change.
			const { wireToCanonical } = buildWireNameMaps(context.tools, model, isOAuth);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as MessageCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? 0,
			};
			let response: Awaited<ReturnType<ReturnType<typeof client.messages.create>["asResponse"]>>;
			try {
				response = await client.messages.create({ ...params, stream: true }, requestOptions).asResponse();
			} catch (error) {
				// Graceful self-heal for the signed-thinking-block round-trip 400.
				// Anthropic rejects a request when a thinking/redacted_thinking block
				// in the latest assistant message does not byte-match what it signed
				// (drifted signature from a crashed/paused turn, post-compaction
				// replay, or content mutation). With no recovery this poisons every
				// subsequent request and wedges the session. Retry ONCE with all
				// thinking blocks stripped from history: Anthropic only validates
				// REPLAYED thinking blocks, so a request carrying none always passes,
				// and fresh thinking is still generated for the new turn. This is the
				// same drop the cross-model path in transformMessages already applies.
				// (#thinking-roundtrip)
				if (!isLatestThinkingModifiedError(error)) throw error;
				params = { ...params, messages: stripThinkingFromMessageParams(params.messages) };
				response = await client.messages.create({ ...params, stream: true }, requestOptions).asResponse();
			}
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			// Anthropic returns stop_reason "pause_turn" when a long-running
			// server-side tool (web_search / web_fetch / code_execution) needs
			// another turn to finish. Per the API contract the client must echo
			// the partial assistant message back unmodified to resume. If we
			// surfaced pause_turn as the final stop reason, the agent loop would
			// persist the partial turn to the session JSONL, and the next user
			// prompt (or auto-compaction) would replay it as the latest assistant
			// message. Any byte-level drift in a thinking signature on replay then
			// triggers a hard 400 ("`thinking` or `redacted_thinking` blocks in
			// the latest assistant message cannot be modified") that poisons every
			// subsequent request — including compaction — until the bad turn is
			// trimmed. Resolve pause_turn in-stream so callers only ever see a
			// completed turn. See `mapStopReason` and the signed-thinking-block
			// round-trip path below (~line 1163). (#thinking-roundtrip)
			let rawStopReason: string | undefined;
			let pauseResumeCount = 0;
			const MAX_PAUSE_TURN_RESUMES = 16;

			// Each Anthropic API call reports usage for THAT call only — not
			// cumulative across the logical assistant turn. message_start and
			// message_delta both overwrite `output.usage`, so without a carry-over
			// the resumed turn would only report the final call's tokens and
			// undercount cost by ~N× the resume count. We snapshot the completed
			// call's totals into `carryOverUsage` before each resume; the
			// per-event handlers then add the current call's tokens on top so
			// `output.usage` always reflects the full assistant turn.
			const carryOverUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };

			// Provider-executed (server-side) web tools (web_search/web_fetch) stream as
			// `server_tool_use` blocks whose input arrives via `input_json_delta`. We track
			// them here — keyed by content-block index — instead of in `output.content`, so
			// they never become agent-loop toolCalls, never round-trip to the API, and never
			// perturb the cache prefix. They are surfaced purely as display-only events.
			const serverToolUses = new Map<number, { id: string; name: string; partialJson: string; input: unknown }>();

			while (true) {
				for await (const event of iterateAnthropicEvents(response, options?.signal)) {
					if (event.type === "message_start") {
						output.responseId = event.message.id;
						// Capture initial token usage from message_start event
						// This ensures we have input token counts even if the stream is aborted early.
						// On pause_turn resumes, add to carryOverUsage so totals stay cumulative.
						output.usage.input = carryOverUsage.input + (event.message.usage.input_tokens || 0);
						output.usage.output = carryOverUsage.output + (event.message.usage.output_tokens || 0);
						output.usage.cacheRead =
							carryOverUsage.cacheRead + (event.message.usage.cache_read_input_tokens || 0);
						output.usage.cacheWrite =
							carryOverUsage.cacheWrite + (event.message.usage.cache_creation_input_tokens || 0);
						output.usage.cacheWrite1h =
							carryOverUsage.cacheWrite1h + (event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0);
						// Anthropic doesn't provide total_tokens, compute from components
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
					} else if (event.type === "content_block_start") {
						if (event.content_block.type === "text") {
							const block: Block = {
								type: "text",
								text: "",
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
						} else if (event.content_block.type === "thinking") {
							const block: Block = {
								type: "thinking",
								thinking: "",
								thinkingSignature: "",
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						} else if (event.content_block.type === "redacted_thinking") {
							const block: Block = {
								type: "thinking",
								thinking: "[Reasoning redacted]",
								thinkingSignature: event.content_block.data,
								redacted: true,
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						} else if (event.content_block.type === "tool_use") {
							const block: Block = {
								type: "toolCall",
								id: event.content_block.id,
								name: (() => {
									const canonical = wireToCanonical.get(event.content_block.name) ?? event.content_block.name;
									return isOAuth ? fromClaudeCodeName(canonical, context.tools) : canonical;
								})(),
								arguments: (event.content_block.input as Record<string, any>) ?? {},
								partialJson: "",
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
						} else if (event.content_block.type === "server_tool_use") {
							// Provider-executed web tool call. Record it; the query/url input
							// streams via input_json_delta and is emitted on content_block_stop.
							serverToolUses.set(event.index, {
								id: event.content_block.id,
								name: event.content_block.name,
								partialJson: "",
								input: event.content_block.input ?? {},
							});
						} else if (
							event.content_block.type === "web_search_tool_result" ||
							(event.content_block as { type?: string }).type === "web_fetch_tool_result" ||
							(event.content_block as { type?: string }).type === "advisor_tool_result"
						) {
							// Server-injected result block (full content present at start). Surface
							// a compact display-only summary; never stored in output.content.
							const resultBlock = event.content_block as unknown as ServerToolResultBlockLike;
							const summary = summarizeServerToolResult(resultBlock);
							stream.push({
								type: "server_tool_result",
								toolUseId: resultBlock.tool_use_id,
								toolName: summary.toolName,
								status: summary.status,
								sources: summary.sources,
								errorCode: summary.errorCode,
								partial: output,
							});
						}
					} else if (event.type === "content_block_delta") {
						if (event.delta.type === "text_delta") {
							const index = blocks.findIndex((b) => b.index === event.index);
							const block = blocks[index];
							if (block && block.type === "text") {
								block.text += event.delta.text;
								stream.push({
									type: "text_delta",
									contentIndex: index,
									delta: event.delta.text,
									partial: output,
								});
							}
						} else if (event.delta.type === "thinking_delta") {
							const index = blocks.findIndex((b) => b.index === event.index);
							const block = blocks[index];
							if (block && block.type === "thinking") {
								block.thinking += event.delta.thinking;
								stream.push({
									type: "thinking_delta",
									contentIndex: index,
									delta: event.delta.thinking,
									partial: output,
								});
							}
						} else if (event.delta.type === "input_json_delta") {
							const serverTool = serverToolUses.get(event.index);
							if (serverTool) {
								serverTool.partialJson += event.delta.partial_json;
							}
							const index = blocks.findIndex((b) => b.index === event.index);
							const block = blocks[index];
							if (block && block.type === "toolCall") {
								block.partialJson += event.delta.partial_json;
								block.arguments = parseStreamingJson(block.partialJson);
								stream.push({
									type: "toolcall_delta",
									contentIndex: index,
									delta: event.delta.partial_json,
									partial: output,
								});
							}
						} else if (event.delta.type === "signature_delta") {
							const index = blocks.findIndex((b) => b.index === event.index);
							const block = blocks[index];
							if (block && block.type === "thinking") {
								block.thinkingSignature = block.thinkingSignature || "";
								block.thinkingSignature += event.delta.signature;
							}
						}
					} else if (event.type === "content_block_stop") {
						const serverTool = serverToolUses.get(event.index);
						if (serverTool) {
							const parsedInput = (
								serverTool.partialJson ? parseStreamingJson(serverTool.partialJson) : (serverTool.input ?? {})
							) as Record<string, unknown>;
							stream.push({
								type: "server_tool_use",
								id: serverTool.id,
								toolName: serverTool.name,
								query: typeof parsedInput.query === "string" ? (parsedInput.query as string) : undefined,
								url: typeof parsedInput.url === "string" ? (parsedInput.url as string) : undefined,
								partial: output,
							});
							serverToolUses.delete(event.index);
						}
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block) {
							delete (block as any).index;
							if (block.type === "text") {
								stream.push({
									type: "text_end",
									contentIndex: index,
									content: block.text,
									partial: output,
								});
							} else if (block.type === "thinking") {
								stream.push({
									type: "thinking_end",
									contentIndex: index,
									content: block.thinking,
									partial: output,
								});
							} else if (block.type === "toolCall") {
								block.arguments = parseStreamingJson(block.partialJson);
								// Finalize in-place and strip the scratch buffer so replay only
								// carries parsed arguments.
								delete (block as { partialJson?: string }).partialJson;
								stream.push({
									type: "toolcall_end",
									contentIndex: index,
									toolCall: block,
									partial: output,
								});
							}
						}
					} else if (event.type === "message_delta") {
						if (event.delta.stop_reason) {
							rawStopReason = event.delta.stop_reason;
							const { stopReason, errorMessage } = mapStopReason(
								event.delta.stop_reason,
								event.delta.stop_details,
							);
							output.stopReason = stopReason;
							output.errorMessage = errorMessage;
						}
						// Only update usage fields if present (not null).
						// Preserves input_tokens from message_start when proxies omit it in message_delta.
						// On pause_turn resumes, add to carryOverUsage so totals stay cumulative.
						if (event.usage.input_tokens != null) {
							output.usage.input = carryOverUsage.input + event.usage.input_tokens;
						}
						if (event.usage.output_tokens != null) {
							output.usage.output = carryOverUsage.output + event.usage.output_tokens;
						}
						if (event.usage.cache_read_input_tokens != null) {
							output.usage.cacheRead = carryOverUsage.cacheRead + event.usage.cache_read_input_tokens;
						}
						if (event.usage.cache_creation_input_tokens != null) {
							output.usage.cacheWrite = carryOverUsage.cacheWrite + event.usage.cache_creation_input_tokens;
						}
						// Anthropic reports reasoning tokens in `output_tokens_details.thinking_tokens` on the
						// final message_delta usage (a subset of output_tokens). SDK 0.91.1 omits the field from
						// its Usage type, so read it through a narrow cast. Verified against the live API.
						const thinkingTokens = (event.usage as { output_tokens_details?: { thinking_tokens?: number } })
							.output_tokens_details?.thinking_tokens;
						if (thinkingTokens != null) {
							output.usage.reasoning = thinkingTokens;
						}
						// Anthropic doesn't provide total_tokens, compute from components
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
					}
				}

				if (rawStopReason !== "pause_turn" || options?.signal?.aborted) break;

				if (++pauseResumeCount > MAX_PAUSE_TURN_RESUMES) {
					throw new Error(
						`Anthropic pause_turn resume limit (${MAX_PAUSE_TURN_RESUMES}) exceeded; assistant turn did not complete`,
					);
				}

				// Defensive: content_block_stop should have cleared these scratch
				// fields, but a pause that ends mid-block must not leak `index` or
				// `partialJson` into the continuation payload.
				for (const block of output.content) {
					delete (block as { index?: number }).index;
					delete (block as { partialJson?: string }).partialJson;
				}

				// Echo the partial assistant turn back unmodified. transformMessages +
				// the signed-thinking-block branch in the assistant-block builder
				// round-trip thinking signatures byte-for-byte, which is what
				// Anthropic validates against on resume.
				const continuationContext: Context = {
					...context,
					messages: [
						...context.messages,
						{
							role: "assistant",
							content: output.content,
							api: output.api,
							provider: output.provider,
							model: output.model,
							usage: output.usage,
							stopReason: "stop",
							timestamp: output.timestamp,
						} satisfies AssistantMessage,
					],
				};

				let continuationParams = buildParams(model, continuationContext, isOAuth, options);
				const nextContinuation = await options?.onPayload?.(continuationParams, model);
				if (nextContinuation !== undefined) {
					continuationParams = nextContinuation as MessageCreateParamsStreaming;
				}

				// Snapshot the completed call's cumulative totals; the next call's
				// message_start/delta will add this call's contribution on top.
				carryOverUsage.input = output.usage.input;
				carryOverUsage.output = output.usage.output;
				carryOverUsage.cacheRead = output.usage.cacheRead;
				carryOverUsage.cacheWrite = output.usage.cacheWrite;
				carryOverUsage.cacheWrite1h = output.usage.cacheWrite1h ?? 0;

				rawStopReason = undefined;
				response = await client.messages
					.create({ ...continuationParams, stream: true }, requestOptions)
					.asResponse();
				await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				// Preserve the upstream stop reason: "refusal"/"sensitive" map to
				// "error" in mapStopReason, and a generic message both hides the
				// cause from the user and prevents the agent-session retry
				// classifier from distinguishing safety stops (never retry) from
				// transient stream drops (retryable).
				throw new Error(
					output.errorMessage ??
						(rawStopReason
							? `Provider ended turn with stop reason: ${rawStopReason}`
							: "Stream ended before message_stop"),
				);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is available on all adaptive-thinking Claude models, while native
 * "xhigh" is only available on Opus 4.7/4.8, Sonnet 5, and Fable 5.
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	assertRequestAuth(model.provider, options?.apiKey, options?.headers);

	const base = buildBaseOptions(model, context, options, options?.apiKey);
	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
	}

	// For models with adaptive thinking: use an effort level.
	// For older models: use budget-based thinking.
	if (model.compat?.forceAdaptiveThinking === true) {
		// Adaptive thinking self-regulates its budget and cannot be given an explicit
		// cap, so a clamped max_tokens (near-full context, or a small output cap) can
		// be consumed entirely by thinking — the turn ends with stopReason "length"
		// and zero visible output. When there isn't room for a meaningful thinking
		// budget plus an answer, disable thinking for this request. Mirrors the
		// budget-based floor guard below (which needs max_tokens >= 2 * the floor).
		if ((base.maxTokens ?? model.maxTokens) < MIN_THINKING_BUDGET * 2) {
			return stream(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
		}
		// "adaptive" level = fully unconstrained: send thinking.type=adaptive with no effort cap,
		// letting Claude self-regulate budget per turn.
		if (options.reasoning === "adaptive") {
			return stream(model, context, {
				...base,
				thinkingEnabled: true,
			} satisfies AnthropicOptions);
		}
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

	// A tiny output cap (e.g. a cheap single-task fork with maxOutputTokens ~1500)
	// or a near-full context can drive the computed thinking budget below
	// Anthropic's hard floor (budget_tokens must be >= 1024 and strictly below
	// max_tokens). Anthropic DROPS such a request as an empty completion instead
	// of erroring loudly, silently breaking the fork for no good reason. When
	// there is no room for a valid final budget, disable thinking for this request
	// rather than send an invalid sub-floor budget.
	const thinkingBudget = Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - MIN_THINKING_BUDGET));
	if (thinkingBudget < MIN_THINKING_BUDGET) {
		return stream(model, context, {
			...base,
			maxTokens,
			thinkingEnabled: false,
		} satisfies AnthropicOptions);
	}

	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: thinkingBudget,
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	useToolSearchBeta: boolean,
	useExtendedCacheTtlBeta: boolean,
	optionsHeaders?: ProviderHeaders,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models have interleaved thinking built in, so skip the beta header.
	const needsInterleavedBeta = interleavedThinking && model.compat?.forceAdaptiveThinking !== true;
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}
	if (useToolSearchBeta) {
		betaFeatures.push(TOOL_SEARCH_BETA);
	}
	if (useExtendedCacheTtlBeta) {
		betaFeatures.push(EXTENDED_CACHE_TTL_BETA);
	}

	// Copilot: Bearer auth, selective betas.
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey ?? null,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeadersWithAnthropicBetas(
				betaFeatures,
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers
	if (apiKey && isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeadersWithAnthropicBetas(
				["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures],
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key or header-owned auth.
	const sessionAffinityHeaders: ProviderHeaders =
		sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
	const client = new Anthropic({
		apiKey: apiKey ?? null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: mergeHeadersWithAnthropicBetas(
			betaFeatures,
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
			},
			sessionAffinityHeaders,
			model.headers,
			optionsHeaders,
		),
	});

	return { client, isOAuthToken: false };
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	const compat = getAnthropicCompat(model);
	// Single authoritative name map for this request — shared by tools[] and the
	// message/tool_reference serialization so wire names always agree.
	const { canonicalToWire } = buildWireNameMaps(context.tools, model, isOAuthToken);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(
			context.messages,
			model,
			isOAuthToken,
			cacheControl,
			compat.supportsDeferredTools,
			compat.allowEmptySignature,
			canonicalToWire,
		),
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
	};

	// For OAuth tokens, we MUST include Claude Code identity
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push(...splitSystemPromptForCache(context.systemPrompt, cacheControl));
		}
	} else if (context.systemPrompt) {
		// Add cache control to the stable system-prompt section only when a dynamic boundary is present.
		params.system = splitSystemPromptForCache(context.systemPrompt, cacheControl);
	}

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	if (options?.temperature !== undefined && !options?.thinkingEnabled && compat.supportsTemperature) {
		params.temperature = options.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		// Claude Code never puts cache_control on tools — only on system prompt
		// blocks and messages. Passing cacheControl here caused a conflict with
		// defer_loading tools (the API rejects both on the same tool definition).
		params.tools = convertTools(
			context.tools,
			model,
			isOAuthToken,
			compat.supportsEagerToolInputStreaming,
			compat.supportsDeferredTools,
			canonicalToWire,
		);
	}

	// Configure thinking mode: adaptive, budget-based, or explicitly disabled.
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
			// older Claude 4 models (whose API default is also "summarized").
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (model.compat?.forceAdaptiveThinking === true) {
				// Adaptive thinking: Claude decides when and how much to think.
				params.thinking = { type: "adaptive", display };
				if (options.effort) {
					// The Anthropic SDK types can lag newly supported effort values such as "xhigh".
					params.output_config =
						options.effort === "xhigh"
							? ({ effort: options.effort } as unknown as NonNullable<
									MessageCreateParamsStreaming["output_config"]
								>)
							: { effort: options.effort };
				}
			} else {
				// Budget-based thinking for older models
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
			params.thinking = { type: "disabled" };
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	} else if (context.tools?.length && (model.provider === "anthropic" || model.provider === "claude-bridge")) {
		params.tool_choice = {
			type: "auto",
			disable_parallel_tool_use: false,
		} as MessageCreateParamsStreaming["tool_choice"];
	}

	return params;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	supportsDeferredTools = true,
	allowEmptySignature = false,
	canonicalToWire?: Map<string, string>,
): MessageParam[] {
	const params: MessageParam[] = [];

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					const hasSignature = !!block.thinkingSignature && block.thinkingSignature.trim().length > 0;
					// A thinking block with a valid signature MUST be round-tripped to the API
					// unmodified, even when its thinking text is empty (e.g. thinkingDisplay:"omitted"
					// on Opus 4.7 / Mythos Preview). Dropping it changes the latest assistant
					// message's content array and Anthropic rejects the next request with
					// 400 "thinking or redacted_thinking blocks in the latest assistant message
					// cannot be modified" — which also breaks auto-compaction (#thinking-roundtrip).
					if (hasSignature) {
						// Do not run sanitizeSurrogates on signed thinking text — the signature
						// is validated against the original bytes Anthropic streamed. Any rewrite
						// (even of an unpaired surrogate) would break round-trip validation.
						blocks.push({
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature as string,
						});
						continue;
					}
					// No signature (e.g. aborted stream): we can't round-trip as a thinking block.
					// Drop empty text entirely. For non-empty text, convert to a plain text block
					// so the model doesn't start mimicking <thinking> tags in subsequent turns —
					// unless this model is marked allowEmptySignature (some compatible providers
					// emit and accept empty signatures), in which case keep it as a thinking block.
					if (block.thinking.trim().length === 0) continue;
					blocks.push(
						allowEmptySignature
							? {
									type: "thinking",
									thinking: sanitizeSurrogates(block.thinking),
									signature: "",
								}
							: {
									type: "text",
									text: sanitizeSurrogates(block.thinking),
								},
					);
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: canonicalToWire?.get(block.name) ?? (isOAuthToken ? toClaudeCodeName(block.name) : block.name),
						input: block.arguments ?? {},
					});
				} else if (block.type === "tool_reference" && supportsDeferredTools) {
					blocks.push({
						type: "tool_reference",
						tool_name: canonicalToWire?.get(block.name) ?? block.name,
					} as unknown as ContentBlockParam);
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint.
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: supportsDeferredTools
					? convertContentBlocks(msg.content, canonicalToWire)
					: stripToolReferencesFromContent(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: supportsDeferredTools
						? convertContentBlocks(nextMsg.content, canonicalToWire)
						: stripToolReferencesFromContent(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

function shouldUseToolSearchBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	if (!getAnthropicCompat(model).supportsDeferredTools) return false;
	return hasDeferredTool(context) || hasToolReferenceContent(context);
}

function convertTools(
	tools: Tool[],
	model: Model<any>,
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	supportsDeferredTools: boolean,
	canonicalToWire?: Map<string, string>,
): Anthropic.Messages.ToolUnion[] {
	if (!tools) return [];

	const convertedTools: Anthropic.Messages.ToolUnion[] = [];
	const seenNames = new Set<string>();
	for (const tool of tools) {
		const deferLoading = !!(supportsDeferredTools && tool.deferLoading && !tool.alwaysLoad);
		// Resolved wire name (collision-safe, server-tool-excluded) comes from the
		// single authoritative map. It joins the cache key so flipping the namespace
		// kill-switch (or a tool gaining/losing a namespace) can't return a stale name.
		const wireName = canonicalToWire?.get(tool.name) ?? toBaseToolName(tool, isOAuthToken);
		const flagKey = `${model.provider}|${isOAuthToken ? 1 : 0}|${supportsEagerToolInputStreaming ? 1 : 0}|${deferLoading ? 1 : 0}|${wireName}`;
		let perToolMap = convertedToolCache.get(tool);
		if (!perToolMap) {
			perToolMap = new Map();
			convertedToolCache.set(tool, perToolMap);
		}
		let cached = perToolMap.get(flagKey);
		if (!cached) {
			cached = convertOneTool(tool, model, supportsEagerToolInputStreaming, deferLoading, wireName);
			perToolMap.set(flagKey, cached);
		}
		if (seenNames.has(cached.name)) continue;
		seenNames.add(cached.name);
		convertedTools.push(cached);
	}
	return convertedTools;
}

function mapStopReason(
	reason: Anthropic.Messages.StopReason | string,
	stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
			};
		case "pause_turn":
			// pause_turn is resolved inside `stream` by echoing the
			// partial assistant turn back to Anthropic until a real terminal
			// reason arrives. If anything ever bypasses that loop (e.g. a
			// caller wiring `mapStopReason` directly), surface it as "stop"
			// so the agent loop at least halts cleanly instead of looping on
			// an unknown value. (#thinking-roundtrip)
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return { stopReason: "error" };
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
