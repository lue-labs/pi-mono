import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
/**
 * Tests for AgentSession concurrent prompt guard.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@valkyriweb/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type ImageContent,
	type TextContent,
} from "@valkyriweb/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BuildSystemPromptOptions } from "../src/core/system-prompt.ts";
import { pickModel } from "./helpers/models.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

// Mock stream that mimics AssistantMessageEventStream
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession concurrent prompt guard", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-concurrent-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		delete (globalThis as typeof globalThis & { testExtensionApi?: unknown }).testExtensionApi;
		delete (globalThis as typeof globalThis & { testCommandRuns?: unknown }).testCommandRuns;
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession() {
		const model = pickModel("anthropic");
		let abortSignal: AbortSignal | undefined;

		// Use a stream function that responds to abort
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		// Set a runtime API key so validation passes
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		return session;
	}

	it("should throw when prompt() called while streaming", async () => {
		await createSession();

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = session.prompt("First message");

		// Wait a tick for isStreaming to be set
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Verify we're streaming
		expect(session.isStreaming).toBe(true);

		// Second prompt should reject
		await expect(session.prompt("Second message")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("should allow steer() while streaming", async () => {
		await createSession();

		// Start first prompt
		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));

		// steer should work while streaming
		expect(() => session.steer("Steering message")).not.toThrow();
		expect(session.pendingMessageCount).toBe(1);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("should allow followUp() while streaming", async () => {
		await createSession();

		// Start first prompt
		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));

		// followUp should work while streaming
		expect(() => session.followUp("Follow-up message")).not.toThrow();
		expect(session.pendingMessageCount).toBe(1);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("should queue extension-origin steering messages while streaming", async () => {
		const model = pickModel("anthropic");
		let abortSignal: AbortSignal | undefined;
		let sawSteeringMessage = false;
		let lastInputSource: string | undefined;
		const queueEvents: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const userTexts = context.messages
						.filter((message) => message.role === "user")
						.map((message) => {
							if (typeof message.content === "string") {
								return message.content;
							}
							return message.content
								.filter((part): part is TextContent | ImageContent => typeof part === "object" && part !== null)
								.filter((part): part is TextContent => part.type === "text")
								.map((part) => part.text)
								.join("\n");
						});

					if (userTexts.includes("Steer from extension")) {
						sawSteeringMessage = true;
						stream.push({ type: "start", partial: createAssistantMessage("") });
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Steered") });
						return;
					}

					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				(globalThis as typeof globalThis & { testExtensionApi?: unknown }).testExtensionApi = pi;
			},
			(pi) => {
				pi.on("input", async (event) => {
					lastInputSource = event.source;
				});
			},
		]);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		session.subscribe((event) => {
			if (event.type === "queue_update") {
				queueEvents.push({ steering: event.steering, followUp: event.followUp });
			}
		});

		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.isStreaming).toBe(true);

		const pi = (
			globalThis as typeof globalThis & {
				testExtensionApi?: {
					sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
				};
			}
		).testExtensionApi;
		expect(pi).toBeDefined();

		pi!.sendUserMessage("Steer from extension", { deliverAs: "steer" });
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(session.pendingMessageCount).toBe(1);
		expect(session.getSteeringMessages()).toContain("Steer from extension");
		expect(lastInputSource).toBe("extension");
		expect(queueEvents.some((event) => event.steering.includes("Steer from extension"))).toBe(true);

		await session.abort();
		await firstPrompt.catch(() => {});

		expect(sawSteeringMessage).toBe(true);
	});

	it("queues prompt() when a run is active but not streaming (compaction/agent_end window)", async () => {
		// Regression: auto-compaction and the agent_end listener phase leave
		// agent.isProcessing true while isStreaming is false. prompt() only gated
		// on isStreaming, fell through to agent.prompt(), and rejected with
		// "Agent is already processing a prompt" — fatal for un-awaited callers
		// (extension sendUserMessage), which crashed the whole TUI process.
		createSession();

		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.agent.isProcessing).toBe(true);

		// Simulate the busy-but-not-streaming window (compaction, agent_end phase).
		(session.agent.state as { isStreaming: boolean }).isStreaming = false;
		expect(session.isStreaming).toBe(false);

		// Must queue (default steer), not race agent.prompt() and reject.
		await expect(session.prompt("Second message")).resolves.toBeUndefined();
		expect(session.getSteeringMessages()).toContain("Second message");

		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("queues sendUserMessage() when a run is active but not streaming", async () => {
		// Same window as above via the extension-facing API — the caller that
		// actually crashed sessions in the wild (idle-return, pi-goal,
		// suggested-tasks all call pi.sendUserMessage un-awaited).
		createSession();

		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		(session.agent.state as { isStreaming: boolean }).isStreaming = false;

		await expect(session.sendUserMessage("Extension message")).resolves.toBeUndefined();
		expect(session.getSteeringMessages()).toContain("Extension message");

		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("falls back to the steering queue when agent.prompt() loses a TOCTOU race", async () => {
		// Regression: a run can start between prompt()'s busy gate and
		// agent.prompt() (post-compaction resume, extension-triggered turn).
		// The rejection must be absorbed by queueing, mirroring
		// sendCustomMessage's fallback, instead of propagating to callers.
		createSession();

		const promptSpy = vi
			.spyOn(session.agent, "prompt")
			.mockRejectedValueOnce(
				new Error(
					"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
				),
			);
		const steerSpy = vi.spyOn(session.agent, "steer");

		await expect(session.prompt("Raced message")).resolves.toBeUndefined();
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(steerSpy).toHaveBeenCalled();
		expect(session.getSteeringMessages()).toContain("Raced message");

		vi.restoreAllMocks();
	});

	it("delivers messages queued while manual compaction held the busy gate", async () => {
		// Review finding on the busy-gate fix: compact() aborts any active run,
		// so a message steered while isCompacting held the gate had no run to
		// drain it — it sat queued until the next prompt (or was lost on exit).
		// compact()'s finally now calls _drainQueuedMessagesPostCompaction().
		const model = pickModel("anthropic");
		const seenUserTexts: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					for (const message of context.messages) {
						if (message.role !== "user" || typeof message.content === "string") continue;
						for (const part of message.content) {
							if (typeof part === "object" && part !== null && part.type === "text") {
								seenUserTexts.push(part.text);
							}
						}
					}
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		// Seed a completed turn so the session is idle with a trailing assistant
		// message — the state compact() leaves behind.
		await session.prompt("First message");
		await session.agent.waitForIdle();
		expect(session.agent.isProcessing).toBe(false);

		// A message queued during compaction (the broadened gate steers it).
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "Queued during compact" }],
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		(session as unknown as { _drainQueuedMessagesPostCompaction: () => void })._drainQueuedMessagesPostCompaction();
		await new Promise((resolve) => setTimeout(resolve, 25));
		await session.agent.waitForIdle();

		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(seenUserTexts).toContain("Queued during compact");
	});

	it("should allow prompt() after previous completes", async () => {
		// Create session with a stream that completes immediately
		const model = pickModel("anthropic");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		// First prompt completes
		await session.prompt("First message");

		// Should not be streaming anymore
		expect(session.isStreaming).toBe(false);

		// Second prompt should work
		await expect(session.prompt("Second message")).resolves.not.toThrow();
	});

	it("should wait for queued agent events before emitting tool_call", async () => {
		const model = pickModel("anthropic");
		const tool = {
			name: "dummy",
			description: "Dummy tool",
			label: "dummy",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_toolCallId: string, params: unknown) => {
				const q =
					typeof params === "object" && params !== null && "q" in params
						? String((params as { q: unknown }).q)
						: "";
				return {
					content: [{ type: "text" as const, text: `result:${q}` }],
					details: {},
				};
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [tool],
			},
			streamFn: async (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const toolResultCount = context.messages.filter((message) => message.role === "toolResult").length;
					if (toolResultCount > 0) {
						const message: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "mock",
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}

					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "toolu_1", name: "dummy", arguments: { q: "x" } },
							{ type: "toolCall", id: "toolu_2", name: "dummy", arguments: { q: "y" } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "mock",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					};

					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { dummy: tool },
		});

		const snapshots: string[][] = [];
		const sessionWithRunner = session as unknown as {
			_extensionRunner?: {
				hasHandlers: (eventType: string) => boolean;
				emit: (event: { type: string; message?: { role?: string } }) => Promise<void>;
				emitMessageEnd: (event: { type: string; message?: { role?: string } }) => Promise<undefined>;
				emitToolCall: (event: { type: string; toolCallId: string }) => Promise<undefined>;
				emitInput: (
					text: string,
					images: unknown,
					source: "interactive" | "rpc" | "extension",
					streamingBehavior?: "steer" | "followUp",
				) => Promise<{ action: "continue" }>;
				emitBeforeAgentStart: (
					prompt: string,
					images: unknown,
					systemPrompt: string,
					systemPromptOptions: BuildSystemPromptOptions,
				) => Promise<undefined>;
				invalidate: (message?: string) => void;
				fireSessionDispose?: () => void;
				applySystemPromptBuildFilters: (
					systemPrompt: string,
					systemPromptOptions: BuildSystemPromptOptions,
				) => Promise<string>;
			};
		};
		sessionWithRunner._extensionRunner = {
			hasHandlers: (eventType) => eventType === "tool_call",
			applySystemPromptBuildFilters: async (systemPrompt: string) => systemPrompt,
			fireSessionDispose: () => {},
			emit: async () => {},
			emitMessageEnd: async () => undefined,
			emitToolCall: async () => {
				snapshots.push(
					sessionManager
						.getEntries()
						.filter((entry) => entry.type === "message")
						.map((entry) => entry.message.role),
				);
				return undefined;
			},
			emitInput: async () => ({ action: "continue" }),
			emitBeforeAgentStart: async () => undefined,
			invalidate: () => {},
		};

		await session.prompt("hi");
		await session.agent.waitForIdle();

		expect(snapshots).toEqual([
			["user", "assistant"],
			["user", "assistant"],
		]);
	});

	it("should persist message_end events in order with slow extension handlers", async () => {
		const model = pickModel("anthropic");
		const tool = {
			name: "dummy",
			description: "Dummy tool",
			label: "dummy",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_toolCallId: string, params: unknown) => {
				const q =
					typeof params === "object" && params !== null && "q" in params
						? String((params as { q: unknown }).q)
						: "";
				return {
					content: [{ type: "text" as const, text: `result:${q}` }],
					details: {},
				};
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [tool],
			},
			streamFn: async (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const hasToolResult = context.messages.some((message) => message.role === "toolResult");

					if (hasToolResult) {
						const message: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "mock",
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}

					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "text", text: "calling tool" },
							{ type: "toolCall", id: "toolu_1", name: "dummy", arguments: { q: "x" } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "mock",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					};

					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { dummy: tool },
		});

		const sessionWithRunner = session as unknown as {
			_extensionRunner?: {
				hasHandlers: (eventType: string) => boolean;
				emit: (event: { type: string; message?: { role?: string } }) => Promise<void>;
				emitMessageEnd: (event: { type: string; message?: { role?: string } }) => Promise<undefined>;
				emitInput: (
					text: string,
					images: unknown,
					source: "interactive" | "rpc" | "extension",
					streamingBehavior?: "steer" | "followUp",
				) => Promise<{ action: "continue" }>;
				emitBeforeAgentStart: (
					prompt: string,
					images: unknown,
					systemPrompt: string,
					systemPromptOptions: BuildSystemPromptOptions,
				) => Promise<undefined>;
				invalidate: (message?: string) => void;
				fireSessionDispose?: () => void;
				applySystemPromptBuildFilters: (
					systemPrompt: string,
					systemPromptOptions: BuildSystemPromptOptions,
				) => Promise<string>;
			};
		};
		sessionWithRunner._extensionRunner = {
			hasHandlers: () => false,
			applySystemPromptBuildFilters: async (systemPrompt: string) => systemPrompt,
			fireSessionDispose: () => {},
			emit: async () => {},
			emitMessageEnd: async (event) => {
				if (event.type === "message_end" && event.message?.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, 40));
				}
				return undefined;
			},
			emitInput: async () => ({ action: "continue" }),
			emitBeforeAgentStart: async () => undefined,
			invalidate: () => {},
		};

		await session.prompt("hi");
		await session.agent.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const messageEntries = sessionManager.getEntries().filter((entry) => entry.type === "message");
		expect(messageEntries.map((entry) => entry.message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});
});
