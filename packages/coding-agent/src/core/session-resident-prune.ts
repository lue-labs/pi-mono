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
import type { AgentMessage } from "@valkyriweb/pi-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	StopReason,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "@valkyriweb/pi-ai";
import { closeSync, openSync, readSync } from "fs";
import { StringDecoder } from "string_decoder";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { CompactionEntry, RetainedSuffix, SessionEntry, SessionHydrationOptions } from "./session-manager.ts";

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
		case "user_handoff":
			return jsonByteLength(entry.content);
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
	retainedSuffix?: RetainedSuffix;
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
		type === "user_handoff" ||
		type === "label" ||
		type === "session_info"
	);
}

/** Shared structural validator for durable entries, including entries embedded in atomic units. */
export function isValidSessionEntryRecord(entry: unknown): entry is SessionEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const value = entry as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		(value.parentId !== null && (typeof value.parentId !== "string" || value.parentId.length === 0)) ||
		typeof value.timestamp !== "string"
	) {
		return false;
	}

	switch (value.type) {
		case "message": {
			const message = value.message;
			return (
				typeof message === "object" && message !== null && "role" in message && typeof message.role === "string"
			);
		}
		case "thinking_level_change":
			return typeof value.thinkingLevel === "string";
		case "model_change":
			return typeof value.provider === "string" && typeof value.modelId === "string";
		case "compaction": {
			const hasRetainedSuffix = Object.hasOwn(value, "retainedSuffix");
			const retainedSuffix = value.retainedSuffix;
			const hasValidRetainedSuffix =
				isRecord(retainedSuffix) &&
				((retainedSuffix.kind === "none" && !Object.hasOwn(retainedSuffix, "firstEntryId")) ||
					(retainedSuffix.kind === "from-entry" &&
						typeof retainedSuffix.firstEntryId === "string" &&
						retainedSuffix.firstEntryId.length > 0));
			const firstKeptEntryId = value.firstKeptEntryId;
			const hasLegacySuffix = typeof firstKeptEntryId === "string" && firstKeptEntryId.length > 0;
			if (hasRetainedSuffix && !hasValidRetainedSuffix) return false;
			if (firstKeptEntryId !== undefined && !hasLegacySuffix) return false;
			if (!hasRetainedSuffix && !hasLegacySuffix) return false;
			if (hasValidRetainedSuffix) {
				if (retainedSuffix.kind === "none" && firstKeptEntryId !== undefined) return false;
				if (
					retainedSuffix.kind === "from-entry" &&
					firstKeptEntryId !== undefined &&
					firstKeptEntryId !== retainedSuffix.firstEntryId
				) {
					return false;
				}
			}
			return typeof value.summary === "string" && Number.isFinite(value.tokensBefore);
		}
		case "branch_summary":
			return typeof value.fromId === "string" && typeof value.summary === "string";
		case "custom":
			return typeof value.customType === "string";
		case "custom_message":
			return (
				typeof value.customType === "string" &&
				(typeof value.content === "string" || Array.isArray(value.content)) &&
				typeof value.display === "boolean"
			);
		case "user_handoff":
			return typeof value.content === "string" || Array.isArray(value.content);
		case "label":
			return typeof value.targetId === "string" && (value.label === undefined || typeof value.label === "string");
		case "session_info":
			return value.name === undefined || typeof value.name === "string";
		default:
			return false;
	}
}

function isSessionUnitPrimaryEntryRecord(entry: SessionEntry): boolean {
	return (
		entry.type === "custom" ||
		entry.type === "branch_summary" ||
		entry.type === "user_handoff" ||
		entry.type === "compaction"
	);
}

export interface SessionUnitValidationContext {
	knownEntries: ReadonlyMap<string, { readonly parentId: string | null }>;
	knownUnitIds?: ReadonlySet<string>;
	knownActionIds?: ReadonlySet<string>;
}

function isEntryOnKnownBranch(
	entryId: string,
	leafId: string | null,
	knownEntries: ReadonlyMap<string, { readonly parentId: string | null }>,
): boolean {
	const visited = new Set<string>();
	let currentId = leafId;
	while (currentId) {
		if (currentId === entryId) return true;
		if (visited.has(currentId)) return false;
		visited.add(currentId);
		const current = knownEntries.get(currentId);
		if (!current) return false;
		currentId = current.parentId;
	}
	return false;
}

/** Validate a compaction suffix against the branch ending at its parent. */
export function isValidCompactionEntryContext(
	entry: CompactionEntry,
	knownEntries: ReadonlyMap<string, { readonly parentId: string | null }>,
): boolean {
	if (entry.parentId !== null && !knownEntries.has(entry.parentId)) return false;
	const firstRetainedEntryId =
		entry.retainedSuffix?.kind === "from-entry"
			? entry.retainedSuffix.firstEntryId
			: entry.retainedSuffix?.kind === "none"
				? undefined
				: entry.firstKeptEntryId;
	return (
		firstRetainedEntryId === undefined || isEntryOnKnownBranch(firstRetainedEntryId, entry.parentId, knownEntries)
	);
}

/** Shared validity boundary for committed unit envelopes before projection or resident pruning. */
export function isValidSessionUnitCommitRecord(record: unknown, context: SessionUnitValidationContext): boolean {
	if (typeof record !== "object" || record === null) return false;
	const candidate = record as Record<string, unknown>;
	if (
		candidate.type !== "session_unit_commit" ||
		typeof candidate.unitId !== "string" ||
		candidate.unitId.length === 0 ||
		typeof candidate.primaryEntryId !== "string" ||
		candidate.primaryEntryId.length === 0 ||
		typeof candidate.finalLeafId !== "string" ||
		candidate.finalLeafId.length === 0 ||
		!Array.isArray(candidate.entries) ||
		candidate.entries.length === 0
	) {
		return false;
	}

	const knownUnitIds = context.knownUnitIds ?? new Set<string>();
	const knownActionIds = context.knownActionIds ?? new Set<string>();
	if (
		context.knownEntries.has(candidate.unitId) ||
		knownUnitIds.has(candidate.unitId) ||
		knownActionIds.has(candidate.unitId)
	) {
		return false;
	}

	const ids = new Set<string>([...context.knownEntries.keys(), ...knownUnitIds, ...knownActionIds, candidate.unitId]);
	let previousId: string | null | undefined;
	let primaryEntry: SessionEntry | undefined;
	for (const [index, item] of candidate.entries.entries()) {
		if (typeof item !== "object" || item === null) return false;
		const embedded = item as Record<string, unknown>;
		if (
			typeof embedded.id !== "string" ||
			!isValidSessionEntryRecord(embedded.entry) ||
			embedded.id !== embedded.entry.id ||
			ids.has(embedded.id) ||
			(index === 0
				? embedded.id !== candidate.primaryEntryId ||
					!isSessionUnitPrimaryEntryRecord(embedded.entry) ||
					(embedded.entry.parentId !== null && !context.knownEntries.has(embedded.entry.parentId))
				: embedded.entry.type !== "custom" || embedded.entry.parentId !== previousId)
		) {
			return false;
		}
		if (index === 0) primaryEntry = embedded.entry;
		ids.add(embedded.id);
		previousId = embedded.id;
	}
	if (previousId !== candidate.finalLeafId || !primaryEntry) return false;

	if (
		primaryEntry.type === "compaction" &&
		(!primaryEntry.retainedSuffix || !isValidCompactionEntryContext(primaryEntry, context.knownEntries))
	) {
		return false;
	}

	if (candidate.scheduledAction !== undefined) {
		if (typeof candidate.scheduledAction !== "object" || candidate.scheduledAction === null) return false;
		const action = candidate.scheduledAction as Record<string, unknown>;
		if (
			typeof action.actionId !== "string" ||
			action.actionId.length === 0 ||
			ids.has(action.actionId) ||
			(action.kind !== "run_turn" && action.kind !== "overflow_retry") ||
			action.entryId !== candidate.primaryEntryId
		) {
			return false;
		}
	}
	return true;
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

export type SessionLineMetadata =
	| "session"
	| "record"
	| {
			embedded: boolean;
			entries: SessionEntryMetadata[];
			unitId?: string;
			scheduledActionId?: string;
	  };

function metadataForEntryLine(
	trimmed: string,
	knownEntries: ReadonlyMap<string, { readonly parentId: string | null }>,
): SessionEntryMetadata | undefined {
	const type = extractJsonStringField(trimmed, "type");
	if (!isSessionEntryType(type)) return undefined;

	let parsedCompaction: CompactionEntry | undefined;
	if (type === "compaction") {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (
				!isValidSessionEntryRecord(parsed) ||
				parsed.type !== "compaction" ||
				!isValidCompactionEntryContext(parsed, knownEntries)
			) {
				return undefined;
			}
			parsedCompaction = parsed;
		} catch {
			return undefined;
		}
	}

	const id = parsedCompaction?.id ?? extractJsonStringField(trimmed, "id");
	const parentId = parsedCompaction?.parentId ?? extractJsonNullableStringField(trimmed, "parentId");
	const timestamp = parsedCompaction?.timestamp ?? extractJsonStringField(trimmed, "timestamp");
	if (!id || parentId === undefined || !timestamp) return undefined;

	return {
		id,
		parentId,
		type,
		timestamp,
		firstKeptEntryId: parsedCompaction?.firstKeptEntryId,
		retainedSuffix: parsedCompaction?.retainedSuffix,
		tokensBefore: parsedCompaction?.tokensBefore,
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

export function metadataForSessionLine(
	line: string,
	validationContext: SessionUnitValidationContext = { knownEntries: new Map() },
): SessionLineMetadata | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	const type = extractJsonStringField(trimmed, "type");
	if (type === "session") return "session";
	if (type === "session_unit_dispatch" || type === "session_unit_prepare" || type === "session_unit_abort") {
		return "record";
	}
	if (type !== "session_unit_commit") {
		const metadata = metadataForEntryLine(trimmed, validationContext.knownEntries);
		return metadata ? { embedded: false, entries: [metadata] } : undefined;
	}

	try {
		const record = JSON.parse(trimmed) as {
			unitId?: unknown;
			entries?: unknown;
			scheduledAction?: { actionId?: unknown };
		};
		if (!isValidSessionUnitCommitRecord(record, validationContext)) return undefined;

		const metadata: SessionEntryMetadata[] = [];
		for (const item of record.entries as { id: string; entry: SessionEntry }[]) {
			const entryMetadata = metadataForEntryLine(JSON.stringify(item.entry), validationContext.knownEntries);
			if (!entryMetadata || entryMetadata.id !== item.id) return undefined;
			metadata.push(entryMetadata);
		}
		return {
			embedded: true,
			entries: metadata,
			unitId: record.unitId as string,
			scheduledActionId: record.scheduledAction?.actionId as string | undefined,
		};
	} catch {
		return undefined;
	}
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
	if (
		metadata.type === "compaction" &&
		options.stubSummarizedEntries &&
		(metadata.firstKeptEntryId || metadata.retainedSuffix)
	) {
		return {
			...base,
			type: "compaction",
			summary: RESIDENT_PRUNED_TEXT,
			firstKeptEntryId: metadata.firstKeptEntryId,
			retainedSuffix: metadata.retainedSuffix,
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
	const knownUnitIds = new Set<string>();
	const knownActionIds = new Set<string>();
	let sawInvalidMetadata = false;

	readSessionFileLines(filePath, (line) => {
		const item = metadataForSessionLine(line, {
			knownEntries: byId,
			knownUnitIds,
			knownActionIds,
		});
		if (item === "session" || item === "record") return;
		if (!item) {
			if (line.trim()) sawInvalidMetadata = true;
			return;
		}
		if (item.unitId) knownUnitIds.add(item.unitId);
		if (item.scheduledActionId) knownActionIds.add(item.scheduledActionId);
		for (const entry of item.entries) {
			if (byId.has(entry.id) || knownUnitIds.has(entry.id) || knownActionIds.has(entry.id)) {
				sawInvalidMetadata = true;
				return;
			}
			metadata.push(entry);
			byId.set(entry.id, entry);
			for (const toolCallId of entry.toolCallIds) {
				toolCallEntryIds.set(toolCallId, entry.id);
			}
			if (entry.toolResultCallId) {
				toolResultEntryIds.set(entry.toolResultCallId, entry.id);
			}
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
	if (!compaction) return undefined;
	let candidateEnd: number;
	if (compaction.retainedSuffix?.kind === "none") {
		candidateEnd = compactionIndex;
	} else {
		const firstKeptEntryId =
			compaction.retainedSuffix?.kind === "from-entry"
				? compaction.retainedSuffix.firstEntryId
				: compaction.firstKeptEntryId;
		if (!firstKeptEntryId) return undefined;
		const firstKeptIndex = path.findIndex((entry) => entry.id === firstKeptEntryId);
		if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) return undefined;
		candidateEnd = firstKeptIndex;
	}

	const candidates = path.slice(0, candidateEnd);
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

	const firstKeptEntryId =
		compactionEntry.retainedSuffix?.kind === "from-entry"
			? compactionEntry.retainedSuffix.firstEntryId
			: compactionEntry.firstKeptEntryId;
	let candidateEnd: number;
	if (compactionEntry.retainedSuffix?.kind === "none") {
		candidateEnd = compactionIndex;
	} else {
		const firstKeptIndex = firstKeptEntryId ? path.findIndex((entry) => entry.id === firstKeptEntryId) : -1;
		if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) {
			return {
				compactionId: compactionEntry.id,
				firstKeptEntryId,
				entriesVisited: 0,
				entriesStubbed: 0,
				protectedEntries: 0,
				payloadBytesBefore,
				payloadBytesAfter: payloadBytesBefore,
				payloadBytesFreed: 0,
				jsonlUnchanged: true,
			};
		}
		candidateEnd = firstKeptIndex;
	}

	const candidates = path.slice(0, candidateEnd);
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
		firstKeptEntryId,
		entriesVisited: candidates.length,
		entriesStubbed,
		protectedEntries,
		payloadBytesBefore,
		payloadBytesAfter,
		payloadBytesFreed: Math.max(0, payloadBytesBefore - payloadBytesAfter),
		jsonlUnchanged: true,
	};
}
