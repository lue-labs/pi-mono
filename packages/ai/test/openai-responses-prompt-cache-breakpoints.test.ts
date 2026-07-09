import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { splitSystemPromptAtDynamicBoundary } from "../src/api/openai-prompt-cache.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { type Context, type Model, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../src/types.ts";

function createModel(baseUrl: string, promptCacheApi?: "legacy" | "breakpoints"): Model<"openai-responses"> {
	return {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-responses",
		provider: "openai",
		baseUrl,
		...(promptCacheApi ? { compat: { promptCacheApi } } : {}),
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1050000,
		maxTokens: 128000,
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

interface CaptureOptions {
	promptCacheApi?: "legacy" | "breakpoints";
	cacheRetention?: "none" | "short" | "long";
}

async function captureRequest(context: Context, options?: CaptureOptions): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	const server = createServer(async (request, response) => {
		body = await readBody(request);
		emptySse(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	try {
		const stream = streamOpenAIResponses(
			createModel(`http://127.0.0.1:${address.port}`, options?.promptCacheApi),
			context,
			{
				apiKey: "test-key",
				cacheRetention: options?.cacheRetention ?? "long",
				sessionId: "test-session",
			},
		);
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
	return body;
}

type InputItem = { role?: string; content?: unknown };
type ContentBlock = { type?: string; text?: string; prompt_cache_breakpoint?: { mode?: string } };

function systemMessage(body: Record<string, unknown>): InputItem {
	const input = body.input as InputItem[];
	const message = input.find((item) => item.role === "developer" || item.role === "system");
	expect(message).toBeDefined();
	return message as InputItem;
}

function userMessages(body: Record<string, unknown>): InputItem[] {
	return (body.input as InputItem[]).filter((item) => item.role === "user");
}

const SYSTEM_WITH_BOUNDARY = ["stable rules", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic cwd/date"].join("\n");

describe("splitSystemPromptAtDynamicBoundary", () => {
	it("splits stable prefix from dynamic tail", () => {
		expect(splitSystemPromptAtDynamicBoundary(SYSTEM_WITH_BOUNDARY)).toEqual({
			stable: "stable rules",
			dynamic: "dynamic cwd/date",
		});
	});

	it("treats the whole prompt as stable without a boundary", () => {
		expect(splitSystemPromptAtDynamicBoundary("all stable")).toEqual({ stable: "all stable", dynamic: "" });
	});
});

describe("OpenAI Responses prompt-cache breakpoints", () => {
	it("marks the stable system prefix and omits prompt_cache_retention on breakpoints models", async () => {
		const body = await captureRequest(
			{
				systemPrompt: SYSTEM_WITH_BOUNDARY,
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
			},
			{ promptCacheApi: "breakpoints" },
		);

		expect(body.prompt_cache_retention).toBeUndefined();
		expect(body.prompt_cache_options).toBeUndefined();

		const system = systemMessage(body);
		const content = system.content as ContentBlock[];
		expect(content).toHaveLength(2);
		expect(content[0]).toMatchObject({ type: "input_text", text: "stable rules" });
		expect(content[0]?.prompt_cache_breakpoint).toMatchObject({ mode: "explicit" });
		expect(content[1]).toMatchObject({ type: "input_text", text: "dynamic cwd/date" });
		expect(content[1]?.prompt_cache_breakpoint).toBeUndefined();
	});

	it("marks the whole system prompt when no boundary is present", async () => {
		const body = await captureRequest(
			{
				systemPrompt: "all stable",
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
			},
			{ promptCacheApi: "breakpoints" },
		);

		const content = systemMessage(body).content as ContentBlock[];
		expect(content).toHaveLength(1);
		expect(content[0]?.prompt_cache_breakpoint).toMatchObject({ mode: "explicit" });
	});

	it("anchors the previous user message and leaves the latest one implicit", async () => {
		const body = await captureRequest(
			{
				systemPrompt: SYSTEM_WITH_BOUNDARY,
				messages: [
					{ role: "user", content: "first question", timestamp: 0 },
					{
						role: "assistant",
						content: [{ type: "text", text: "first answer" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.6-sol",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 1,
					},
					{ role: "user", content: "second question", timestamp: 2 },
				],
			},
			{ promptCacheApi: "breakpoints" },
		);

		const users = userMessages(body);
		expect(users).toHaveLength(2);
		const previousBlocks = users[0]?.content as ContentBlock[];
		const latestBlocks = users[1]?.content as ContentBlock[];
		expect(previousBlocks[previousBlocks.length - 1]?.prompt_cache_breakpoint).toMatchObject({ mode: "explicit" });
		for (const block of latestBlocks) expect(block.prompt_cache_breakpoint).toBeUndefined();
	});

	it("emits no breakpoints when cacheRetention is none", async () => {
		const body = await captureRequest(
			{
				systemPrompt: SYSTEM_WITH_BOUNDARY,
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
			},
			{ promptCacheApi: "breakpoints", cacheRetention: "none" },
		);

		expect(body.prompt_cache_retention).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
	});

	it("keeps the legacy path byte-identical for legacy models", async () => {
		const body = await captureRequest(
			{
				systemPrompt: SYSTEM_WITH_BOUNDARY,
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
			},
			{ promptCacheApi: "legacy" },
		);

		expect(body.prompt_cache_retention).toBe("24h");
		expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
		const system = systemMessage(body);
		expect(typeof system.content).toBe("string");
		expect(system.content).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
	});

	it("defaults to legacy when compat is absent", async () => {
		const body = await captureRequest({
			systemPrompt: "all stable",
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});

		expect(body.prompt_cache_retention).toBe("24h");
		expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
	});
});
