/**
 * Anthropic provider — native deferred-tool serialization.
 *
 * Goal coverage:
 *   - `defer_loading: true` is emitted for tools with `deferLoading === true && !alwaysLoad`
 *     when the model supports it (anthropic-messages, non-haiku, compat not disabled).
 *   - `alwaysLoad: true` suppresses defer_loading even if `deferLoading: true`.
 *   - Haiku models and `compat.supportsDeferredTools === false` suppress defer_loading
 *     emission (provider treats the tool as eager).
 *   - Bytes are stable across turns for the same tool reference (cache hash safe).
 *   - Provider sends FULL schemas alongside `defer_loading: true` — full schemas live
 *     in the provider tools list, never re-encoded into the system prompt.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model, Tool } from "../src/types.ts";

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

async function captureRequest(
	context: Context,
	options: { modelId?: string; modelCompat?: { supportsDeferredTools?: boolean } } = {},
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	const server = createServer(async (request, response) => {
		body = await readBody(request);
		emptySse(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	try {
		const model = createModel(`http://127.0.0.1:${address.port}`, options.modelId);
		if (options.modelCompat) {
			(model as { compat?: { supportsDeferredTools?: boolean } }).compat = options.modelCompat;
		}
		const stream = streamAnthropic(model, context, { apiKey: "test-key", cacheRetention: "none" });
		for await (const event of stream) if (event.type === "done" || event.type === "error") break;
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
	}
	return body;
}

const deferredTool: Tool = {
	name: "deferred_one",
	description: "A deferred tool",
	parameters: Type.Object({ query: Type.String() }),
	deferLoading: true,
};

const alwaysLoadDeferredTool: Tool = {
	name: "always_loaded",
	description: "Marked deferLoading but pinned alwaysLoad",
	parameters: Type.Object({ query: Type.String() }),
	deferLoading: true,
	alwaysLoad: true,
};

const eagerTool: Tool = {
	name: "eager_tool",
	description: "A plain eager tool",
	parameters: Type.Object({ value: Type.String() }),
};

describe("Anthropic convertTools — native defer_loading emission", () => {
	it("emits defer_loading:true only for deferLoading && !alwaysLoad on supporting models", async () => {
		const body = await captureRequest(createContext([deferredTool, alwaysLoadDeferredTool, eagerTool]));
		const tools = body.tools as Array<{ name: string; defer_loading?: boolean; input_schema?: unknown }>;
		const byName = new Map(tools.map((t) => [t.name, t]));

		expect(byName.get("deferred_one")?.defer_loading).toBe(true);
		// alwaysLoad always wins: deferred + alwaysLoad → eagerly emitted, no defer_loading flag.
		expect(byName.get("always_loaded")?.defer_loading).toBeUndefined();
		expect(byName.get("eager_tool")?.defer_loading).toBeUndefined();

		// Full schemas remain present alongside defer_loading — schema not omitted from
		// provider tools array, and not pushed into system prompt text.
		expect(byName.get("deferred_one")?.input_schema).toEqual(
			expect.objectContaining({ type: "object", properties: expect.any(Object) }),
		);
		const system = body.system as Array<{ text?: string }> | string | undefined;
		const systemText = Array.isArray(system) ? system.map((b) => b.text ?? "").join("\n") : (system ?? "");
		expect(systemText).not.toContain("defer_loading");
		expect(systemText).not.toContain('"input_schema"');
	});

	it("suppresses defer_loading on haiku models (no native support)", async () => {
		const body = await captureRequest(createContext([deferredTool]), { modelId: "claude-haiku-4-5" });
		const tools = body.tools as Array<{ name: string; defer_loading?: boolean }>;
		expect(tools[0]?.name).toBe("deferred_one");
		expect(tools[0]?.defer_loading).toBeUndefined();
	});

	it("suppresses defer_loading when model.compat.supportsDeferredTools is false", async () => {
		const body = await captureRequest(createContext([deferredTool]), {
			modelCompat: { supportsDeferredTools: false },
		});
		const tools = body.tools as Array<{ name: string; defer_loading?: boolean }>;
		expect(tools[0]?.defer_loading).toBeUndefined();
	});

	it("is byte-stable across two calls with the same Tool reference (cache key safe)", async () => {
		// Same identity → same WeakMap cache entry → identical serialized bytes.
		const first = await captureRequest(createContext([deferredTool]));
		const second = await captureRequest(createContext([deferredTool]));
		expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
	});

	it("is byte-stable when the tool list grows but existing entries are unchanged", async () => {
		// Cache prefix should remain stable; adding a new tool at the end only appends.
		const firstBody = await captureRequest(createContext([deferredTool, eagerTool]));
		const secondBody = await captureRequest(createContext([deferredTool, eagerTool, alwaysLoadDeferredTool]));
		const firstTools = firstBody.tools as unknown[];
		const secondTools = secondBody.tools as unknown[];
		expect(JSON.stringify(secondTools.slice(0, firstTools.length))).toBe(JSON.stringify(firstTools));
	});
});

describe("Anthropic convertTools — message-delivered schema hydration (issue #348)", () => {
	const hydratedTool: Tool = {
		name: "hydrated_one",
		description: "Activated via message-delivered schema",
		parameters: Type.Object({ query: Type.String() }),
		deferLoading: true,
		messageDelivered: true,
	};

	it("omits messageDelivered tools from the wire tools[]", async () => {
		const body = await captureRequest(createContext([eagerTool, hydratedTool]), {
			modelCompat: { supportsDeferredTools: false },
		});
		const tools = body.tools as Array<{ name: string }>;
		expect(tools.map((t) => t.name)).toEqual(["eager_tool"]);
	});

	it("keeps the wire tools[] byte-identical when a messageDelivered tool is added (no cache bust)", async () => {
		// The whole point of #348: activating a deferred tool via message delivery must
		// NOT change the serialized tools[] prefix.
		const before = await captureRequest(createContext([eagerTool]), {
			modelCompat: { supportsDeferredTools: false },
		});
		const after = await captureRequest(createContext([eagerTool, hydratedTool]), {
			modelCompat: { supportsDeferredTools: false },
		});
		expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
	});
});
