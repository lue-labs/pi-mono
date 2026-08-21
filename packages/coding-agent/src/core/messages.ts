/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage, CustomMessage } from "@lue-labs/pi-agent-core";
import type { ImageContent, Message, TextContent, ToolCall, ToolResultMessage } from "@lue-labs/pi-ai";

export type { CustomMessage };

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@lue-labs/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

export const UNSETTLED_TOOL_CALL_TEXT =
	"outcome unknown: the session recovered before this tool call settled; the tool may or may not have run";

function unsettledToolResult(toolCall: ToolCall, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: UNSETTLED_TOOL_CALL_TEXT }],
		isError: true,
		timestamp,
	};
}

/**
 * Settle every tool call the recorded history left without an outcome.
 *
 * A turn that dies between the assistant message and its tool results leaves a
 * `tool_use` with no `tool_result`. Providers reject that history outright
 * (Anthropic 400s), so the resumed session stays wedged on every later request.
 * Repair belongs at session open, before the first turn can run, so the record
 * the agent works from is sound rather than patched per request.
 *
 * A call counts as settled when a result for it exists anywhere later in the
 * history, not only in the adjacent run. A result the record displaced — a
 * custom message persisted mid-batch pushes one down — is still an outcome, and
 * synthesizing a second one for the same `tool_use_id` is itself an Anthropic
 * 400. Restoring adjacency is `transformMessages`' job; this seam only fills
 * outcomes that were never recorded at all.
 *
 * The synthetic result states the outcome is unknown. It does not claim the
 * tool failed or succeeded — the session cannot know which.
 *
 * Returns the input array unchanged when every tool call is already settled.
 */
/**
 * Whether the recorded history still has a tool call awaiting its result.
 *
 * Callers use this to keep injected content out of an open tool batch: a
 * message appended between a `toolCall` and its `toolResult` is persisted in
 * that position forever, and Anthropic rejects the rebuilt history outright
 * (pi-mono#479).
 */
export function hasUnsettledToolCalls(messages: AgentMessage[]): boolean {
	const settled = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") settled.add(message.toolCallId);
	}
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && !settled.has(block.id)) return true;
		}
	}
	return false;
}

export function reconcileUnsettledToolCalls(messages: AgentMessage[]): AgentMessage[] {
	const settled = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") settled.add(message.toolCallId);
	}

	const reconciled: AgentMessage[] = [];
	let repaired = false;

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		reconciled.push(message);
		if (message.role !== "assistant") continue;

		const unsettled = message.content.filter(
			(block): block is ToolCall => block.type === "toolCall" && !settled.has(block.id),
		);
		if (unsettled.length === 0) continue;

		// Keep the recorded results of this batch ahead of the synthetic ones, so
		// the settled calls stay adjacent to their assistant turn.
		while (index + 1 < messages.length && messages[index + 1]!.role === "toolResult") {
			reconciled.push(messages[++index]!);
		}

		for (const toolCall of unsettled) {
			reconciled.push(unsettledToolResult(toolCall, message.timestamp));
			repaired = true;
		}
	}

	return repaired ? reconciled : messages;
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
