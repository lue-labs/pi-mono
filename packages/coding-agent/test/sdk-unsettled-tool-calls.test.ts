import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@valkyriweb/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNSETTLED_TOOL_CALL_TEXT } from "../src/core/messages.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { pickModel } from "./helpers/models.ts";

const unsettledCall: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 1,
};

const recordedResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: "file contents" }],
	isError: false,
	timestamp: 2,
};

describe("resuming a session with unsettled tool calls", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-unsettled-tool-calls-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function resume(messages: Array<AssistantMessage | ToolResultMessage>) {
		const model = pickModel("anthropic");
		expect(model).toBeTruthy();
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage({ role: "user", content: "go", timestamp: 0 });
		for (const message of messages) sessionManager.appendMessage(message);
		return createAgentSession({ cwd, agentDir, model: model!, sessionManager });
	}

	it("settles a tool call the dead turn left open", async () => {
		const { session } = await resume([unsettledCall]);

		const messages = session.agent.state.messages;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(messages[2]).toMatchObject({
			toolCallId: "call-1",
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: UNSETTLED_TOOL_CALL_TEXT }],
		});

		session.dispose();
	});

	it("leaves an already-settled session untouched", async () => {
		const { session } = await resume([unsettledCall, recordedResult]);

		const messages = session.agent.state.messages;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(messages[2]).toMatchObject({ toolCallId: "call-1", isError: false });

		session.dispose();
	});
});
