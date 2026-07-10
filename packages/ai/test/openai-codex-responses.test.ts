import { describe, expect, it } from "vitest";
import {
	_buildRequestBodyForTests as buildRequestBody,
	_buildSSEHeadersForTests as buildSSEHeaders,
	_buildWebSocketHeadersForTests as buildWebSocketHeaders,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model, Tool } from "../src/types.ts";

// Minimal model fixture — buildRequestBody walks through convertResponsesMessages
// which calls downgradeUnsupportedImages, which reads `model.input`. Everything
// else is sane defaults.
const model = {
	id: "gpt-5.4-codex",
	provider: "openai-codex-responses",
	input: ["text", "image"],
	output: ["text"],
	thinkingLevelMap: {},
} as unknown as Model<"openai-codex-responses">;

function buildBodyWith(tools: Tool[]) {
	const context: Context = {
		systemPrompt: "",
		messages: [],
		tools,
	};
	return buildRequestBody(model, context);
}

describe("buildRequestBody — Codex prompt cache", () => {
	it("keeps the session-id cache-key fallback but never sends prompt_cache_retention", () => {
		const context: Context = {
			systemPrompt: "",
			messages: [],
		};
		const body = buildRequestBody(model, context, {
			sessionId: "codex-session",
		});

		expect(body.prompt_cache_key).toBe("codex-session");
		// ChatGPT Codex backend rejects prompt_cache_retention ("Unsupported
		// parameter"); it must never be forwarded even when retention resolves long.
		expect(body.prompt_cache_retention).toBeUndefined();
	});

	it("honors scoped PI_CACHE_RETENTION defaults", () => {
		const context: Context = {
			systemPrompt: "",
			messages: [],
		};

		const shortBody = buildRequestBody(model, context, {
			sessionId: "codex-session",
			env: { PI_CACHE_RETENTION: "short" },
		});
		const noneBody = buildRequestBody(model, context, {
			sessionId: "codex-session",
			env: { PI_CACHE_RETENTION: "none" },
		});
		const explicitLongBody = buildRequestBody(model, context, {
			cacheRetention: "long",
			sessionId: "codex-session",
			env: { PI_CACHE_RETENTION: "none" },
		});

		expect(shortBody.prompt_cache_retention).toBeUndefined();
		expect(shortBody.prompt_cache_key).toBe("codex-session");
		expect(noneBody.prompt_cache_retention).toBeUndefined();
		expect(noneBody.prompt_cache_key).toBeUndefined();
		// Codex never forwards prompt_cache_retention regardless of resolution; the
		// prompt_cache_key affinity still tracks the retention mode (none => omit).
		expect(explicitLongBody.prompt_cache_retention).toBeUndefined();
		expect(explicitLongBody.prompt_cache_key).toBe("codex-session");
	});

	it("derives a UUID-shaped Codex thread cache key from Pi cache affinity", () => {
		const context: Context = {
			systemPrompt: "",
			messages: [],
		};
		const body = buildRequestBody(model, context, {
			cacheRetention: "long",
			sessionId: "pi-session-id",
			cacheAffinityKey: "pi:openai-codex:gpt-5.5:abc123",
		});
		const sameBody = buildRequestBody(model, context, {
			cacheRetention: "long",
			sessionId: "other-pi-session-id",
			cacheAffinityKey: "pi:openai-codex:gpt-5.5:abc123",
		});

		expect(body.prompt_cache_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(sameBody.prompt_cache_key).toBe(body.prompt_cache_key);
	});

	it("includes provider-visible prompt shape in the Codex cache key", () => {
		const contextA: Context = {
			systemPrompt: "stable system",
			messages: [],
			tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } } as Tool],
		};
		const contextB: Context = {
			systemPrompt: "stable system",
			messages: [],
			tools: [
				{ name: "read", description: "Read", parameters: { type: "object", properties: {} } } as Tool,
				{ name: "write", description: "Write", parameters: { type: "object", properties: {} } } as Tool,
			],
		};
		const options = {
			cacheRetention: "long" as const,
			sessionId: "pi-session-id",
			cacheAffinityKey: "pi:openai-codex:gpt-5.5:abc123",
		};

		const bodyA = buildRequestBody(model, contextA, options);
		const sameShapeDifferentSession = buildRequestBody(model, contextA, { ...options, sessionId: "other-session" });
		const bodyB = buildRequestBody(model, contextB, options);

		expect(sameShapeDifferentSession.prompt_cache_key).toBe(bodyA.prompt_cache_key);
		expect(bodyB.prompt_cache_key).not.toBe(bodyA.prompt_cache_key);
	});

	it("serializes Ultra as max, never as a literal wire effort", () => {
		const context: Context = { systemPrompt: "", messages: [] };
		const fallbackBody = buildRequestBody(model, context, { reasoningEffort: "ultra" });
		const explicitUltraBody = buildRequestBody({ ...model, thinkingLevelMap: { ultra: "MAX" as "max" } }, context, {
			reasoningEffort: "ultra",
		});

		expect(fallbackBody.reasoning?.effort).toBe("max");
		expect(explicitUltraBody.reasoning?.effort).toBe("max");
	});

	it("uses the stable Codex cache key as the Codex thread/request id", () => {
		const threadId = "11111111-2222-5333-8444-555555555555";
		const sseHeaders = buildSSEHeaders(undefined, undefined, "account-id", "token", "pi-session-id", threadId);
		const websocketHeaders = buildWebSocketHeaders(
			undefined,
			undefined,
			"account-id",
			"token",
			"pi-session-id",
			threadId,
		);

		expect(sseHeaders.get("session-id")).toBe("pi-session-id");
		expect(sseHeaders.get("thread-id")).toBe(threadId);
		expect(sseHeaders.get("x-client-request-id")).toBe(threadId);
		expect(websocketHeaders.get("session-id")).toBe("pi-session-id");
		expect(websocketHeaders.get("thread-id")).toBe(threadId);
		expect(websocketHeaders.get("x-client-request-id")).toBe(threadId);
	});
});

describe("buildRequestBody — tool_search injection for deferred tools", () => {
	it("does not inject tool_search when no tool has deferLoading", () => {
		const body = buildBodyWith([
			{
				name: "echo",
				description: "Echo input back",
				parameters: { type: "object", properties: {} },
			} as Tool,
		]);
		const tools = (body.tools ?? []) as unknown as Array<Record<string, unknown>>;
		expect(tools.find((t) => t.type === "tool_search")).toBeUndefined();
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("echo");
	});

	it("prepends a tool_search entry when any tool has deferLoading", () => {
		// OpenAI Responses API requires `{ type: "tool_search" }` in the tools
		// array whenever any function tool has `defer_loading: true`. Without it
		// the API returns 400 `Invalid Value: 'tools.defer_loading'. Deferred
		// tools require tools.tool_search.` Observed 2026-05-21 on BER-72
		// corrective wake (Kael OpenClaw via openclaw_gateway adapter,
		// Codex 0.130.0).
		const body = buildBodyWith([
			{
				name: "heartbeat_respond",
				description: "Record a heartbeat outcome.",
				parameters: { type: "object", properties: {} },
				deferLoading: true,
			} as Tool,
			{
				name: "echo",
				description: "Echo input back",
				parameters: { type: "object", properties: {} },
			} as Tool,
		]);
		const tools = (body.tools ?? []) as unknown as Array<Record<string, unknown>>;
		expect(tools[0].type).toBe("tool_search");
		const deferredTool = tools.find((t) => t.name === "heartbeat_respond") as { defer_loading?: boolean } | undefined;
		expect(deferredTool?.defer_loading).toBe(true);
	});
});
