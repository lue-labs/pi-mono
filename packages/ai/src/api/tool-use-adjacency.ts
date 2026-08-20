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

function isSyntheticPlaceholder(block: ToolResultBlock): boolean {
	return block.content === "No result provided";
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
 *   here would mask the upstream bug and belongs to `transformMessages`.
 *
 * A well-formed request returns the identical array, so valid payloads
 * serialize byte-identically and the prompt-cache prefix is untouched.
 */
export function repairToolUseAdjacency(messages: MessageParam[]): MessageParam[] {
	if (findToolUseAdjacencyViolations(messages).length === 0 && !hasDuplicateOrOrphanResults(messages)) {
		return messages;
	}

	// One winning result block per id: first result wins, except a real result
	// over a synthetic placeholder.
	const toolUseIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "tool_use") toolUseIds.add(block.id);
		}
	}
	const resultById = new Map<string, ToolResultBlock>();
	for (const message of messages) {
		if (message.role !== "user" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type !== "tool_result") continue;
			if (!toolUseIds.has(block.tool_use_id)) continue;
			const existing = resultById.get(block.tool_use_id);
			// First result wins (stable prefix bytes), except a real result
			// replaces a synthetic "No result provided" placeholder.
			if (existing && !(isSyntheticPlaceholder(existing) && !isSyntheticPlaceholder(block))) continue;
			resultById.set(block.tool_use_id, block);
		}
	}

	const emitted = new Set<string>();
	const out: MessageParam[] = [];

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

	const isExactBatch = (message: MessageParam, batch: ToolResultBlock[]): boolean => {
		if (message.role !== "user" || typeof message.content === "string") return false;
		if (message.content.length !== batch.length) return false;
		return message.content.every((block, index) => block === batch[index]);
	};

	for (let index = 0; index < messages.length; index++) {
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
		if (next && isExactBatch(next, batch)) {
			// Already adjacent and clean — keep the original message object so
			// untouched spans stay reference- and byte-identical.
			out.push(next);
			index++;
			continue;
		}
		out.push({ role: "user", content: batch });
	}

	return out;
}

function hasDuplicateOrOrphanResults(messages: MessageParam[]): boolean {
	const toolUseIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "tool_use") toolUseIds.add(block.id);
		}
	}
	const seen = new Set<string>();
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type !== "tool_result") continue;
			if (!toolUseIds.has(block.tool_use_id)) return true;
			if (seen.has(block.tool_use_id)) return true;
			seen.add(block.tool_use_id);
		}
	}
	return false;
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
