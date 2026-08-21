/**
 * Resident session pruning (fork-owned).
 *
 * After a compaction boundary, the summarized span's payloads are stubbed in
 * resident memory to bound heap usage. The durable JSONL transcript is never
 * rewritten — pruning affects only hydrated/in-memory entries.
 *
 * Two paths:
 * - In-memory prune of an already-hydrated branch: {@link pruneResidentHistory}
 *   (called by SessionManager.pruneResidentHistoryAfterCompaction).
 * - Load-time prune plan built from raw JSONL line metadata without parsing
 *   full payloads: {@link buildResidentLoadPrunePlan} + {@link stubResidentEntryPayload}
 *   (called by loadEntriesFromFile).
 *
 * Also hosts {@link readSessionFileLines}, the streaming JSONL line reader
 * shared with SessionManager hydration.
 *
 * Fork provenance: extracted verbatim from session-manager.ts (fork-delta
 * reforge slice 1); tier `platform` in pi-fork-patch-inventory.
 */
import type { AgentMessage } from "@lue-labs/pi-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	StopReason,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "@lue-labs/pi-ai";
import { closeSync, openSync, readSync } from "fs";
import { StringDecoder } from "string_decoder";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { CompactionEntry, SessionEntry, SessionHydrationOptions } from "./session-manager.ts";

export interface ResidentPruneOptions {
	/** Stub summarized pre-compaction session entries in resident memory. Durable JSONL is not rewritten. */
	stubSummarizedEntries?: boolean;
	/** Stub old tool-result payloads only when their tool-call pair is also summarized. */
	stubToolResults?: boolean;
}

export interface ResidentPruneResult {
	compactionId: string | undefined;
	firstKeptEntryId: string | undefined;
	entriesVisited: number;
	entriesStubbed: number;
	protectedEntries: number;
	payloadBytesBefore: number;
	payloadBytesAfter: number;
	payloadBytesFreed: number;
	jsonlUnchanged: true;
}

export function resolveResidentPruneOptions(options: ResidentPruneOptions = {}): Required<ResidentPruneOptions> {
	return {
		stubSummarizedEntries: options.stubSummarizedEntries ?? true,
		stubToolResults: options.stubToolResults ?? true,
	};
}

export function shouldPruneResidentOnHydration(options: SessionHydrationOptions | undefined): boolean {
	return options?.residentPrune === true || process.env.PI_RESIDENT_SESSION_PRUNE === "1";
}

const RESIDENT_PRUNED_TEXT =
	"[Resident session payload pruned after compaction; full content remains in the durable session transcript.]";

function jsonByteLength(value: unknown): number {
	if (value === undefined) return 0;
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return Buffer.byteLength(String(value), "utf8");
	}
}

function estimateEntryPayloadBytes(entry: SessionEntry): number {
	switch (entry.type) {
		case "message":
			return jsonByteLength(entry.message);
		case "custom_message":
			return jsonByteLength(entry.content) + jsonByteLength(entry.details);
		case "custom":
			return jsonByteLength(entry.data);
		case "compaction":
			return jsonByteLength(entry.summary) + jsonByteLength(entry.details);
		case "branch_summary":
			return jsonByteLength(entry.summary) + jsonByteLength(entry.details);
		case "label":
			return jsonByteLength(entry.label);
		case "model_change":
			return jsonByteLength(entry.provider) + jsonByteLength(entry.modelId);
		case "thinking_level_change":
			return jsonByteLength(entry.thinkingLevel);
		case "session_info":
			return jsonByteLength(entry.name);
	}
}

export function estimateResidentPayloadBytes(entries: SessionEntry[]): number {
	return entries.reduce((total, entry) => total + estimateEntryPayloadBytes(entry), 0);
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
	return message.role === "toolResult";
}

function toolCallsForEntry(entry: SessionEntry): ToolCall[] {
	if (entry.type !== "message" || !isAssistantMessage(entry.message) || !Array.isArray(entry.message.content))
		return [];
	return entry.message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function collectToolPairEntryIds(path: SessionEntry[]): {
	toolCallEntryIds: Map<string, string>;
	toolResultEntryIds: Map<string, string>;
} {
	const toolCallEntryIds = new Map<string, string>();
	const toolResultEntryIds = new Map<string, string>();
	for (const entry of path) {
		if (entry.type !== "message") continue;
		for (const toolCall of toolCallsForEntry(entry)) {
			toolCallEntryIds.set(toolCall.id, entry.id);
		}
		if (isToolResultMessage(entry.message)) {
			toolResultEntryIds.set(entry.message.toolCallId, entry.id);
		}
	}
	return { toolCallEntryIds, toolResultEntryIds };
}

function entryHasProtectedToolPair(
	entry: SessionEntry,
	candidateIds: ReadonlySet<string>,
	toolPairs: ReturnType<typeof collectToolPairEntryIds>,
): boolean {
	if (entry.type !== "message") return false;
	if (isAssistantMessage(entry.message)) {
		for (const toolCall of toolCallsForEntry(entry)) {
			const toolResultEntryId = toolPairs.toolResultEntryIds.get(toolCall.id);
			if (!toolResultEntryId || !candidateIds.has(toolResultEntryId)) {
				return true;
			}
		}
	}
	if (isToolResultMessage(entry.message)) {
		const toolCallEntryId = toolPairs.toolCallEntryIds.get(entry.message.toolCallId);
		if (!toolCallEntryId || !candidateIds.has(toolCallEntryId)) {
			return true;
		}
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keepRecoverableDetails(details: unknown): Record<string, unknown> | undefined {
	if (!isRecord(details)) return undefined;
	const retained: Record<string, unknown> = {};
	for (const key of ["recoverableOutput", "fullOutputPath", "outputPath", "outputFile", "rawOutputPath"]) {
		if (key in details) {
			retained[key] = details[key];
		}
	}
	return Object.keys(retained).length > 0 ? retained : undefined;
}

function stubUserContent(content: string | (TextContent | ImageContent)[]): string | TextContent[] {
	if (typeof content === "string") return RESIDENT_PRUNED_TEXT;
	return [{ type: "text", text: RESIDENT_PRUNED_TEXT }];
}

function stubAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (!Array.isArray(message.content)) {
		return { ...message, content: [{ type: "text", text: RESIDENT_PRUNED_TEXT }] };
	}
	return {
		...message,
		content: message.content.map((block) => {
			if (block.type === "toolCall") {
				return { type: "toolCall", id: block.id, name: block.name, arguments: { residentPruned: true } };
			}
			if (block.type === "thinking") {
				return { type: "thinking", thinking: RESIDENT_PRUNED_TEXT };
			}
			if (block.type === "tool_reference") {
				return block;
			}
			return { type: "text", text: RESIDENT_PRUNED_TEXT };
		}),
	};
}

function stubToolResultMessage(message: ToolResultMessage): ToolResultMessage {
	return {
		...message,
		content: [{ type: "text", text: RESIDENT_PRUNED_TEXT }],
		details: keepRecoverableDetails(message.details),
	};
}

function stubSessionMessage(message: AgentMessage): AgentMessage {
	if (message.role === "user") {
		return { ...message, content: stubUserContent(message.content) };
	}
	if (isAssistantMessage(message)) {
		return stubAssistantMessage(message);
	}
	if (isToolResultMessage(message)) {
		return stubToolResultMessage(message);
	}
	if (message.role === "bashExecution") {
		return { ...message, output: RESIDENT_PRUNED_TEXT };
	}
	if (message.role === "custom") {
		return {
			...message,
			content: stubUserContent(message.content),
			details: keepRecoverableDetails(message.details),
		};
	}
	return message;
}

export function stubResidentEntryPayload(entry: SessionEntry, options: Required<ResidentPruneOptions>): boolean {
	if (entry.type === "message") {
		if (!options.stubToolResults && isToolResultMessage(entry.message)) return false;
		entry.message = stubSessionMessage(entry.message);
		return true;
	}
	if (entry.type === "custom_message" && options.stubSummarizedEntries) {
		entry.content = stubUserContent(entry.content);
		entry.details = keepRecoverableDetails(entry.details);
		return true;
	}
	if (entry.type === "branch_summary" && options.stubSummarizedEntries) {
		entry.summary = RESIDENT_PRUNED_TEXT;
		entry.details = keepRecoverableDetails(entry.details);
		return true;
	}
	if (entry.type === "compaction" && options.stubSummarizedEntries) {
		entry.summary = RESIDENT_PRUNED_TEXT;
		entry.details = keepRecoverableDetails(entry.details);
		return true;
	}
	return false;
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

export function readSessionFileLines(filePath: string, onLine: (line: string) => void): void {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = "";

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				onLine(pending.slice(lineStart, newlineIndex));
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		if (pending.trim()) onLine(pending);
	} finally {
		closeSync(fd);
	}
}

export type SessionEntryMetadata = {
	id: string;
	parentId: string | null;
	type: SessionEntry["type"];
	timestamp: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	messageRole?: string;
	api?: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	isError?: boolean;
	customType?: string;
	display?: boolean;
	fromId?: string;
	command?: string;
	toolCallIds: string[];
	toolResultCallId?: string;
	toolName?: string;
};

export type ResidentLoadPrunePlan = {
	candidateIds: Set<string>;
	protectedIds: Set<string>;
	rawStubs: Map<string, SessionEntry>;
};

const JSON_STRING_VALUE = String.raw`"((?:[^"\\]|\\.)*)"`;

function decodeJsonStringLiteral(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(`"${raw}"`) as string;
	} catch {
		return undefined;
	}
}

function extractJsonStringField(line: string, field: string): string | undefined {
	const match = new RegExp(String.raw`"${field}"\s*:\s*${JSON_STRING_VALUE}`).exec(line);
	return decodeJsonStringLiteral(match?.[1]);
}

function extractLastJsonStringField(line: string, field: string): string | undefined {
	const matches = [...line.matchAll(new RegExp(String.raw`"${field}"\s*:\s*${JSON_STRING_VALUE}`, "g"))];
	return decodeJsonStringLiteral(matches.at(-1)?.[1]);
}

function extractJsonNullableStringField(line: string, field: string): string | null | undefined {
	const match = new RegExp(String.raw`"${field}"\s*:\s*(null|${JSON_STRING_VALUE})`).exec(line);
	if (!match) return undefined;
	if (match[1] === "null") return null;
	return decodeJsonStringLiteral(match[2]);
}

function extractJsonNumberField(line: string, field: string): number | undefined {
	const match = new RegExp(String.raw`"${field}"\s*:\s*(-?\d+(?:\.\d+)?)`).exec(line);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : undefined;
}

function extractJsonBooleanField(line: string, field: string): boolean | undefined {
	const match = new RegExp(String.raw`"${field}"\s*:\s*(true|false)`).exec(line);
	if (!match) return undefined;
	return match[1] === "true";
}

function isSessionEntryType(type: string | undefined): type is SessionEntry["type"] {
	return (
		type === "message" ||
		type === "thinking_level_change" ||
		type === "model_change" ||
		type === "compaction" ||
		type === "branch_summary" ||
		type === "custom" ||
		type === "custom_message" ||
		type === "label" ||
		type === "session_info"
	);
}

function extractMessageRole(line: string): string | undefined {
	const match = new RegExp(String.raw`"message"\s*:\s*\{\s*"role"\s*:\s*${JSON_STRING_VALUE}`).exec(line);
	return decodeJsonStringLiteral(match?.[1]);
}

function extractToolCallIds(line: string): string[] {
	const ids: string[] = [];
	const matches = line.matchAll(/"type"\s*:\s*"toolCall"/g);
	for (const match of matches) {
		const start = match.index ?? 0;
		const nearbyObject = line.slice(start, Math.min(line.length, start + 2048));
		const id = extractJsonStringField(nearbyObject, "id");
		if (id) ids.push(id);
	}
	return ids;
}

export function metadataForSessionLine(line: string): SessionEntryMetadata | "session" | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	const type = extractJsonStringField(trimmed, "type");
	if (type === "session") return "session";
	if (!isSessionEntryType(type)) return undefined;

	const id = extractJsonStringField(trimmed, "id");
	const parentId = extractJsonNullableStringField(trimmed, "parentId");
	const timestamp = extractJsonStringField(trimmed, "timestamp");
	if (!id || parentId === undefined || !timestamp) return undefined;

	return {
		id,
		parentId,
		type,
		timestamp,
		firstKeptEntryId: type === "compaction" ? extractJsonStringField(trimmed, "firstKeptEntryId") : undefined,
		tokensBefore: type === "compaction" ? extractJsonNumberField(trimmed, "tokensBefore") : undefined,
		messageRole: type === "message" ? extractMessageRole(trimmed) : undefined,
		api: type === "message" ? extractJsonStringField(trimmed, "api") : undefined,
		provider: type === "message" ? extractLastJsonStringField(trimmed, "provider") : undefined,
		model: type === "message" ? extractLastJsonStringField(trimmed, "model") : undefined,
		stopReason: type === "message" ? extractJsonStringField(trimmed, "stopReason") : undefined,
		isError: type === "message" ? extractJsonBooleanField(trimmed, "isError") : undefined,
		customType:
			type === "message" || type === "custom" || type === "custom_message"
				? extractJsonStringField(trimmed, "customType")
				: undefined,
		display:
			type === "message" || type === "custom_message" ? extractJsonBooleanField(trimmed, "display") : undefined,
		fromId: type === "branch_summary" ? extractJsonStringField(trimmed, "fromId") : undefined,
		command: type === "message" ? extractJsonStringField(trimmed, "command") : undefined,
		toolCallIds: type === "message" ? extractToolCallIds(trimmed) : [],
		toolResultCallId: type === "message" ? extractJsonStringField(trimmed, "toolCallId") : undefined,
		toolName: type === "message" ? extractJsonStringField(trimmed, "toolName") : undefined,
	};
}

function metadataTimestampMs(metadata: SessionEntryMetadata): number {
	const value = Date.parse(metadata.timestamp);
	return Number.isFinite(value) ? value : Date.now();
}

function rawStubContent(): TextContent[] {
	return [{ type: "text", text: RESIDENT_PRUNED_TEXT }];
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function isStopReason(value: string | undefined): value is StopReason {
	return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}

function rawAssistantStopReason(metadata: SessionEntryMetadata): StopReason {
	if (isStopReason(metadata.stopReason)) return metadata.stopReason;
	return metadata.toolCallIds.length > 0 ? "toolUse" : "stop";
}

function stubEntryFromRawMetadata(
	metadata: SessionEntryMetadata,
	options: Required<ResidentPruneOptions>,
): SessionEntry | undefined {
	const base = { id: metadata.id, parentId: metadata.parentId, timestamp: metadata.timestamp };
	const timestamp = metadataTimestampMs(metadata);

	if (metadata.type === "message") {
		if (metadata.messageRole === "user") {
			return {
				...base,
				type: "message",
				message: { role: "user", content: rawStubContent(), timestamp } as AgentMessage,
			};
		}
		if (metadata.messageRole === "assistant") {
			if (!metadata.api || !metadata.provider || !metadata.model) return undefined;
			const toolCalls = metadata.toolCallIds.map((id) => ({
				type: "toolCall" as const,
				id,
				name: "resident_pruned",
				arguments: { residentPruned: true },
			}));
			return {
				...base,
				type: "message",
				message: {
					role: "assistant",
					content: [...rawStubContent(), ...toolCalls],
					api: metadata.api,
					provider: metadata.provider,
					model: metadata.model,
					usage: zeroUsage(),
					stopReason: rawAssistantStopReason(metadata),
					timestamp,
				} as AgentMessage,
			};
		}
		if (metadata.messageRole === "toolResult") {
			if (!options.stubToolResults || !metadata.toolResultCallId) return undefined;
			return {
				...base,
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: metadata.toolResultCallId,
					toolName: metadata.toolName ?? "resident_pruned",
					content: rawStubContent(),
					isError: metadata.isError ?? false,
					timestamp,
				} as AgentMessage,
			};
		}
		if (metadata.messageRole === "bashExecution") {
			return {
				...base,
				type: "message",
				message: {
					role: "bashExecution",
					command: metadata.command ?? "resident-pruned",
					output: RESIDENT_PRUNED_TEXT,
					exitCode: undefined,
					cancelled: false,
					truncated: true,
					timestamp,
				} as BashExecutionMessage,
			};
		}
		if (metadata.messageRole === "custom") {
			return {
				...base,
				type: "message",
				message: {
					role: "custom",
					customType: metadata.customType ?? "resident_pruned",
					content: rawStubContent(),
					display: metadata.display ?? false,
					timestamp,
				} as CustomMessage,
			};
		}
		return undefined;
	}

	if (metadata.type === "custom_message" && options.stubSummarizedEntries) {
		return {
			...base,
			type: "custom_message",
			customType: metadata.customType ?? "resident_pruned",
			content: rawStubContent(),
			display: metadata.display ?? false,
		};
	}
	if (metadata.type === "branch_summary" && options.stubSummarizedEntries && metadata.fromId) {
		return { ...base, type: "branch_summary", fromId: metadata.fromId, summary: RESIDENT_PRUNED_TEXT };
	}
	if (metadata.type === "compaction" && options.stubSummarizedEntries && metadata.firstKeptEntryId) {
		return {
			...base,
			type: "compaction",
			summary: RESIDENT_PRUNED_TEXT,
			firstKeptEntryId: metadata.firstKeptEntryId,
			tokensBefore: metadata.tokensBefore ?? 0,
		};
	}

	return undefined;
}

export function buildResidentLoadPrunePlan(
	filePath: string,
	options: Required<ResidentPruneOptions>,
): ResidentLoadPrunePlan | undefined {
	const metadata: SessionEntryMetadata[] = [];
	const byId = new Map<string, SessionEntryMetadata>();
	const toolCallEntryIds = new Map<string, string>();
	const toolResultEntryIds = new Map<string, string>();
	let sawInvalidMetadata = false;

	readSessionFileLines(filePath, (line) => {
		const item = metadataForSessionLine(line);
		if (item === "session") return;
		if (!item) {
			if (line.trim()) sawInvalidMetadata = true;
			return;
		}
		metadata.push(item);
		byId.set(item.id, item);
		for (const toolCallId of item.toolCallIds) {
			toolCallEntryIds.set(toolCallId, item.id);
		}
		if (item.toolResultCallId) {
			toolResultEntryIds.set(item.toolResultCallId, item.id);
		}
	});
	if (sawInvalidMetadata) return undefined;

	const leaf = metadata.at(-1);
	if (!leaf) return undefined;

	const path: SessionEntryMetadata[] = [];
	let current: SessionEntryMetadata | undefined = leaf;
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}

	let compactionIndex = -1;
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	const compaction = path[compactionIndex];
	if (!compaction?.firstKeptEntryId) return undefined;

	const firstKeptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) return undefined;

	const candidates = path.slice(0, firstKeptIndex);
	const candidateIds = new Set(candidates.map((entry) => entry.id));
	const protectedIds = new Set<string>();

	for (const entry of candidates) {
		for (const toolCallId of entry.toolCallIds) {
			const toolResultEntryId = toolResultEntryIds.get(toolCallId);
			if (!toolResultEntryId || !candidateIds.has(toolResultEntryId)) {
				protectedIds.add(entry.id);
			}
		}
		if (entry.toolResultCallId) {
			const toolCallEntryId = toolCallEntryIds.get(entry.toolResultCallId);
			if (!toolCallEntryId || !candidateIds.has(toolCallEntryId)) {
				protectedIds.add(entry.id);
			}
		}
	}

	const rawStubs = new Map<string, SessionEntry>();
	for (const entry of candidates) {
		if (protectedIds.has(entry.id)) continue;
		const stub = stubEntryFromRawMetadata(entry, options);
		if (stub) rawStubs.set(entry.id, stub);
	}

	return { candidateIds, protectedIds, rawStubs };
}

/**
 * Stub resident-only payloads from the summarized span before a compaction boundary.
 * Operates on already-hydrated entries in place; the durable JSONL is never rewritten.
 *
 * @param entries All session entries (for payload byte accounting).
 * @param path The current branch (root -> leaf) whose summarized span is pruned.
 */
export function pruneResidentHistory(
	entries: SessionEntry[],
	path: SessionEntry[],
	compactionId: string | undefined,
	options: ResidentPruneOptions = {},
): ResidentPruneResult {
	const pruneOptions = resolveResidentPruneOptions(options);
	const payloadBytesBefore = estimateResidentPayloadBytes(entries);
	const compactionIndex = compactionId
		? path.findIndex((entry) => entry.type === "compaction" && entry.id === compactionId)
		: (() => {
				for (let i = path.length - 1; i >= 0; i--) {
					if (path[i].type === "compaction") return i;
				}
				return -1;
			})();
	const compactionEntry = path[compactionIndex] as CompactionEntry | undefined;
	if (!compactionEntry || compactionEntry.type !== "compaction") {
		return {
			compactionId,
			firstKeptEntryId: undefined,
			entriesVisited: 0,
			entriesStubbed: 0,
			protectedEntries: 0,
			payloadBytesBefore,
			payloadBytesAfter: payloadBytesBefore,
			payloadBytesFreed: 0,
			jsonlUnchanged: true,
		};
	}

	const firstKeptIndex = path.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId);
	if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) {
		return {
			compactionId: compactionEntry.id,
			firstKeptEntryId: compactionEntry.firstKeptEntryId,
			entriesVisited: 0,
			entriesStubbed: 0,
			protectedEntries: 0,
			payloadBytesBefore,
			payloadBytesAfter: payloadBytesBefore,
			payloadBytesFreed: 0,
			jsonlUnchanged: true,
		};
	}

	const candidates = path.slice(0, firstKeptIndex);
	const candidateIds = new Set(candidates.map((entry) => entry.id));
	const toolPairs = collectToolPairEntryIds(path);
	let entriesStubbed = 0;
	let protectedEntries = 0;

	for (const entry of candidates) {
		if (entryHasProtectedToolPair(entry, candidateIds, toolPairs)) {
			protectedEntries++;
			continue;
		}
		const entryBytesBefore = estimateEntryPayloadBytes(entry);
		if (stubResidentEntryPayload(entry, pruneOptions) && estimateEntryPayloadBytes(entry) < entryBytesBefore) {
			entriesStubbed++;
		}
	}

	const payloadBytesAfter = estimateResidentPayloadBytes(entries);
	return {
		compactionId: compactionEntry.id,
		firstKeptEntryId: compactionEntry.firstKeptEntryId,
		entriesVisited: candidates.length,
		entriesStubbed,
		protectedEntries,
		payloadBytesBefore,
		payloadBytesAfter,
		payloadBytesFreed: Math.max(0, payloadBytesBefore - payloadBytesAfter),
		jsonlUnchanged: true,
	};
}
