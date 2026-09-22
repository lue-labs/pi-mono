import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_buildRequestBodyForTests as buildCodexRequestBody,
	stream as streamCodex,
} from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { insertConfigurationUpdates } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

interface WireItem {
	type?: string;
	role?: string;
	reasoning?: { effort?: string };
	[key: string]: unknown;
}

interface WirePayload {
	input: WireItem[];
	reasoning?: { effort?: string; summary?: string };
}

function codexModel(supportsMidConvoEffort = true): Model<"openai-codex-responses"> {
	return {
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		compat: { sendChatgptAccountId: false, ...(supportsMidConvoEffort ? { supportsMidConvoEffort: true } : {}) },
	};
}

type ModelIdentity = Pick<Model<"openai-responses"> | Model<"openai-codex-responses">, "api" | "provider" | "id">;

function assistant(model: ModelIdentity, level?: string, callId = "call_1"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `${callId}|fc_${callId}`, name: "bash", arguments: { command: "echo" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		...(level === undefined ? {} : { providerThinkingLevel: level }),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

const user = (text: string, timestamp: number) => ({ role: "user" as const, content: text, timestamp });
const toolResult = (callId: string, timestamp: number) => ({
	role: "toolResult" as const,
	toolCallId: `${callId}|fc_${callId}`,
	toolName: "bash",
	content: [{ type: "text" as const, text: "ok" }],
	isError: false,
	timestamp,
});

function updates(payload: WirePayload): string[] {
	return payload.input.flatMap((item, index) =>
		item.type === "configuration_update" ? [`${index}:${item.reasoning?.effort}`] : [],
	);
}

function codexPayload(
	model: Model<"openai-codex-responses">,
	messages: Context["messages"],
	reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "none",
): WirePayload {
	return buildCodexRequestBody(
		model,
		{ systemPrompt: "sys", messages },
		{ reasoningEffort },
	) as unknown as WirePayload;
}

describe("OpenAI mid-conversation effort (configuration_update)", () => {
	it("pins request-level effort to the first turn and appends a trailing update on change", () => {
		const model = codexModel();
		const first = codexPayload(model, [user("one", 1)], "high");
		expect(first.reasoning?.effort).toBe("high");
		expect(updates(first)).toEqual([]);

		const raised = codexPayload(model, [user("one", 1), assistant(model, "high"), toolResult("call_1", 2)], "xhigh");
		expect(raised.reasoning?.effort).toBe("high");
		expect(updates(raised)).toEqual([`${raised.input.length - 1}:xhigh`]);
		expect(raised.input.slice(0, first.input.length)).toEqual(first.input);
	});

	it("replays historical updates at the same positions so the prefix stays byte-stable", () => {
		const model = codexModel();
		const history = [user("one", 1), assistant(model, "high"), toolResult("call_1", 2)];
		const raised = codexPayload(model, history, "xhigh");
		const afterRaise = codexPayload(
			model,
			[...history, assistant(model, "xhigh", "call_2"), toolResult("call_2", 3)],
			"high",
		);
		expect(afterRaise.reasoning?.effort).toBe("high");
		expect(afterRaise.input.slice(0, raised.input.length)).toEqual(raised.input);
		expect(updates(afterRaise)).toEqual([`${raised.input.length - 1}:xhigh`, `${afterRaise.input.length - 1}:high`]);

		const steady = codexPayload(
			model,
			[
				...history,
				assistant(model, "xhigh", "call_2"),
				toolResult("call_2", 3),
				assistant(model, "high", "call_3"),
				toolResult("call_3", 4),
			],
			"high",
		);
		expect(steady.input.slice(0, afterRaise.input.length)).toEqual(afterRaise.input);
		expect(updates(steady)).toEqual([`${raised.input.length - 1}:xhigh`, `${afterRaise.input.length - 1}:high`]);
	});

	it("does not emit an update when the effort is unchanged", () => {
		const model = codexModel();
		const payload = codexPayload(model, [user("one", 1), assistant(model, "high"), toolResult("call_1", 2)], "high");
		expect(payload.reasoning?.effort).toBe("high");
		expect(updates(payload)).toEqual([]);
	});

	it("ignores legacy, other-provider, and other-model assistants when reconstructing history", () => {
		const model = codexModel();
		const legacy = assistant(model);
		const foreign = { ...assistant(model, "low", "call_2"), provider: "other" };
		const otherModel = { ...assistant(model, "low", "call_3"), model: "gpt-5.6-terra" };
		const payload = codexPayload(
			model,
			[
				user("one", 1),
				legacy,
				toolResult("call_1", 2),
				foreign,
				toolResult("call_2", 3),
				otherModel,
				toolResult("call_3", 4),
			],
			"medium",
		);
		expect(payload.reasoning?.effort).toBe("medium");
		expect(updates(payload)).toEqual([]);
	});

	it("uses the active effort as the request-level effort for an empty transcript", () => {
		const plan = insertConfigurationUpdates([], "high");
		expect(plan.input).toEqual([]);
		expect(plan.requestEffort).toBe("high");
	});

	it("falls back to request-level effort without the compat flag or with a disabled level", () => {
		const legacyModel = codexModel(false);
		const legacy = codexPayload(
			legacyModel,
			[user("one", 1), assistant(legacyModel, "high"), toolResult("call_1", 2)],
			"xhigh",
		);
		expect(legacy.reasoning?.effort).toBe("xhigh");
		expect(updates(legacy)).toEqual([]);

		const off = codexPayload(codexModel(), [user("one", 1)], "none");
		expect(off.reasoning).toBeUndefined();
		expect(updates(off)).toEqual([]);
	});

	it("keeps the request-level effort pinned through the OpenAI Responses transport too", async () => {
		const model = {
			...getModel("openai", "gpt-6-astra"),
			baseUrl: "http://127.0.0.1:9",
		} as Model<"openai-responses">;
		expect(model.compat?.supportsMidConvoEffort).toBe(true);
		const history = [user("one", 1), assistant(model, "medium"), toolResult("call_1", 2)];
		let payload: WirePayload | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const result = streamOpenAIResponses(
			model,
			{ systemPrompt: "sys", messages: history },
			{
				apiKey: "test-key",
				cacheRetention: "none",
				reasoningEffort: "xhigh",
				onPayload: (value) => {
					payload = value as WirePayload;
				},
			},
		);
		for await (const event of result) {
			if (event.type === "done" || event.type === "error") break;
		}
		if (!payload) throw new Error("Expected payload capture");
		expect(payload.reasoning?.effort).toBe("medium");
		expect(updates(payload)).toEqual([`${payload.input.length - 1}:xhigh`]);
	});

	it("records the native effort on the response for later replay", async () => {
		const model = codexModel();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const result = streamCodex(
			model,
			{ systemPrompt: "sys", messages: [user("one", 1)] } as unknown as Parameters<typeof streamCodex>[1],
			{ apiKey: "test-key", cacheRetention: "none", reasoningEffort: "xhigh", transport: "sse" },
		);
		for await (const event of result) {
			if (event.type === "done" || event.type === "error") break;
		}
		const message = await result.result();
		expect(message.providerThinkingLevel).toBe("xhigh");
	});

	it("records the effort the wire actually carries when onPayload rewrites it", async () => {
		const model = codexModel();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const result = streamCodex(
			model,
			{ systemPrompt: "sys", messages: [user("one", 1)] } as unknown as Parameters<typeof streamCodex>[1],
			{
				apiKey: "test-key",
				cacheRetention: "none",
				reasoningEffort: "xhigh",
				transport: "sse",
				onPayload: (value) => {
					const body = value as WirePayload;
					return {
						...body,
						input: [...body.input, { type: "configuration_update", reasoning: { effort: "low" } }],
					};
				},
			},
		);
		for await (const event of result) {
			if (event.type === "done" || event.type === "error") break;
		}
		const message = await result.result();
		expect(message.providerThinkingLevel).toBe("low");
	});

	it("generates exact model and transport gates", () => {
		expect(getModel("openai", "gpt-6-astra").compat?.supportsMidConvoEffort).toBe(true);
		expect(getModel("openai-codex", "gpt-6-astra").compat?.supportsMidConvoEffort).toBe(true);
		expect(getModel("openai", "gpt-5.6-terra").compat?.supportsMidConvoEffort).toBeUndefined();
		expect(getModel("openai-codex", "gpt-5.6-terra").compat?.supportsMidConvoEffort).toBeUndefined();
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});
