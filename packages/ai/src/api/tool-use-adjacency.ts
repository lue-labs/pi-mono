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

/**
 * Record any violation in the outgoing request, then get out of the way.
 *
 * Deliberately does not throw or repair: the request is already malformed by
 * the time it reaches here, and the fault has never been reproducible from the
 * session log. The point is to capture the shape once, in the wild.
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
