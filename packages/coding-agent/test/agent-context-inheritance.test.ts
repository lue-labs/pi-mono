import type { AssistantMessage, ToolResultMessage, UserMessage } from "@valkyriweb/pi-ai";
import { describe, expect, test } from "vitest";
import {
	getChildResourceLoaderOptions,
	getFilteredForkMessages,
	resolveContextPolicy,
} from "../src/core/agents/context.ts";
import type { AgentDefinition } from "../src/core/agents/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const agent: AgentDefinition = {
	id: "scout",
	description: "Scout",
	prompt: "Scout prompt.",
	source: "builtin",
};

const assistantBase = {
	api: "openai-responses" as const,
	provider: "openai",
	model: "gpt-4o-mini",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: Date.now(),
};

describe("agent context inheritance", () => {
	test("resolves public context modes into independent tiers", () => {
		expect(resolveContextPolicy("default")).toMatchObject({
			includeTranscript: false,
			includeProjectContext: true,
			includeSkills: true,
			includeAppendSystemPrompt: true,
		});
		expect(resolveContextPolicy("fork").includeTranscript).toBe(true);
		expect(resolveContextPolicy("slim")).toMatchObject({
			includeProjectContext: false,
			includeSkills: false,
			includeAppendSystemPrompt: true,
		});
		expect(resolveContextPolicy("none")).toMatchObject({
			includeTranscript: false,
			includeProjectContext: false,
			includeSkills: false,
			includeAppendSystemPrompt: false,
		});
	});

	test("child resource options make slim and none observably different", () => {
		const slim = getChildResourceLoaderOptions(resolveContextPolicy("slim"), agent);
		expect(slim.noContextFiles).toBe(true);
		expect(slim.noSkills).toBe(true);
		expect(slim.appendSystemPromptOverride?.(["project append"])).toEqual(expect.arrayContaining(["project append"]));

		const none = getChildResourceLoaderOptions(resolveContextPolicy("none"), agent);
		expect(none.noContextFiles).toBe(true);
		expect(none.noSkills).toBe(true);
		expect(none.appendSystemPromptOverride?.(["project append"])).toEqual(
			expect.not.arrayContaining(["project append"]),
		);

		const defaults = getChildResourceLoaderOptions(resolveContextPolicy("default"), agent);
		expect(defaults.noContextFiles).toBe(false);
		expect(defaults.noSkills).toBe(false);
		expect(defaults.appendSystemPromptOverride?.(["project append"])).toEqual(
			expect.arrayContaining(["project append"]),
		);
	});

	// 2026-05-28: fork-prefix strategy changed from strip to placeholder-substitute
	// (mirrors Claude Code's `buildForkedMessages`). The fork child now retains
	// parent `agent`/`subagent` tool_use blocks in place and gets fixed-bytes
	// placeholder tool_results for any unresolved calls, so the API prefix stays
	// byte-identical to the parent's cached prefix.
	test("fork filtering keeps parent agent/subagent tool_uses for cache parity", () => {
		const session = SessionManager.inMemory();
		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "keep" }],
			timestamp: Date.now(),
		};
		const normalAssistant: AssistantMessage = {
			...assistantBase,
			role: "assistant",
			content: [{ type: "text", text: "keep assistant" }],
			stopReason: "stop",
		};
		const agentAssistant: AssistantMessage = {
			...assistantBase,
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "agent", arguments: { agent: "scout", task: "x" } }],
			stopReason: "toolUse",
		};
		const orphanSubagentResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "subagent",
			content: [{ type: "text", text: "orphan" }],
			isError: false,
			timestamp: Date.now(),
		};
		session.appendMessage(userMessage);
		session.appendMessage(normalAssistant);
		session.appendMessage(agentAssistant);
		session.appendMessage(orphanSubagentResult);

		const messages = getFilteredForkMessages(session);
		expect(messages).toContain(userMessage);
		expect(messages).toContain(normalAssistant);
		// agentAssistant kept in place (cache parity)
		expect(messages).toContain(agentAssistant);
		// orphan tool_result dropped (no matching tool_use — would confuse the API)
		expect(messages).not.toContain(orphanSubagentResult);
		// Placeholder tool_result synthesized for call-1
		const placeholder = messages.find(
			(m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "call-1",
		);
		expect(placeholder).toBeDefined();
		expect(placeholder?.content).toEqual([{ type: "text", text: "Another Agent task is in progress." }]);
		expect(placeholder?.isError).toBe(false);
		expect(placeholder?.toolName).toBe("agent");
	});

	test("fork filtering substitutes placeholders for unresolved tool_uses, drops orphan results", () => {
		const session = SessionManager.inMemory();
		const mixedAssistant: AssistantMessage = {
			...assistantBase,
			role: "assistant",
			content: [
				{ type: "toolCall", id: "keep-call", name: "read", arguments: { path: "README.md" } },
				{ type: "toolCall", id: "agent-call", name: "agent", arguments: { agent: "scout", task: "x" } },
			],
			stopReason: "toolUse",
		};
		const keepResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "keep-call",
			toolName: "read",
			content: [{ type: "text", text: "read result" }],
			isError: false,
			timestamp: Date.now(),
		};
		const orphanResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "missing-call",
			toolName: "read",
			content: [{ type: "text", text: "orphan" }],
			isError: false,
			timestamp: Date.now(),
		};
		session.appendMessage(mixedAssistant);
		session.appendMessage(keepResult);
		session.appendMessage(orphanResult);

		const messages = getFilteredForkMessages(session);
		// mixedAssistant kept verbatim (both calls preserved)
		expect(messages[0]).toBe(mixedAssistant);
		if (messages[0]?.role === "assistant") {
			expect(messages[0].content).toHaveLength(2);
		}
		// placeholder synthesized immediately after assistant, for agent-call
		const agentPlaceholder = messages.find(
			(m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "agent-call",
		);
		expect(agentPlaceholder).toBeDefined();
		expect(agentPlaceholder?.content).toEqual([{ type: "text", text: "Another Agent task is in progress." }]);
		// real keepResult kept
		expect(messages).toContain(keepResult);
		// orphan dropped
		expect(messages).not.toContain(orphanResult);
	});

	// CACHE CRITICAL: two fork children built from the same parent state must
	// produce byte-identical message arrays. Anthropic prompt cache keys on the
	// full request prefix; if siblings diverge anywhere in the leading blocks,
	// each sibling burns its own cache write instead of sharing the parent's
	// cached prefix. Mirrors CC's invariant in `FORK_PLACEHOLDER_RESULT`.
	test("sibling forks produce byte-identical message arrays", () => {
		const session = SessionManager.inMemory();
		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "parent prompt" }],
			timestamp: 1234567890,
		};
		const assistant: AssistantMessage = {
			...assistantBase,
			role: "assistant",
			content: [
				{ type: "text", text: "about to fan out" },
				{ type: "toolCall", id: "agent-a", name: "agent", arguments: { agent: "worker", task: "a" } },
				{ type: "toolCall", id: "agent-b", name: "agent", arguments: { agent: "worker", task: "b" } },
			],
			stopReason: "toolUse",
		};
		session.appendMessage(userMessage);
		session.appendMessage(assistant);

		// Simulate two siblings reading the parent state at slightly different
		// times. JSON.stringify catches structural and content drift.
		const siblingA = getFilteredForkMessages(session);
		const siblingB = getFilteredForkMessages(session);
		expect(JSON.stringify(siblingA)).toBe(JSON.stringify(siblingB));

		// And both contain placeholders for both fan-out tool_uses.
		const placeholderIds = siblingA
			.filter((m): m is ToolResultMessage => m.role === "toolResult")
			.map((m) => m.toolCallId)
			.sort();
		expect(placeholderIds).toEqual(["agent-a", "agent-b"]);
	});
});
