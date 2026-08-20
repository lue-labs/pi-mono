import type * as NodeFs from "node:fs";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

// NEVER convert to a top-level runtime import - breaks browser/Vite builds
type ProcessWithNodeBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:fs") => typeof NodeFs;
};

/**
 * A `tool_use` block the request is about to send without its `tool_result`
 * immediately after.
 */
export interface ToolUseAdjacencyViolation {
	messageIndex: number;
	toolUseId: string;
	toolName: string;
	/** Role of the message that followed, or "(end of transcript)". */
	followedBy: string;
	/** Block types of the following message, in order. */
	followedByBlocks: string[];
	/**
	 * Index of the message carrying this id's `tool_result`, if one exists later
	 * in the request. Present means the result was displaced rather than lost —
	 * the two cases need opposite repairs, and they are indistinguishable from
	 * the provider's error text alone.
	 */
	resultAtIndex?: number;
	totalMessages: number;
}

function blockTypes(content: MessageParam["content"]): string[] {
	if (typeof content === "string") return ["text"];
	return content.map((block) => block.type);
}

/**
 * The ids the next message actually settles.
 *
 * Anthropic only accepts results that lead the immediately following *user*
 * turn, so a result carried by an assistant message, or sitting behind a text
 * or image block, does not settle its call however present it looks. Scanning
 * the whole message would mark those requests clean and lose the very shape
 * this file exists to catch.
 */
function settledToolUseIds(next: MessageParam | undefined): Set<string> {
	const ids = new Set<string>();
	if (!next || next.role !== "user" || typeof next.content === "string") return ids;
	for (const block of next.content) {
		if (block.type !== "tool_result") break;
		ids.add(block.tool_use_id);
	}
	return ids;
}

function toolResultIds(content: MessageParam["content"]): Set<string> {
	const ids = new Set<string>();
	if (typeof content === "string") return ids;
	for (const block of content) {
		if (block.type === "tool_result") ids.add(block.tool_use_id);
	}
	return ids;
}

/**
 * Find every `tool_use` that the outgoing request does not settle in the very
 * next message.
 *
 * Anthropic rejects the whole request when a `tool_use` is not immediately
 * followed by its `tool_result`, and the rejection reads the same whether the
 * result is missing or merely out of position. This runs on the final
 * `MessageParam[]` — the exact array that goes on the wire — so what it reports
 * is what the provider saw, not what the session log implies.
 */
export function findToolUseAdjacencyViolations(messages: MessageParam[]): ToolUseAdjacencyViolation[] {
	const violations: ToolUseAdjacencyViolation[] = [];

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role !== "assistant" || typeof message.content === "string") continue;

		const toolUses = message.content.filter((block) => block.type === "tool_use");
		if (toolUses.length === 0) continue;

		const next = messages[index + 1];
		const settled = settledToolUseIds(next);

		for (const toolUse of toolUses) {
			if (settled.has(toolUse.id)) continue;

			let resultAtIndex: number | undefined;
			for (let later = index + 1; later < messages.length; later++) {
				if (toolResultIds(messages[later]!.content).has(toolUse.id)) {
					resultAtIndex = later;
					break;
				}
			}

			violations.push({
				messageIndex: index,
				toolUseId: toolUse.id,
				toolName: toolUse.name,
				followedBy: next ? next.role : "(end of transcript)",
				followedByBlocks: next ? blockTypes(next.content) : [],
				resultAtIndex,
				totalMessages: messages.length,
			});
		}
	}

	return violations;
}

export function formatToolUseAdjacencyReport(violations: ToolUseAdjacencyViolation[], origin: string): string {
	const lines = [`\n[${new Date().toISOString()}] tool_use adjacency violation ${origin}`];
	for (const violation of violations) {
		lines.push(
			`  messages.${violation.messageIndex} ${violation.toolUseId} (${violation.toolName}) of ${violation.totalMessages}` +
				` followedBy=${violation.followedBy} [${violation.followedByBlocks.join(",")}]` +
				` result=${violation.resultAtIndex === undefined ? "absent" : `displaced to messages.${violation.resultAtIndex}`}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

type ToolResultBlock = Extract<Exclude<MessageParam["content"], string>[number], { type: "tool_result" }>;

const SYNTHETIC_PLACEHOLDER_TEXT = "No result provided";

function isSyntheticPlaceholder(block: ToolResultBlock): boolean {
	if (block.is_error !== true) return false;
	if (block.content === SYNTHETIC_PLACEHOLDER_TEXT) return true;
	if (Array.isArray(block.content)) {
		const [only] = block.content;
		return block.content.length === 1 && only?.type === "text" && only.text === SYNTHETIC_PLACEHOLDER_TEXT;
	}
	return false;
}

/**
 * Restore `tool_use` → `tool_result` adjacency on the final wire array.
 *
 * The durable session log has always been valid in every captured incident
 * (see `reportToolUseAdjacencyViolations`); the pair is split later, by a
 * payload hook that re-inserts messages at frozen positions after the array it
 * measured has shifted (my-pi#tool-search mid-conversation sentinels killed
 * lue-kube session 01a0202f this way: assistant@11, sentinel@12, result@13).
 * Because the split happens after `onPayload`, no pre-serialization seam can
 * see it — this is the only place the provider-facing array exists.
 *
 * Repair rules:
 * - each result recorded later in the request is pulled back to lead the
 *   message immediately after its assistant turn; displaced non-result content
 *   is re-emitted right after the batch, preserving relative order — nothing
 *   is dropped, so injected steers/sentinels survive;
 * - a duplicate result for an already-settled id is dropped (Anthropic 400s
 *   duplicate `tool_use_id`), preferring a real result over a synthetic
 *   `"No result provided"` placeholder for the same id;
 * - a result whose `tool_use` is absent from the request is dropped (orphan);
 * - a `tool_use` with no result anywhere is left alone — inventing an outcome
 *   here would mask the upstream bug, so the absent case remains a provider
 *   error by design (every captured incident was a displaced result, never an
 *   absent one);
 * - a duplicate `tool_use` id across two assistant messages settles only the
 *   first occurrence — the request is malformed either way.
 *
 * A well-formed request returns the identical array, so valid payloads
 * serialize byte-identically and the prompt-cache prefix is untouched. When a
 * fault exists, everything before the first faulting message is returned by
 * reference, so the prompt-cache prefix up to the fault survives; if the
 * repair displaces the trailing `cache_control` breakpoint entirely, it is
 * re-attached to the last eligible block so the request still writes cache.
 */
export function repairToolUseAdjacency(messages: MessageParam[]): MessageParam[] {
	const toolUseIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "tool_use") toolUseIds.add(block.id);
		}
	}

	const violations = findToolUseAdjacencyViolations(messages);
	const faultIndex = firstDuplicateOrOrphanIndex(messages, toolUseIds);
	if (violations.length === 0 && faultIndex === undefined) {
		return messages;
	}

	// Anchor at the first faulting message: everything before it is already
	// valid and is returned by reference, so the prompt-cache prefix up to the
	// fault stays byte-identical.
	let anchor = Math.min(
		violations[0]?.messageIndex ?? Number.POSITIVE_INFINITY,
		faultIndex ?? Number.POSITIVE_INFINITY,
	);
	// A faulting user message may be the one settling the assistant just before
	// it (e.g. it carries an orphan next to the real results). Back up so that
	// batch is re-emitted rather than stripped out from under its tool_use.
	const anchored = messages[anchor];
	const before = messages[anchor - 1];
	if (
		anchored?.role === "user" &&
		before?.role === "assistant" &&
		typeof before.content !== "string" &&
		before.content.some((block) => block.type === "tool_use")
	) {
		anchor -= 1;
	}

	const emitted = new Set<string>();
	for (let index = 0; index < anchor; index++) {
		const message = messages[index]!;
		if (message.role !== "user" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "tool_result") emitted.add(block.tool_use_id);
		}
	}

	// One winning result block per id: first result wins, except a real result
	// over a synthetic placeholder.
	const resultById = new Map<string, ToolResultBlock>();
	for (let index = anchor; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role !== "user" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type !== "tool_result") continue;
			if (!toolUseIds.has(block.tool_use_id)) continue;
			if (emitted.has(block.tool_use_id)) continue;
			const existing = resultById.get(block.tool_use_id);
			// First result wins (stable prefix bytes), except a real result
			// replaces a synthetic "No result provided" placeholder.
			if (existing && !(isSyntheticPlaceholder(existing) && !isSyntheticPlaceholder(block))) continue;
			resultById.set(block.tool_use_id, block);
		}
	}

	const out: MessageParam[] = messages.slice(0, anchor);

	// Every tool_result at its original position is either the winning copy
	// (re-emitted adjacent to its assistant turn), a duplicate, or an orphan —
	// all leave their original message.
	const stripResults = (message: MessageParam): MessageParam | undefined => {
		if (message.role !== "user" || typeof message.content === "string") return message;
		const kept = message.content.filter((block) => block.type !== "tool_result");
		if (kept.length === message.content.length) return message;
		if (kept.length === 0) return undefined;
		return { ...message, content: kept };
	};

	// The message already settles the batch when the batch's blocks lead it (in
	// any order — Anthropic does not require result order to match call order)
	// and no other tool_result hides behind them. Keeping the original message
	// object preserves its bytes, ordering, and any cache_control breakpoint.
	const leadsWithBatch = (message: MessageParam, batch: ToolResultBlock[]): boolean => {
		if (message.role !== "user" || typeof message.content === "string") return false;
		if (message.content.length < batch.length) return false;
		const refs = new Set<unknown>(batch);
		for (let index = 0; index < batch.length; index++) {
			if (!refs.has(message.content[index])) return false;
		}
		for (let index = batch.length; index < message.content.length; index++) {
			if (message.content[index]!.type === "tool_result") return false;
		}
		return true;
	};

	for (let index = anchor; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role !== "assistant" || typeof message.content === "string") {
			const stripped = stripResults(message);
			if (stripped) out.push(stripped);
			continue;
		}

		out.push(message);
		const batch: ToolResultBlock[] = [];
		for (const block of message.content) {
			if (block.type !== "tool_use") continue;
			const result = resultById.get(block.id);
			if (result && !emitted.has(block.id)) {
				batch.push(result);
				emitted.add(block.id);
			}
		}
		if (batch.length === 0) continue;

		const next = messages[index + 1];
		if (next && leadsWithBatch(next, batch)) {
			out.push(next);
			index++;
			continue;
		}
		out.push({ role: "user", content: batch });
	}

	// An all-orphan input would otherwise repair to an empty message array,
	// which Anthropic rejects outright — worse than the fault being repaired.
	if (out.length === 0) return messages;

	restoreTrailingCacheBreakpoint(messages, out);
	return out;
}

/**
 * Index of the first user message carrying a duplicate or orphan
 * `tool_result`, scanning the same shapes the repairer collects from — a
 * `tool_result` carried by an assistant message is invalid for Anthropic
 * either way and is deliberately neither detected nor touched here.
 */
function firstDuplicateOrOrphanIndex(messages: MessageParam[], toolUseIds: Set<string>): number | undefined {
	const seen = new Set<string>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role !== "user" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type !== "tool_result") continue;
			if (!toolUseIds.has(block.tool_use_id)) return index;
			if (seen.has(block.tool_use_id)) return index;
			seen.add(block.tool_use_id);
		}
	}
	return undefined;
}

type BlockWithCacheControl = { type: string; cache_control?: unknown };

function hasCacheBreakpoint(messages: MessageParam[]): boolean {
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const block of message.content) {
			if ((block as BlockWithCacheControl).cache_control !== undefined) return true;
		}
	}
	return false;
}

/**
 * The serializer sets its history `cache_control` breakpoint on the final
 * block of the final user message; dropping or rewriting that message during
 * repair would strip the breakpoint and turn the request into a full-price
 * cache miss. If the repaired array lost every breakpoint the original had,
 * re-attach one to the last eligible block (cloning, never mutating input).
 */
function restoreTrailingCacheBreakpoint(original: MessageParam[], out: MessageParam[]): void {
	if (!hasCacheBreakpoint(original) || hasCacheBreakpoint(out)) return;
	let breakpoint: unknown;
	for (let index = original.length - 1; index >= 0 && breakpoint === undefined; index--) {
		const content = original[index]!.content;
		if (typeof content === "string") continue;
		for (const block of content) {
			const cacheControl = (block as BlockWithCacheControl).cache_control;
			if (cacheControl !== undefined) breakpoint = cacheControl;
		}
	}
	for (let index = out.length - 1; index >= 0; index--) {
		const message = out[index]!;
		if (typeof message.content === "string" || message.content.length === 0) continue;
		const last = message.content[message.content.length - 1]!;
		if (last.type !== "text" && last.type !== "image" && last.type !== "tool_result") continue;
		const blocks = [...message.content];
		blocks[blocks.length - 1] = { ...last, cache_control: breakpoint } as typeof last;
		out[index] = { ...message, content: blocks };
		return;
	}
}

/**
 * Record any violation in the outgoing request, then get out of the way.
 *
 * Runs before {@link repairToolUseAdjacency} so the malformed shape is still
 * captured in the wild even though the request that follows is repaired.
 */
export function reportToolUseAdjacencyViolations(messages: MessageParam[], model: string): void {
	try {
		const violations = findToolUseAdjacencyViolations(messages);
		if (violations.length === 0) return;
		const fs = (process as ProcessWithNodeBuiltinModule).getBuiltinModule?.("node:fs");
		if (!fs) return;
		const origin = `pid=${process.pid} model=${model} cwd=${process.cwd()}`;
		const directory = `${process.env.HOME ?? "."}/.pi/agent/logs`;
		fs.mkdirSync(directory, { recursive: true });
		fs.appendFileSync(`${directory}/tool-use-adjacency.log`, formatToolUseAdjacencyReport(violations, origin));
	} catch {
		/* swallow logging errors */
	}
}
