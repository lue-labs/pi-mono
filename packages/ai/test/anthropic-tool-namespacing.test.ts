/**
 * Anthropic provider — tool-namespace wire prefixing (Phase 2 spike).
 *
 * Anthropic has NO structural namespace object: grouping is a name-prefix
 * convention, and `tool_reference.tool_name` MUST match a defined tool in
 * `tools[]`. So namespacing is a full round-trip:
 *   - `tools[]` definitions carry the prefixed wire name (`<namespace>_<base>`).
 *   - `tool_reference` blocks (discovery results + replayed history) carry the
 *     SAME prefixed name so the server can expand them.
 *   - replayed `tool_use` names are prefixed for consistency.
 *   - dispatch (response tool_use name) strips the prefix back to canonical.
 *
 * Guards:
 *   - prefixed tools[] name + matching tool_reference (round-trip integrity).
 *   - replayed tool_use carries the prefixed name.
 *   - kill-switch PI_ANTHROPIC_NAMESPACE_WIRE=0 collapses to flat, byte-identical
 *     to an un-namespaced tool list (cache golden rule for flag-off).
 *   - no namespace stamped => byte-identical to baseline (flag-off-by-absence).
 *   - namespace participates in the convertedTool cache key (byte-stable repeat).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type AnthropicSdk from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Message, Model, Tool, ToolCall } from "../src/types.ts";
import { pickModel } from "./helpers/models.ts";

function createModel(baseUrl: string, id = "claude-sonnet-4-5"): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function emptySse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

async function captureRequest(context: Context): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	const server = createServer(async (request, response) => {
		body = await readBody(request);
		emptySse(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	try {
		const model = createModel(`http://127.0.0.1:${address.port}`);
		const stream = streamAnthropic(model, context, { apiKey: "test-key", cacheRetention: "none" });
		for await (const event of stream) if (event.type === "done" || event.type === "error") break;
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
	}
	return body;
}

const nsTool: Tool = {
	name: "deferred_one",
	description: "A deferred tool",
	parameters: Type.Object({ query: Type.String() }),
	deferLoading: true,
	namespace: "context",
};

const flatTool: Tool = {
	name: "deferred_one",
	description: "A deferred tool",
	parameters: Type.Object({ query: Type.String() }),
	deferLoading: true,
};

// Assistant turn that referenced the deferred tool (discovery result) and called it.
function historyMessages(): Message[] {
	return [
		{ role: "user", content: "use the tool", timestamp: Date.now() },
		{
			role: "assistant",
			content: [
				{ type: "tool_reference", name: "deferred_one" },
				{ type: "toolCall", id: "call_1", name: "deferred_one", arguments: { query: "x" } },
			],
			timestamp: Date.now(),
		} as unknown as Message,
	];
}

type WireTool = { name: string; defer_loading?: boolean };
type WireBlock = { type: string; tool_name?: string; name?: string };

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeAnthropicClient(response: Response): AnthropicSdk {
	return {
		messages: { create: () => ({ asResponse: async () => response }) },
	} as unknown as AnthropicSdk;
}

// SSE response where the model calls a tool by the given (possibly prefixed) name.
function toolUseResponse(wireName: string): Response {
	return createSseResponse([
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_1", name: wireName, input: {} },
			}),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"query":"x"}' },
			}),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	]);
}

afterEach(() => {
	delete process.env.PI_ANTHROPIC_NAMESPACE_WIRE;
});

describe("Anthropic tool-namespace wire prefixing", () => {
	it("prefixes tools[] and the matching tool_reference (round-trip integrity)", async () => {
		const body = await captureRequest({ messages: historyMessages(), tools: [nsTool] });
		const tools = body.tools as WireTool[];
		const names = tools.map((t) => t.name);

		// Wire name is prefixed; bare canonical name must NOT appear (server matches
		// tool_reference.tool_name against this exact defined name).
		expect(names).toContain("context_deferred_one");
		expect(names).not.toContain("deferred_one");
		expect(tools.find((t) => t.name === "context_deferred_one")?.defer_loading).toBe(true);

		// Every tool_reference / tool_use in the transcript uses the SAME prefixed name.
		const messages = body.messages as Array<{ content: WireBlock[] | string }>;
		const blocks = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
		const ref = blocks.find((b) => b.type === "tool_reference");
		const call = blocks.find((b) => b.type === "tool_use");
		expect(ref?.tool_name).toBe("context_deferred_one");
		expect(call?.name).toBe("context_deferred_one");
		// And the referenced name resolves to a defined tool (no dangling reference).
		expect(names).toContain(ref?.tool_name);
	});

	it("kill-switch PI_ANTHROPIC_NAMESPACE_WIRE=0 collapses to flat, byte-identical to un-namespaced", async () => {
		process.env.PI_ANTHROPIC_NAMESPACE_WIRE = "0";
		const off = await captureRequest({ messages: historyMessages(), tools: [nsTool] });
		delete process.env.PI_ANTHROPIC_NAMESPACE_WIRE;
		const baseline = await captureRequest({ messages: historyMessages(), tools: [flatTool] });
		expect(JSON.stringify(off.tools)).toBe(JSON.stringify(baseline.tools));
		expect(JSON.stringify(off.messages)).toBe(JSON.stringify(baseline.messages));
	});

	it("no namespace stamped => byte-identical to baseline (flag-off-by-absence)", async () => {
		const a = await captureRequest({ messages: historyMessages(), tools: [flatTool] });
		const b = await captureRequest({ messages: historyMessages(), tools: [flatTool] });
		expect((a.tools as WireTool[])[0]?.name).toBe("deferred_one");
		expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
	});

	it("is byte-stable across calls with the same namespaced Tool reference (cache key safe)", async () => {
		const first = await captureRequest({ messages: historyMessages(), tools: [nsTool] });
		const second = await captureRequest({ messages: historyMessages(), tools: [nsTool] });
		expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
	});

	// Blocker #1 from adversarial review: the API-key dispatch path (client option =>
	// isOAuth false) must strip the prefix the model echoes back, or dispatch 404s.
	it("strips the namespace prefix on inbound tool_use dispatch (API-key path)", async () => {
		const model = pickModel("anthropic");
		const context: Context = {
			messages: [{ role: "user", content: "use the tool", timestamp: Date.now() }],
			tools: [nsTool],
		};
		const stream = streamAnthropic(model, context, {
			client: fakeAnthropicClient(toolUseResponse("context_deferred_one")),
		});
		const result = await stream.result();
		const toolCall = result.content.find((b): b is ToolCall => b.type === "toolCall");
		// Model called the prefixed wire name; dispatch must see the canonical tool name.
		expect(toolCall?.name).toBe("deferred_one");
	});

	it("kill-switch off => inbound name passes through unchanged (no spurious strip)", async () => {
		process.env.PI_ANTHROPIC_NAMESPACE_WIRE = "0";
		const model = pickModel("anthropic");
		const context: Context = {
			messages: [{ role: "user", content: "use the tool", timestamp: Date.now() }],
			tools: [flatTool],
		};
		const stream = streamAnthropic(model, context, { client: fakeAnthropicClient(toolUseResponse("deferred_one")) });
		const result = await stream.result();
		const toolCall = result.content.find((b): b is ToolCall => b.type === "toolCall");
		expect(toolCall?.name).toBe("deferred_one");
	});

	// Blocker #2: a namespaced tool whose wire name would collide with another tool's
	// canonical name must NOT be silently dropped — it keeps its canonical name and
	// both tools survive in tools[].
	it("keeps both tools when a prefix would collide with an existing canonical name", async () => {
		const collidingCanonical: Tool = {
			name: "context_deferred_one",
			description: "Pre-existing tool whose name equals the namespaced wire name",
			parameters: Type.Object({ query: Type.String() }),
		};
		const body = await captureRequest({
			messages: [{ role: "user", content: "x", timestamp: Date.now() }],
			tools: [collidingCanonical, nsTool],
		});
		const names = (body.tools as WireTool[]).map((t) => t.name).sort();
		// No silent drop: the colliding canonical stays, and nsTool falls back to canonical.
		expect(names).toEqual(["context_deferred_one", "deferred_one"]);
	});
});
