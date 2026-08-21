import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model, ToolCall } from "../src/types.ts";

// Normalize function matching what anthropic.ts uses
function anthropicNormalizeToolCallId(
	id: string,
	_model: Model<"anthropic-messages">,
	_source: AssistantMessage,
): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function makeCopilotClaudeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("OpenAI to Anthropic session migration for Copilot Claude", () => {
	it("converts thinking blocks to plain text when source model differs", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Let me think about this...",
						thinkingSignature: "reasoning_content",
					},
					{ type: "text", text: "Hi there!" },
				],
				api: "openai-completions",
				provider: "github-copilot",
				model: "gpt-4o",
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
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;

		// Thinking block should be converted to text since models differ
		const textBlocks = assistantMsg.content.filter((b) => b.type === "text");
		const thinkingBlocks = assistantMsg.content.filter((b) => b.type === "thinking");
		expect(thinkingBlocks).toHaveLength(0);
		expect(textBlocks.length).toBeGreaterThanOrEqual(2);
	});

	it("removes thoughtSignature from tool calls when migrating between models", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_123",
						name: "bash",
						arguments: { command: "ls" },
						thoughtSignature: JSON.stringify({ type: "reasoning.encrypted", id: "call_123", data: "encrypted" }),
					},
				],
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_123",
				toolName: "bash",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;
		const toolCall = assistantMsg.content.find((b) => b.type === "toolCall") as ToolCall;

		expect(toolCall.thoughtSignature).toBeUndefined();
	});

	it("adds synthetic tool results for trailing orphaned tool calls", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "read the file", timestamp: Date.now() },
			makeAssistantMessage([
				{
					type: "toolCall",
					id: "call_123|fc_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			]),
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const lastMessage = result[result.length - 1];

		expect(lastMessage).toMatchObject({
			role: "toolResult",
			toolCallId: "call_123_fc_123",
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "No result provided" }],
		});
	});

	it("adds synthetic results only for trailing tool calls that are still missing results", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run commands", timestamp: Date.now() },
			makeAssistantMessage([
				{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "README.md" } },
				{ type: "toolCall", id: "call_2|fc_2", name: "bash", arguments: { command: "pwd" } },
			]),
			{
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: "read",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const syntheticResults = result.filter((message) => message.role === "toolResult" && message.isError);

		expect(syntheticResults).toHaveLength(1);
		expect(syntheticResults[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "call_2_fc_2",
			toolName: "bash",
			content: [{ type: "text", text: "No result provided" }],
		});
	});

	it("drops tool results whose aborted/errored assistant message was dropped", () => {
		// Repro of the pi-memory extraction / context:"fork" 400 (2026-07-30):
		// an aborted OpenAI-family assistant turn left an unresolved tool call;
		// the fork context builder synthesized a placeholder tool_result for it;
		// transformMessages dropped the aborted assistant but kept the result,
		// producing an orphan tool_result that Anthropic rejects with
		// "unexpected tool_use_id".
		const model = makeCopilotClaudeModel();
		const abortedAssistant = makeAssistantMessage([
			{
				type: "toolCall",
				id: "call_I1v0ScfjTWLZGucGl8ZgJiD7|fc_0a7adda327c58184016a6b124fb",
				name: "bash",
				arguments: { command: "ls" },
			},
		]);
		abortedAssistant.stopReason = "aborted";
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			abortedAssistant,
			{
				role: "toolResult",
				toolCallId: "call_I1v0ScfjTWLZGucGl8ZgJiD7|fc_0a7adda327c58184016a6b124fb",
				toolName: "bash",
				content: [{ type: "text", text: "Another Agent task is in progress." }],
				isError: false,
				timestamp: 0,
			},
			{ role: "user", content: "extract memories", timestamp: Date.now() },
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);

		expect(result.some((m) => m.role === "assistant")).toBe(false);
		expect(result.some((m) => m.role === "toolResult")).toBe(false);
		expect(result.filter((m) => m.role === "user")).toHaveLength(2);
	});

	it("keeps tool results for completed assistants while dropping an aborted sibling's", () => {
		const model = makeCopilotClaudeModel();
		const abortedAssistant = makeAssistantMessage([
			{ type: "toolCall", id: "call_dead|fc_dead", name: "bash", arguments: { command: "ls" } },
		]);
		abortedAssistant.stopReason = "aborted";
		const messages: Message[] = [
			{ role: "user", content: "run commands", timestamp: Date.now() },
			makeAssistantMessage([{ type: "toolCall", id: "call_ok|fc_ok", name: "read", arguments: { path: "a" } }]),
			{
				role: "toolResult",
				toolCallId: "call_ok|fc_ok",
				toolName: "read",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
			abortedAssistant,
			{
				role: "toolResult",
				toolCallId: "call_dead|fc_dead",
				toolName: "bash",
				content: [{ type: "text", text: "Another Agent task is in progress." }],
				isError: false,
				timestamp: 0,
			},
			{ role: "user", content: "continue", timestamp: Date.now() },
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const toolResults = result.filter((m) => m.role === "toolResult");

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({ toolCallId: "call_ok_fc_ok" });
		expect(result.filter((m) => m.role === "assistant")).toHaveLength(1);
	});

	it("does not let hidden empty user messages synthesize duplicate tool results", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run commands", timestamp: Date.now() },
			makeAssistantMessage([
				{ type: "toolCall", id: "toolu_01", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "toolu_02", name: "find", arguments: { pattern: "*.md" } },
			]),
			{ role: "user", content: [], timestamp: Date.now() },
			{
				role: "toolResult",
				toolCallId: "toolu_01",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "toolu_02",
				toolName: "find",
				content: [{ type: "text", text: "none" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const toolResults = result.filter((message) => message.role === "toolResult");

		expect(
			result.some(
				(message) => message.role === "user" && Array.isArray(message.content) && message.content.length === 0,
			),
		).toBe(false);
		expect(toolResults).toHaveLength(2);
		expect(toolResults.map((message) => message.toolCallId)).toEqual(["toolu_01", "toolu_02"]);
		expect(toolResults.some((message) => message.isError)).toBe(false);
	});
});
