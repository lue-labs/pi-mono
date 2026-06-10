import type { AgentMessage, ThinkingLevel } from "@valkyriweb/pi-agent-core";
import type { Api, Model, ToolResultMessage } from "@valkyriweb/pi-ai";
import type { DefaultResourceLoaderOptions } from "../resource-loader.ts";
import { buildSessionContext, type ReadonlySessionManager } from "../session-manager.ts";
import type { AgentDefinition, AgentTaskConfig, ContextMode, ResolvedContextPolicy } from "./types.ts";

export function resolveContextPolicy(mode: ContextMode): ResolvedContextPolicy {
	switch (mode) {
		case "fork":
			return {
				mode,
				includeTranscript: true,
				includeProjectContext: true,
				includeSkills: true,
				includeAppendSystemPrompt: true,
			};
		case "slim":
			return {
				mode,
				includeTranscript: false,
				includeProjectContext: false,
				includeSkills: false,
				includeAppendSystemPrompt: true,
			};
		case "none":
			return {
				mode,
				includeTranscript: false,
				includeProjectContext: false,
				includeSkills: false,
				includeAppendSystemPrompt: false,
			};
		case "default":
			return {
				mode,
				includeTranscript: false,
				includeProjectContext: true,
				includeSkills: true,
				includeAppendSystemPrompt: true,
			};
	}
}

export function buildAgentSystemAppend(agent: AgentDefinition): string {
	return [
		"<pi-child-agent>",
		`Agent: ${agent.id}`,
		"You are running as a Pi child agent for a delegated task.",
		"Do not call the agent tool or delegate recursively.",
		"Return only the final report needed by the parent agent.",
		"</pi-child-agent>",
		"",
		agent.prompt,
	].join("\n");
}

export function getChildResourceLoaderOptions(
	policy: ResolvedContextPolicy,
	agent: AgentDefinition,
): Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager"> {
	const agentAppend = buildAgentSystemAppend(agent);
	return {
		noContextFiles: !policy.includeProjectContext,
		noSkills: !policy.includeSkills,
		appendSystemPromptOverride: (base) => (policy.includeAppendSystemPrompt ? [...base, agentAppend] : [agentAppend]),
	};
}

// `filterDeniedToolArtifacts` (pre-2026-05-28) used to strip parent `agent`/
// `subagent` tool_use blocks from the fork prefix. That broke prompt-cache
// continuity at the first stripped call: bytes diverged from the parent's
// cached prefix for every subsequent block. Replaced by
// `substitutePlaceholdersForUnresolvedToolCalls` below, which keeps the
// tool_use blocks in place and supplies fixed-bytes placeholder results so
// the fork child's prefix stays byte-identical to the parent's cache key.

function collectToolCallIds(messages: AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "toolCall") ids.add(part.id);
		}
	}
	return ids;
}

function collectToolResultIds(messages: AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") ids.add(message.toolCallId);
	}
	return ids;
}

export function filterIncompleteToolCalls(messages: AgentMessage[]): AgentMessage[] {
	const toolCallIds = collectToolCallIds(messages);
	const toolResultIds = collectToolResultIds(messages);
	return messages
		.map((message): AgentMessage | undefined => {
			if (message.role === "toolResult") {
				return toolCallIds.has(message.toolCallId) ? message : undefined;
			}
			if (message.role !== "assistant") return message;
			const filteredContent = message.content.filter((part) => {
				return part.type !== "toolCall" || toolResultIds.has(part.id);
			});
			if (filteredContent.length === message.content.length) return message;
			if (filteredContent.length === 0) return undefined;
			return { ...message, content: filteredContent };
		})
		.filter((message): message is AgentMessage => Boolean(message));
}

/**
 * Fixed-bytes placeholder text used to substitute for any unresolved tool_use
 * in the fork prefix. Must be identical across all fork children (siblings
 * spawned from the same parent turn, or sequential forks at the same point)
 * so their API request prefixes stay byte-identical for prompt-cache sharing.
 *
 * Pattern matches Claude Code's `FORK_PLACEHOLDER_RESULT` in
 * `src/tools/AgentTool/forkSubagent.ts` (2.1.x). The shared placeholder is
 * what lets sibling forks cache-hit off each other, not just off the parent.
 */
const FORK_PLACEHOLDER_RESULT_TEXT = "Sibling agent task in progress.";

function makeForkPlaceholderResult(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: FORK_PLACEHOLDER_RESULT_TEXT }],
		isError: false,
		// Timestamp is not serialized to the provider wire (Anthropic tool_result
		// blocks include type/tool_use_id/content/is_error only). Using a fixed
		// value keeps the in-memory representation byte-stable across siblings
		// without affecting display order — placeholders always sit immediately
		// after their parent assistant message.
		timestamp: 0,
	};
}

/**
 * Substitute fixed-bytes placeholder tool_results for any tool_use blocks
 * that lack a matching tool_result in the message stream. Preserves the
 * parent's assistant-message structure (including `agent`/`subagent`
 * tool_uses) so the fork child's API prefix stays byte-identical to the
 * parent's cached prefix.
 *
 * Drops orphan tool_results (results referencing nonexistent tool_uses) —
 * those would confuse the provider API.
 *
 * Mirrors Claude Code's `buildForkedMessages` strategy (see CC
 * `src/tools/AgentTool/forkSubagent.ts`). The key correctness property is
 * that any two fork children spawned from the same parent state produce
 * byte-identical prefixes through every leading block, diverging only at
 * the child-specific user directive appended after.
 */
export function substitutePlaceholdersForUnresolvedToolCalls(messages: AgentMessage[]): AgentMessage[] {
	const resultIds = collectToolResultIds(messages);
	const out: AgentMessage[] = [];
	for (const message of messages) {
		out.push(message);
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (resultIds.has(block.id)) continue;
			out.push(makeForkPlaceholderResult(block.id, block.name));
			resultIds.add(block.id);
		}
	}
	const callIds = collectToolCallIds(out);
	return out.filter(
		(message): message is AgentMessage => message.role !== "toolResult" || callIds.has(message.toolCallId),
	);
}

export function getFilteredForkMessages(sessionManager: ReadonlySessionManager): AgentMessage[] {
	const messages = buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId()).messages;
	return substitutePlaceholdersForUnresolvedToolCalls(messages);
}

// Static reminder prepended to every child task message. Lives in the user
// message (not the system prompt / tool schemas) so it stays inside the
// cache-eligible prefix without changing the parent's cached bytes — fork-mode
// children still share the parent's system + tools cache. Mirrors Claude Code's
// `<system-reminder>` pattern for subagent guidance.
const CHILD_AGENT_REMINDER =
	"<system-reminder>\n" +
	"You are a Pi child agent (subagent). The `agent` tool is not available to you — " +
	"child agents cannot spawn further child agents, even if the tool schema appears in " +
	"your tool list (fork-mode children inherit the parent's tool schemas for cache reasons). " +
	"If the task genuinely requires delegation, return your findings to the parent and let " +
	"them dispatch the follow-up work.\n" +
	"</system-reminder>";

// When nested delegation is enabled and this child is still under the cap, tell it
// it MAY delegate (and how many further levels remain) instead of the default
// "agent tool not available" reminder. Kept depth-aware so the boundary child still
// gets the hard no.
function childAgentReminder(delegation?: { canDelegate: boolean; remaining: number }): string {
	if (delegation?.canDelegate && delegation.remaining > 0) {
		return (
			"<system-reminder>\n" +
			"You are a Pi child agent (subagent). You MAY delegate to your own child agents via " +
			`the \`agent\` tool, up to ${delegation.remaining} more nested level(s). Delegate only for ` +
			"genuinely parallel or large read-only sub-tasks; prefer doing the work yourself. Deeper " +
			"children past the configured cap cannot delegate further.\n" +
			"</system-reminder>"
		);
	}
	return CHILD_AGENT_REMINDER;
}

export function buildChildTaskPrompt(
	task: AgentTaskConfig,
	delegation?: { canDelegate: boolean; remaining: number },
): string {
	const parts = [childAgentReminder(delegation), "", "Complete this delegated task:", "", task.task.trim()];
	if (task.extraContext?.trim()) {
		parts.push("", "Additional context:", task.extraContext.trim());
	}
	return parts.join("\n");
}

export function formatModelForDetails(
	model: Model<Api> | undefined,
): { provider: string; id: string; name?: string } | undefined {
	if (!model) return undefined;
	return { provider: model.provider, id: model.id, name: model.name };
}

export function clampThinkingForModel(model: Model<Api> | undefined, thinkingLevel: ThinkingLevel): ThinkingLevel {
	return model?.reasoning ? thinkingLevel : "off";
}
