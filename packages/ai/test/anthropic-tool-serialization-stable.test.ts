/**
 * Regression test for cache-stable tool serialization.
 *
 * Refs: my-pi/docs/cache-break-investigation-2026-05-16.md Fix #2 (~12M
 * write-token saving per 18d traffic window). The Anthropic prompt cache
 * hashes the exact JSON bytes of each tool definition; any per-turn drift
 * in `input_schema.properties` key order, `required` array order, or
 * conditional flag emission triggers a cache-prefix invalidation.
 *
 * `convertTools()` must produce byte-identical output for:
 *   1. the same tool object passed across calls (memoization)
 *   2. two equal tool objects whose schemas have differently-ordered keys
 *      (deterministic sort)
 *   3. nested schema objects whose keys are reordered
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model, Tool } from "../src/types.ts";

function createModel(baseUrl: string, provider = "test-anthropic"): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		api: "anthropic-messages",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function createContext(tools: Tool[]): Context {
	return {
		messages: [{ role: "user", content: "use the tool", timestamp: Date.now() }],
		...(tools.length > 0 ? { tools } : {}),
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

async function captureRequestBody(
	context: Context,
	options: { supportsImages?: boolean; provider?: string; apiKey?: string } = {},
): Promise<Record<string, unknown>> {
	let requestBody: Record<string, unknown> = {};
	const server = createServer(async (request, response) => {
		requestBody = await readBody(request);
		emptySse(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	try {
		const model = createModel(`http://127.0.0.1:${address.port}`, options.provider);
		if (options.supportsImages) model.input = ["text", "image"];
		const stream = streamAnthropic(model, context, {
			apiKey: options.apiKey ?? "test-key",
			cacheRetention: "none",
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
	return requestBody;
}

async function captureToolBytes(context: Context): Promise<string> {
	const body = await captureRequestBody(context);
	return JSON.stringify(body.tools);
}

describe("Anthropic convertTools — cache-stable serialization", () => {
	it("emits byte-identical tools for the same tool reference across calls (memoization)", async () => {
		const tool: Tool = {
			name: "lookup",
			description: "Look up a value",
			parameters: Type.Object({ value: Type.String(), kind: Type.String() }),
		};
		const first = await captureToolBytes(createContext([tool]));
		const second = await captureToolBytes(createContext([tool]));
		expect(second).toBe(first);
	});

	it("emits byte-identical tools when properties keys arrive in different orders", async () => {
		const toolA: Tool = {
			name: "lookup",
			description: "Look up a value",
			parameters: {
				type: "object",
				properties: { alpha: { type: "string" }, beta: { type: "string" }, gamma: { type: "string" } },
				required: [],
			} as Tool["parameters"],
		};
		const toolB: Tool = {
			name: "lookup",
			description: "Look up a value",
			parameters: {
				type: "object",
				properties: { gamma: { type: "string" }, alpha: { type: "string" }, beta: { type: "string" } },
				required: [],
			} as Tool["parameters"],
		};
		const bytesA = await captureToolBytes(createContext([toolA]));
		const bytesB = await captureToolBytes(createContext([toolB]));
		expect(bytesB).toBe(bytesA);
	});

	it("emits byte-identical tools when nested schema object keys are reordered", async () => {
		const toolA: Tool = {
			name: "lookup",
			description: "Look up a value",
			parameters: {
				type: "object",
				properties: {
					value: { type: "string", description: "v", minLength: 1 },
				},
				required: [],
			} as Tool["parameters"],
		};
		const toolB: Tool = {
			name: "lookup",
			description: "Look up a value",
			parameters: {
				type: "object",
				properties: {
					value: { minLength: 1, description: "v", type: "string" },
				},
				required: [],
			} as Tool["parameters"],
		};
		const bytesA = await captureToolBytes(createContext([toolA]));
		const bytesB = await captureToolBytes(createContext([toolB]));
		expect(bytesB).toBe(bytesA);
	});

	it("emits the supplied anthropicServerTool block for claude-bridge only", async () => {
		const webSearch: Tool = {
			name: "web_search",
			description: "Search the web",
			parameters: Type.Object({
				query: Type.String(),
			}),
			anthropicServerTool: {
				name: "web_search",
				type: "web_search_20250305",
				max_uses: 8,
			},
		};

		const claudeBridgeBody = await captureRequestBody(createContext([webSearch]), { provider: "claude-bridge" });
		expect(claudeBridgeBody.tools).toEqual([
			{
				name: "web_search",
				type: "web_search_20250305",
				max_uses: 8,
			},
		]);

		// Non-bridge providers fall back to the client schema.
		const anthropicBody = await captureRequestBody(createContext([webSearch]));
		expect(anthropicBody.tools).toEqual([
			expect.objectContaining({
				name: "web_search",
				input_schema: expect.objectContaining({
					required: ["query"],
				}),
			}),
		]);
	});

	it("deduplicates final Anthropic tool names after OAuth and native-tool conversion", async () => {
		const bashLower: Tool = {
			name: "bash",
			description: "Run a command",
			parameters: Type.Object({ command: Type.String() }),
		};
		const bashUpper: Tool = {
			name: "Bash",
			description: "Run a command",
			parameters: Type.Object({ command: Type.String() }),
		};
		const webSearchClient: Tool = {
			name: "web_search",
			description: "Search the web",
			parameters: Type.Object({ query: Type.String() }),
		};
		const webSearchServer: Tool = {
			name: "web_search",
			description: "Search the web",
			parameters: Type.Object({ query: Type.String() }),
			anthropicServerTool: { name: "web_search", type: "web_search_20250305", max_uses: 8 },
		};

		const body = await captureRequestBody(createContext([bashLower, bashUpper, webSearchClient, webSearchServer]), {
			provider: "claude-bridge",
			apiKey: "sk-ant-oat-test",
		});
		const names = (body.tools as Array<{ name: string }>).map((tool) => tool.name);

		expect(names).toEqual(["Bash", "web_search"]);
		expect(new Set(names).size).toBe(names.length);
	});

	it("downgrades unsupported image MIME tool results before Anthropic serialization", async () => {
		const body = await captureRequestBody(
			{
				messages: [
					{ role: "user", content: "use image tool", timestamp: Date.now() },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "tool-1", name: "mcp_image", arguments: {} }],
						api: "anthropic-messages",
						provider: "test-anthropic",
						model: "claude-opus-4-7",
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
						toolCallId: "tool-1",
						toolName: "mcp_image",
						content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/bmp" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{ supportsImages: true },
		);

		const serializedMessages = JSON.stringify(body.messages);
		expect(serializedMessages).toContain("Unsupported image MIME image/bmp");
		expect(serializedMessages).not.toContain('"media_type":"image/bmp"');
		expect(serializedMessages).not.toContain('"type":"base64"');
	});

	it("does not duplicate tool results when a hidden empty user message sits before tool output", async () => {
		const body = await captureRequestBody({
			messages: [
				{ role: "user", content: "run commands", timestamp: Date.now() },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "toolu_01", name: "Bash", arguments: { command: "ls" } },
						{ type: "toolCall", id: "toolu_02", name: "Find", arguments: { pattern: "*.md" } },
					],
					api: "anthropic-messages",
					provider: "test-anthropic",
					model: "claude-opus-4-7",
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
				{ role: "user", content: [], timestamp: Date.now() },
				{
					role: "toolResult",
					toolCallId: "toolu_01",
					toolName: "Bash",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "toolu_02",
					toolName: "Find",
					content: [{ type: "text", text: "none" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		const messages = body.messages as Array<{ role: string; content: unknown }>;
		const assistant = messages.find((message) => message.role === "assistant");
		const toolResultMessage = messages.find((message) => {
			const content = message.content;
			return Array.isArray(content) && content.some((block) => block?.type === "tool_result");
		});

		expect((assistant?.content as Array<{ type: string }>).filter((block) => block.type === "tool_use")).toHaveLength(
			2,
		);
		expect(toolResultMessage?.content).toEqual([
			expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_01" }),
			expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_02" }),
		]);
	});

	it("emits byte-identical tools when required array order differs", async () => {
		const toolA: Tool = {
			name: "lookup",
			description: "Look up a value",
			parameters: {
				type: "object",
				properties: { a: { type: "string" }, b: { type: "string" } },
				required: ["a", "b"],
			} as Tool["parameters"],
		};
		const toolB: Tool = {
			name: "lookup",
			description: "Look up a value",
			parameters: {
				type: "object",
				properties: { a: { type: "string" }, b: { type: "string" } },
				required: ["b", "a"],
			} as Tool["parameters"],
		};
		const bytesA = await captureToolBytes(createContext([toolA]));
		const bytesB = await captureToolBytes(createContext([toolB]));
		expect(bytesB).toBe(bytesA);
	});
});
