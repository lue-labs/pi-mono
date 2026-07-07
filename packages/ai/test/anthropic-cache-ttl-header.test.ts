import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model } from "../src/types.ts";

const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

function createModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

async function captureAnthropicRequest(
	cacheRetention: "long" | "short" | "none" | undefined,
	compat?: Model<"anthropic-messages">["compat"],
	headers?: Record<string, string>,
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;

	const server = createServer(async (request, response) => {
		capturedRequest = {
			headers: request.headers,
			body: await readRequestBody(request),
		};
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	const model = { ...createModel(compat), baseUrl: `http://127.0.0.1:${address.port}` };

	try {
		const stream = streamAnthropic(model, context, {
			apiKey: "test-key",
			...(cacheRetention ? { cacheRetention } : {}),
			...(headers ? { headers } : {}),
		});

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	if (!capturedRequest) throw new Error("Anthropic request was not captured");
	return capturedRequest;
}

function getAnthropicBetaHeader(headers: IncomingMessage["headers"]): string {
	const value = headers["anthropic-beta"];
	if (Array.isArray(value)) return value.join(",");
	return value ?? "";
}

describe("Anthropic extended cache TTL beta header", () => {
	it("sends ttl=1h in the payload and the extended-cache-ttl beta by default", async () => {
		const request = await captureAnthropicRequest(undefined);
		const system = request.body.system;
		expect(Array.isArray(system)).toBe(true);
		expect((system as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(getAnthropicBetaHeader(request.headers)).toContain(EXTENDED_CACHE_TTL_BETA);
	});

	it("preserves existing Anthropic betas case-insensitively", async () => {
		const request = await captureAnthropicRequest(undefined, undefined, {
			"Anthropic-Beta": "existing-beta-2026-01-01",
		});
		const betaHeader = getAnthropicBetaHeader(request.headers);
		expect(betaHeader).toContain("existing-beta-2026-01-01");
		expect(betaHeader).toContain(EXTENDED_CACHE_TTL_BETA);
	});

	it("does not send the extended-cache-ttl beta when retention is short", async () => {
		const request = await captureAnthropicRequest("short");
		const system = request.body.system;
		expect(Array.isArray(system)).toBe(true);
		expect((system as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(getAnthropicBetaHeader(request.headers)).not.toContain(EXTENDED_CACHE_TTL_BETA);
	});

	it("does not send the extended-cache-ttl beta when retention is none", async () => {
		const request = await captureAnthropicRequest("none");
		const system = request.body.system;
		expect(Array.isArray(system)).toBe(true);
		expect((system as Array<Record<string, unknown>>)[0]?.cache_control).toBeUndefined();
		expect(getAnthropicBetaHeader(request.headers)).not.toContain(EXTENDED_CACHE_TTL_BETA);
	});

	it("does not send the extended-cache-ttl beta when long retention is unsupported", async () => {
		const request = await captureAnthropicRequest("long", { supportsLongCacheRetention: false });
		const system = request.body.system;
		expect(Array.isArray(system)).toBe(true);
		expect((system as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(getAnthropicBetaHeader(request.headers)).not.toContain(EXTENDED_CACHE_TTL_BETA);
	});
});
