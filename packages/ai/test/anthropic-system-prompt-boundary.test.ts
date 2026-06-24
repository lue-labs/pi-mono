import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { type Context, type Model, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../src/types.ts";

function createModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
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
		const stream = streamAnthropic(createModel(`http://127.0.0.1:${address.port}`), context, {
			apiKey: "test-key",
			cacheRetention: "long",
		});
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

describe("Anthropic system prompt dynamic boundary", () => {
	it("caches the stable system block but not the dynamic tail", async () => {
		const body = await captureRequest({
			systemPrompt: ["stable rules", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic cwd/date"].join("\n"),
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});

		const system = body.system as Array<Record<string, unknown>>;
		expect(system).toHaveLength(2);
		expect(system[0]).toMatchObject({ type: "text", text: "stable rules" });
		expect(system[0]?.cache_control).toMatchObject({ type: "ephemeral", ttl: "1h" });
		expect(system[1]).toMatchObject({ type: "text", text: "dynamic cwd/date" });
		expect(system[1]?.cache_control).toBeUndefined();
	});
});
