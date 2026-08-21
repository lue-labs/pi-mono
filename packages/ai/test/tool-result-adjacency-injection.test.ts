import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { findToolUseAdjacencyViolations } from "../src/api/tool-use-adjacency.ts";
import { restoreToolResultAdjacency, transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Tool, ToolResultMessage } from "../src/types.ts";
import { pickModel } from "./helpers/models.ts";

// A message injected while a tool call is in flight (extension steer, captain
// wake, monitor notification) is persisted *between* the assistant toolCall and
// its toolResult. Anthropic rejects that shape with
//   "unexpected `tool_use_id` found in `tool_result` blocks"
// and, because the malformed order is committed to the session file, the same
// request is replayed forever: the session is permanently unusable and survives
// both /reload and continue (pi-mono#479, mirror of #406/#380).
//
// These tests pin the repair at the request-assembly seam, so the invariant
// holds for every producer of history and an already-poisoned transcript is
// recovered rather than replayed.

const model = pickModel("anthropic");
const now = 1_700_000_000_000;

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: now });

const assistantWithToolCalls = (...ids: string[]): AssistantMessage =>
	({
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: { command: "sleep 1" } })),
		provider: model.provider,
		api: model.api,
		model: model.id,
		stopReason: "toolUse",
		timestamp: now,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0 } },
	}) as unknown as AssistantMessage;

const toolResult = (id: string, text = "ok"): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: now,
});

const roles = (messages: Message[]): string[] =>
	messages.map((m) => (m.role === "toolResult" ? `toolResult:${(m as ToolResultMessage).toolCallId}` : m.role));

const tools: Tool[] = [
	{ name: "bash", description: "run a command", parameters: Type.Object({ command: Type.String() }) },
];

function anthropicResponse(): Response {
	const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	const body =
		sse("message_start", {
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-test",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		}) +
		sse("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		}) +
		sse("message_stop", { type: "message_stop" });
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function renderAnthropicPayload(messages: Message[]): Promise<MessageParam[]> {
	let payload: unknown;
	const client = { messages: { create: () => ({ asResponse: async () => anthropicResponse() }) } };
	await streamAnthropic(model, { messages, tools }, {
		apiKey: "test",
		client,
		onPayload: (params: unknown) => {
			payload = params;
		},
	} as unknown as Parameters<typeof streamAnthropic>[2]).result();
	return (payload as { messages: MessageParam[] }).messages;
}

describe("restoreToolResultAdjacency", () => {
	it("pulls a displaced tool result back next to its assistant turn", () => {
		const injected = user("[harbor-captain-wake] attention");
		const repaired = restoreToolResultAdjacency([
			user("go"),
			assistantWithToolCalls("toolu_1"),
			injected,
			toolResult("toolu_1"),
		]);

		expect(roles(repaired)).toEqual(["user", "assistant", "toolResult:toolu_1", "user"]);
		// The injection is preserved, only moved after the pair it split.
		expect(repaired).toContain(injected);
	});

	it("keeps several injections and a parallel tool batch intact", () => {
		const repaired = restoreToolResultAdjacency([
			assistantWithToolCalls("toolu_1", "toolu_2"),
			user("wake 1"),
			user("wake 2"),
			toolResult("toolu_1"),
			user("wake 3"),
			toolResult("toolu_2"),
		]);

		expect(roles(repaired)).toEqual([
			"assistant",
			"toolResult:toolu_1",
			"toolResult:toolu_2",
			"user",
			"user",
			"user",
		]);
	});

	it("drops a tool result whose tool call is absent from the history", () => {
		const repaired = restoreToolResultAdjacency([user("go"), toolResult("toolu_ghost")]);
		expect(roles(repaired)).toEqual(["user"]);
	});

	it("drops a duplicate result for an already-settled call", () => {
		const repaired = restoreToolResultAdjacency([
			assistantWithToolCalls("toolu_1"),
			toolResult("toolu_1", "first"),
			toolResult("toolu_1", "second"),
		]);
		expect(roles(repaired)).toEqual(["assistant", "toolResult:toolu_1"]);
		expect((repaired[1] as ToolResultMessage).content).toEqual([{ type: "text", text: "first" }]);
	});

	it("returns the identical array for a well-formed history (no cache disturbance)", () => {
		const messages = [user("go"), assistantWithToolCalls("toolu_1"), toolResult("toolu_1"), user("next")];
		expect(restoreToolResultAdjacency(messages)).toBe(messages);
	});
});

describe("injected message during an in-flight tool call", () => {
	it("keeps tool_use -> tool_result adjacency in the rendered Anthropic payload", async () => {
		// Exactly the recorded shape of the killed session: assistant toolCall,
		// three harbor-captain-wake injections, then the tool result.
		const params = await renderAnthropicPayload([
			user("go"),
			assistantWithToolCalls("toolu_01BWY9oaSjQVJJSyc9Pk1piL"),
			user("[harbor-captain-wake] 1"),
			user("[harbor-captain-wake] 2"),
			user("[harbor-captain-wake] 3"),
			toolResult("toolu_01BWY9oaSjQVJJSyc9Pk1piL"),
		]);

		expect(findToolUseAdjacencyViolations(params)).toEqual([]);

		const assistantIndex = params.findIndex(
			(m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"),
		);
		const next = params[assistantIndex + 1]!;
		expect(next.role).toBe("user");
		expect(Array.isArray(next.content) && next.content[0]?.type).toBe("tool_result");

		// No injection is lost, and none carries a synthetic "No result provided".
		const text = JSON.stringify(params);
		for (const n of [1, 2, 3]) expect(text).toContain(`[harbor-captain-wake] ${n}`);
		expect(text).not.toContain("No result provided");
	});

	it("recovers an already-poisoned transcript instead of replaying the 400", async () => {
		// The session that survived /reload: an orphan tool_result with no
		// corresponding tool_use anywhere in the history.
		const params = await renderAnthropicPayload([
			user("go"),
			toolResult("toolu_017PSXmggdZ3P2oVhbbW2dSx"),
			user("continue"),
		]);

		expect(JSON.stringify(params)).not.toContain("toolu_017PSXmggdZ3P2oVhbbW2dSx");
		expect(findToolUseAdjacencyViolations(params)).toEqual([]);
	});

	it("still settles a genuinely abandoned tool call", () => {
		// Adjacency repair must not swallow the existing orphan-tool_use guard.
		const result = transformMessages([user("go"), assistantWithToolCalls("toolu_1"), user("stop")], model);
		expect(roles(result)).toEqual(["user", "assistant", "toolResult:toolu_1", "user"]);
	});
});
