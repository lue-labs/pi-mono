import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { findToolUseAdjacencyViolations, repairToolUseAdjacency } from "../src/api/tool-use-adjacency.ts";
import type { Tool } from "../src/types.ts";
import { pickModel } from "./helpers/models.ts";

// Real ids from the killed lue-kube goal session (01a0202f), where a payload
// hook re-inserted a user text message between this call and its result.
const INCIDENT_ID = "toolu_01GPPJMqbuzPZC8f8iede1hW";

function assistantWithToolUse(...ids: string[]): MessageParam {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "tool_use" as const, id, name: "ctx_batch_execute", input: {} })),
	};
}

function toolResults(...ids: string[]): MessageParam {
	return {
		role: "user",
		content: ids.map((id) => ({ type: "tool_result" as const, tool_use_id: id, content: "contents" })),
	};
}

const userTurn: MessageParam = { role: "user", content: [{ type: "text", text: "go" }] };
const sentinel: MessageParam = {
	role: "user",
	content: [{ type: "text", text: '__PI_TOOL_CHANGE__\n{"add":["ctx_batch_execute"]}' }],
};

describe("repairToolUseAdjacency", () => {
	it("returns the identical array when every batch is already adjacent", () => {
		const messages = [userTurn, assistantWithToolUse("a", "b"), toolResults("a", "b"), userTurn];
		expect(repairToolUseAdjacency(messages)).toBe(messages);
	});

	it("moves a displaced result back next to its tool_use and re-emits the interloper after it", () => {
		const tail: MessageParam = { role: "user", content: [{ type: "text", text: "carry on" }] };
		const messages = [userTurn, assistantWithToolUse(INCIDENT_ID), sentinel, toolResults(INCIDENT_ID), tail];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		expect(repaired.map((m) => m.role)).toEqual(["user", "assistant", "user", "user", "user"]);
		// results immediately after the assistant turn
		expect(repaired[2]!.content).toEqual([{ type: "tool_result", tool_use_id: INCIDENT_ID, content: "contents" }]);
		// the injected message survives, after the pair
		expect(repaired[3]).toBe(sentinel);
		expect(repaired[4]).toBe(tail);
	});

	it("keeps multiple interlopers in their original order", () => {
		const second: MessageParam = { role: "user", content: [{ type: "text", text: "second" }] };
		const messages = [userTurn, assistantWithToolUse("a"), sentinel, second, toolResults("a")];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		expect(repaired[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "a", content: "contents" }]);
		expect(repaired[3]).toBe(sentinel);
		expect(repaired[4]).toBe(second);
	});

	it("hoists a result that trails other content in the settling message", () => {
		const messages: MessageParam[] = [
			userTurn,
			assistantWithToolUse("a"),
			{
				role: "user",
				content: [
					{ type: "text", text: "one moment" },
					{ type: "tool_result", tool_use_id: "a", content: "contents" },
				],
			},
		];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		expect(repaired[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "a", content: "contents" }]);
		expect(repaired[3]!.content).toEqual([{ type: "text", text: "one moment" }]);
	});

	it("repairs a parallel batch whose results were displaced", () => {
		const messages = [userTurn, assistantWithToolUse("a", "b"), sentinel, toolResults("a", "b")];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		expect(repaired[2]!.content).toEqual([
			{ type: "tool_result", tool_use_id: "a", content: "contents" },
			{ type: "tool_result", tool_use_id: "b", content: "contents" },
		]);
	});

	it("drops a duplicate result for an already-settled call", () => {
		const messages = [userTurn, assistantWithToolUse("a"), toolResults("a"), userTurn, toolResults("a")];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		const resultBlocks = repaired.flatMap((m) =>
			typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result"),
		);
		expect(resultBlocks).toHaveLength(1);
	});

	it("prefers a real result over a synthetic placeholder within the repaired region", () => {
		const synthetic: MessageParam = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "a", content: "No result provided", is_error: true }],
		};
		const messages = [userTurn, assistantWithToolUse("a"), sentinel, synthetic, userTurn, toolResults("a")];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		const resultBlocks = repaired.flatMap((m) =>
			typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result"),
		);
		expect(resultBlocks).toEqual([{ type: "tool_result", tool_use_id: "a", content: "contents" }]);
	});

	it("keeps a placeholder that validly settled its call before the fault, preserving the prefix", () => {
		const synthetic: MessageParam = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "a", content: "No result provided", is_error: true }],
		};
		const messages = [userTurn, assistantWithToolUse("a"), synthetic, userTurn, toolResults("a")];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		// prefix untouched: the valid placeholder settlement keeps its bytes
		expect(repaired[1]).toBe(messages[1]);
		expect(repaired[2]).toBe(synthetic);
		// the trailing duplicate is dropped
		const resultBlocks = repaired.flatMap((m) =>
			typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result"),
		);
		expect(resultBlocks).toHaveLength(1);
	});

	it("drops a result whose tool_use is absent from the request", () => {
		const messages = [userTurn, assistantWithToolUse("a"), toolResults("a", "ghost")];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		const resultBlocks = repaired.flatMap((m) =>
			typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result"),
		);
		expect(resultBlocks).toEqual([{ type: "tool_result", tool_use_id: "a", content: "contents" }]);
	});

	it("leaves an unsettled trailing tool_use alone rather than inventing a result", () => {
		const messages = [userTurn, assistantWithToolUse("a")];
		const repaired = repairToolUseAdjacency(messages);
		expect(repaired).toEqual(messages);
	});

	it("does not touch clean batches while repairing a violated one", () => {
		const cleanAssistant = assistantWithToolUse("clean");
		const cleanResults = toolResults("clean");
		const messages = [userTurn, cleanAssistant, cleanResults, assistantWithToolUse("a"), sentinel, toolResults("a")];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		expect(repaired[1]).toBe(cleanAssistant);
		expect(repaired[2]).toBe(cleanResults);
	});

	it("returns every message before the first fault by reference (cache prefix survives)", () => {
		// A clean batch whose settling message trails extra text — valid on the
		// wire; a repair must not restructure it just because a later fault exists.
		const mixedSettle: MessageParam = {
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "early", content: "contents" },
				{ type: "text", text: "and the sibling content" },
			],
		};
		const earlyAssistant = assistantWithToolUse("early");
		const messages = [userTurn, earlyAssistant, mixedSettle, assistantWithToolUse("a"), sentinel, toolResults("a")];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		expect(repaired[0]).toBe(userTurn);
		expect(repaired[1]).toBe(earlyAssistant);
		expect(repaired[2]).toBe(mixedSettle);
	});

	it("keeps a clean batch settled in a different order than the calls", () => {
		const outOfOrder: MessageParam = {
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "b", content: "contents" },
				{ type: "tool_result", tool_use_id: "a", content: "contents" },
			],
		};
		const pairAssistant = assistantWithToolUse("a", "b");
		const messages = [
			userTurn,
			pairAssistant,
			outOfOrder,
			assistantWithToolUse("late"),
			sentinel,
			toolResults("late"),
		];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		expect(repaired[1]).toBe(pairAssistant);
		expect(repaired[2]).toBe(outOfOrder);
	});

	it("re-attaches the trailing cache_control breakpoint when repair drops its carrier", () => {
		const trailingWithBreakpoint: MessageParam = {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "a",
					content: "contents",
					cache_control: { type: "ephemeral" },
				} as never,
			],
		};
		const messages = [userTurn, assistantWithToolUse("a"), sentinel, trailingWithBreakpoint];

		const repaired = repairToolUseAdjacency(messages);

		expect(findToolUseAdjacencyViolations(repaired)).toEqual([]);
		const breakpoints = repaired.flatMap((m) =>
			typeof m.content === "string" ? [] : m.content.filter((b) => (b as { cache_control?: unknown }).cache_control),
		);
		expect(breakpoints).toHaveLength(1);
	});

	it("returns the input when repair would produce an empty message array", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }] },
		];
		expect(repairToolUseAdjacency(messages)).toBe(messages);
	});
});

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createAnthropicResponse(): Response {
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

describe("anthropic wire repair after onPayload", () => {
	it("restores adjacency when a payload hook injects a message inside a tool_use/tool_result pair", async () => {
		const baseModel = pickModel("anthropic");
		const model = { ...baseModel, provider: "claude-bridge" as const };
		const tools: Tool[] = [
			{ name: "ctx_batch_execute", description: "batch", parameters: Type.Object({ ok: Type.Boolean() }) },
		];

		let sentParams: { messages: MessageParam[] } | undefined;
		const client = {
			messages: {
				create: (params: { messages: MessageParam[] }) => {
					sentParams = params;
					return { asResponse: async () => createAnthropicResponse() };
				},
			},
		};

		await streamAnthropic(
			model,
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: INCIDENT_ID, name: "ctx_batch_execute", arguments: { ok: true } }],
						api: "anthropic-messages",
						provider: model.provider,
						model: model.id,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: INCIDENT_ID,
						toolName: "ctx_batch_execute",
						content: [{ type: "text", text: "big result" }],
						isError: false,
						timestamp: 3,
					},
					{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: 4 },
				],
				tools,
			},
			{
				apiKey: "test",
				client,
				onPayload: (params: unknown) => {
					// Mimic the mid-conversation sentinel lane: re-insert a frozen-position
					// user message that lands between the tool_use and its tool_result.
					const typed = params as { messages: MessageParam[] };
					const messages = [...typed.messages];
					messages.splice(2, 0, sentinel);
					return { ...typed, messages };
				},
			} as unknown as Parameters<typeof streamAnthropic>[2],
		).result();

		expect(sentParams).toBeDefined();
		expect(findToolUseAdjacencyViolations(sentParams!.messages)).toEqual([]);
		const assistantIndex = sentParams!.messages.findIndex((m) => m.role === "assistant");
		const next = sentParams!.messages[assistantIndex + 1]!;
		expect(typeof next.content).not.toBe("string");
		expect((next.content as { type: string }[])[0]!.type).toBe("tool_result");
		// the injected sentinel is preserved, after the pair
		expect(
			sentParams!.messages.some(
				(m) =>
					typeof m.content !== "string" &&
					m.content.some((b) => b.type === "text" && b.text.startsWith("__PI_TOOL_CHANGE__")),
			),
		).toBe(true);
	});
	it("repairs the full lue-kube incident shape: inline-deferred lane, goal custom message, large result, continuation", async () => {
		const baseModel = pickModel("anthropic");
		// The incident lane: clawrouter claude-fable-5-200k declares inline
		// deferred tools with no native tool_reference support.
		const model = {
			...baseModel,
			provider: "claude-bridge" as const,
			compat: { ...baseModel.compat, supportsToolReferences: false, inlineDeferredTools: true },
		};
		const tools: Tool[] = [
			{ name: "ctx_batch_execute", description: "batch", parameters: Type.Object({ ok: Type.Boolean() }) },
			{ name: "read", description: "read", parameters: Type.Object({ path: Type.String() }), deferLoading: true },
		];
		const largeResult = "x".repeat(36_000);

		let sentParams: { messages: MessageParam[] } | undefined;
		const client = {
			messages: {
				create: (params: { messages: MessageParam[] }) => {
					sentParams = params;
					return { asResponse: async () => createAnthropicResponse() };
				},
			},
		};

		await streamAnthropic(
			model,
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "orient" }], timestamp: 1 },
					// pi-goal custom_message converts to a user turn between real turns
					{ role: "user", content: [{ type: "text", text: "<pi_goal_status>{}</pi_goal_status>" }], timestamp: 2 },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: INCIDENT_ID, name: "ctx_batch_execute", arguments: { ok: true } }],
						api: "anthropic-messages",
						provider: model.provider,
						model: model.id,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 3,
					},
					{
						role: "toolResult",
						toolCallId: INCIDENT_ID,
						toolName: "ctx_batch_execute",
						content: [{ type: "text", text: largeResult }],
						isError: false,
						timestamp: 4,
					},
					// pi-goal continuation prompt ends the request
					{ role: "user", content: [{ type: "text", text: "continue with the active goal" }], timestamp: 5 },
				],
				tools,
			},
			{
				apiKey: "test",
				client,
				onPayload: (params: unknown) => {
					// The frozen add-sentinel drifts into the pair once the ephemeral
					// context-tail message from the previous request is gone.
					const typed = params as { messages: MessageParam[] };
					const messages = [...typed.messages];
					const assistantIndex = messages.findIndex((m) => m.role === "assistant");
					messages.splice(assistantIndex + 1, 0, sentinel);
					return { ...typed, messages };
				},
			} as unknown as Parameters<typeof streamAnthropic>[2],
		).result();

		expect(sentParams).toBeDefined();
		expect(findToolUseAdjacencyViolations(sentParams!.messages)).toEqual([]);
		const assistantIndex = sentParams!.messages.findIndex((m) => m.role === "assistant");
		const settling = sentParams!.messages[assistantIndex + 1]!;
		expect(settling.role).toBe("user");
		const first = (settling.content as { type: string; content?: unknown }[])[0]!;
		expect(first.type).toBe("tool_result");
		// the large result payload survives the repair intact
		expect(JSON.stringify(settling.content)).toContain(largeResult);
	});

	it("does not throw when the payload hook returns a frozen, well-formed payload", async () => {
		const baseModel = pickModel("anthropic");
		const model = { ...baseModel, provider: "claude-bridge" as const };
		const tools: Tool[] = [
			{ name: "ctx_batch_execute", description: "batch", parameters: Type.Object({ ok: Type.Boolean() }) },
		];

		let sentParams: { messages: MessageParam[] } | undefined;
		const client = {
			messages: {
				create: (params: { messages: MessageParam[] }) => {
					sentParams = params;
					return { asResponse: async () => createAnthropicResponse() };
				},
			},
		};

		const result = await streamAnthropic(
			model,
			{
				messages: [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }],
				tools,
			},
			{
				apiKey: "test",
				client,
				onPayload: (params: unknown) =>
					// A defensive extension may freeze what it returns; the repair
					// seam must not mutate it in place.
					Object.freeze({ ...(params as object) }),
			} as unknown as Parameters<typeof streamAnthropic>[2],
		).result();

		expect(result.stopReason).not.toBe("error");
		expect(sentParams).toBeDefined();
	});
});
