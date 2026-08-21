/**
 * Anthropic provider — inline deferred-tool schema delivery (fork lane).
 *
 * `compat: { supportsToolReferences: false, inlineDeferredTools: true }` targets
 * gateways that drop the native deferral wire (`defer_loading`/`tool_reference`),
 * e.g. the claude-bridge OAuth lane. Contract:
 *   - Tools activated mid-session (toolResult `addedToolNames`) are excluded from
 *     wire tools[] — tools[] stays byte-identical to the pre-activation request.
 *   - The activated tool's full definition is delivered once as a `<tool-loaded>`
 *     text block appended after the activating tool_result batch.
 *   - The exclusion is permanent: a later assistant toolCall for that tool does
 *     NOT promote it back into tools[] (that would mutate the cached prefix).
 *   - Flag off → legacy behavior (tool ships in tools[]).
 *   - Native tool_reference lanes are untouched.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { AnthropicMessagesCompat, Context, Model, Tool } from "../src/types.ts";

function createModel(baseUrl: string, compat?: AnthropicMessagesCompat): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "claude-opus-4-8",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		...(compat ? { compat } : {}),
	};
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function captureRequest(context: Context, compat?: AnthropicMessagesCompat): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	const server = createServer(async (request, response: ServerResponse) => {
		body = await readBody(request);
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	try {
		const model = createModel(`http://127.0.0.1:${address.port}`, compat);
		const stream = streamAnthropic(model, context, { apiKey: "test-key", cacheRetention: "none" });
		for await (const event of stream) if (event.type === "done" || event.type === "error") break;
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
	}
	return body;
}

const INLINE_COMPAT: AnthropicMessagesCompat = { supportsToolReferences: false, inlineDeferredTools: true };

const eagerTool: Tool = {
	name: "eager_tool",
	description: "A plain eager tool",
	parameters: Type.Object({ value: Type.String() }),
};

const lateTool: Tool = {
	name: "late_tool",
	description: "Activated mid-session via tool_search",
	parameters: Type.Object({ task: Type.String() }),
	deferLoading: true,
};

function activationMessages(): Context["messages"] {
	return [
		{ role: "user", content: "hello", timestamp: 0 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "eager_tool", arguments: { value: "x" } }],
			timestamp: 0,
			api: "anthropic-messages",
			provider: "test-anthropic",
			model: "claude-opus-4-8",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				totalTokens: 0,
			},
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "eager_tool",
			content: [{ type: "text", text: "Loaded late_tool" }],
			isError: false,
			timestamp: 0,
			addedToolNames: ["late_tool"],
		},
	] as Context["messages"];
}

function wireToolNames(body: Record<string, unknown>): string[] {
	return ((body.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
}

function allTextBlocks(body: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const message of (body.messages as Array<{ content: unknown }>) ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<{ type: string; text?: string; content?: unknown }>) {
			if (block.type === "text" && block.text) out.push(block.text);
		}
	}
	return out;
}

describe("Anthropic inline deferred tool schemas", () => {
	it("keeps activated tools out of wire tools[] and delivers the schema as text", async () => {
		const body = await captureRequest(
			{ messages: activationMessages(), tools: [eagerTool, lateTool] },
			INLINE_COMPAT,
		);
		expect(wireToolNames(body)).toEqual(["eager_tool"]);
		const inlineBlocks = allTextBlocks(body).filter((t) => t.includes("<tool-loaded>"));
		expect(inlineBlocks).toHaveLength(1);
		expect(inlineBlocks[0]).toContain('"name":"late_tool"');
		expect(inlineBlocks[0]).toContain('"task"');
		// Never the native wire features this lane cannot serve.
		expect(JSON.stringify(body)).not.toContain("tool_reference");
		expect(JSON.stringify(body.tools)).not.toContain("defer_loading");
	});

	it("tools[] is byte-identical before and after activation", async () => {
		// Pre-activation, tool-search keeps undiscovered deferred tools out of the
		// active set entirely — context.tools carries only the eager tool.
		const preActivation: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
			tools: [eagerTool],
		};
		const before = await captureRequest(preActivation, INLINE_COMPAT);
		const after = await captureRequest(
			{ messages: activationMessages(), tools: [eagerTool, lateTool] },
			INLINE_COMPAT,
		);
		expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
	});

	it("exclusion is permanent after the model calls the activated tool", async () => {
		const messages = [
			...activationMessages(),
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_2", name: "late_tool", arguments: { task: "go" } }],
				timestamp: 0,
				api: "anthropic-messages",
				provider: "test-anthropic",
				model: "claude-opus-4-8",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					totalTokens: 0,
				},
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "late_tool",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 0,
			},
		] as Context["messages"];
		const body = await captureRequest({ messages, tools: [eagerTool, lateTool] }, INLINE_COMPAT);
		expect(wireToolNames(body)).toEqual(["eager_tool"]);
		// The tool_use replay for the excluded tool survives on the wire.
		expect(JSON.stringify(body.messages)).toContain('"late_tool"');
		// Schema delivered exactly once.
		expect(allTextBlocks(body).filter((t) => t.includes("<tool-loaded>"))).toHaveLength(1);
	});

	it("flag off preserves legacy behavior (tool ships in tools[])", async () => {
		const body = await captureRequest(
			{ messages: activationMessages(), tools: [eagerTool, lateTool] },
			{ supportsToolReferences: false },
		);
		expect(wireToolNames(body)).toEqual(["eager_tool", "late_tool"]);
		expect(allTextBlocks(body).filter((t) => t.includes("<tool-loaded>"))).toHaveLength(0);
	});

	it("native tool_reference lanes are untouched by the flag", async () => {
		const body = await captureRequest(
			{ messages: activationMessages(), tools: [eagerTool, lateTool] },
			{ supportsToolReferences: true, inlineDeferredTools: true },
		);
		// Reference lane: tool stays in tools[] (as defer_loading stub) and the
		// activating tool_result carries a tool_reference block, not inline text.
		expect(wireToolNames(body)).toEqual(["eager_tool", "late_tool"]);
		expect(JSON.stringify(body.messages)).toContain("tool_reference");
		expect(allTextBlocks(body).filter((t) => t.includes("<tool-loaded>"))).toHaveLength(0);
	});

	it("falls back to eager delivery when every tool would be deferred", async () => {
		const messages = activationMessages().map((m) =>
			m.role === "toolResult" ? { ...m, addedToolNames: ["late_tool", "eager_tool"] } : m,
		) as Context["messages"];
		const body = await captureRequest({ messages, tools: [eagerTool, lateTool] }, INLINE_COMPAT);
		// All-deferred split falls back to sending everything immediately.
		expect(wireToolNames(body)).toEqual(["eager_tool", "late_tool"]);
	});
});
