import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@valkyriweb/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@valkyriweb/pi-ai";
import { getModel } from "@valkyriweb/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { prepareCompaction } from "../src/core/compaction/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { pickModel } from "./helpers/models.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

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

function stoppedAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
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

describe("AgentSession dynamic tool registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes session state before custom bash spawn hooks and supports opting out", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.create(tempDir, join(agentDir, "sessions"), { id: "bash-env-test" });
		let sessionEnv: NodeJS.ProcessEnv | undefined;
		let optedOutEnv: NodeJS.ProcessEnv | undefined;
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						createBashTool(tempDir, {
							spawnHook: (ctx) => {
								sessionEnv = ctx.env;
								return ctx;
							},
						}),
					);
					pi.registerTool({
						...createBashTool(tempDir, {
							exposeSessionEnvironment: false,
							spawnHook: (ctx) => {
								optedOutEnv = ctx.env;
								return ctx;
							},
						}),
						name: "bash_without_session_env",
						label: "bash without session env",
					});
				},
			],
		});
		await resourceLoader.reload();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			thinkingLevel: "high",
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		expect(session.systemPrompt).toContain(
			"Inspect PI_* environment variables for current model and session details.",
		);
		await bashTool.execute("bash-env", { command: "printf ok" });
		expect(sessionEnv).toMatchObject({
			PI_SESSION_ID: session.sessionId,
			PI_SESSION_FILE: session.sessionFile,
			PI_PROVIDER: model.provider,
			PI_MODEL: model.id,
			PI_REASONING_LEVEL: session.thinkingLevel,
		});

		const optedOutBashTool = session.agent.state.tools.find((tool) => tool.name === "bash_without_session_env")!;
		await optedOutBashTool.execute("bash-no-env", { command: "printf ok" });
		expect(optedOutEnv).not.toHaveProperty("PI_SESSION_ID");
		expect(optedOutEnv).not.toHaveProperty("PI_SESSION_FILE");
		expect(optedOutEnv).not.toHaveProperty("PI_PROVIDER");
		expect(optedOutEnv).not.toHaveProperty("PI_MODEL");
		expect(optedOutEnv).not.toHaveProperty("PI_REASONING_LEVEL");

		session.dispose();
	});

	it("refreshes tool registry when tools are registered after initialization", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							promptGuidelines: ["Use dynamic_tool when the user asks for dynamic behavior tests."],
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("dynamic_tool");

		await session.bindExtensions({});

		const allTools = session.getAllTools();
		const dynamicTool = allTools.find((tool) => tool.name === "dynamic_tool");
		const readTool = allTools.find((tool) => tool.name === "read");

		expect(allTools.map((tool) => tool.name)).toContain("dynamic_tool");
		expect(dynamicTool?.promptGuidelines).toEqual([
			"Use dynamic_tool when the user asks for dynamic behavior tests.",
		]);
		expect(dynamicTool?.sourceInfo).toMatchObject({
			path: "<inline:1>",
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		});
		expect(readTool?.sourceInfo).toMatchObject({
			path: "<builtin:read>",
			source: "builtin",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("dynamic_tool");
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).toContain("- Use dynamic_tool when the user asks for dynamic behavior tests.");

		session.dispose();
	});

	it("does not activate tools registered while deferred extensions load", async () => {
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({ pi: { extensions: [{ path: "./deferred-extension.mjs", load: "deferred" }] } }),
		);
		writeFileSync(
			join(tempDir, "deferred-extension.mjs"),
			`
				export default function(pi) {
					pi.registerTool({
						name: "inactive_dynamic_tool",
						label: "Inactive Dynamic Tool",
						description: "Tool registered but not activated",
						promptSnippet: "Run inactive dynamic test behavior",
						parameters: { type: "object", properties: {}, additionalProperties: false },
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`,
		);

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setProjectPackages([tempDir]);
		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("inactive_dynamic_tool");
		await session.bindExtensions({});
		await new Promise((resolve) => setTimeout(resolve, 350));

		expect(session.getAllTools().map((tool) => tool.name)).toContain("inactive_dynamic_tool");
		expect(session.getActiveToolNames()).not.toContain("inactive_dynamic_tool");
		expect(session.systemPrompt).not.toContain("inactive_dynamic_tool");

		session.dispose();
	});

	it("loads deferred tool schemas and handlers before the first provider request", async () => {
		vi.useFakeTimers();
		try {
			writeFileSync(
				join(tempDir, "package.json"),
				JSON.stringify({ pi: { extensions: [{ path: "./deferred-first-turn.mjs", load: "deferred" }] } }),
			);
			writeFileSync(
				join(tempDir, "deferred-first-turn.mjs"),
				`
				export default function(pi) {
					pi.registerTool({
						name: "first_turn_tool",
						label: "First Turn Tool",
						description: "Must be present before the first provider request",
						parameters: { type: "object", properties: {}, additionalProperties: false },
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					pi.on("before_agent_start", (event) => {
						pi.setActiveTools([...pi.getActiveTools(), "first_turn_tool"]);
						return { systemPrompt: event.systemPrompt + "\\n\\nDEFERRED-FIRST-TURN" };
					});
				}
			`,
			);

			const settingsManager = SettingsManager.create(tempDir, agentDir);
			settingsManager.setProjectPackages([tempDir]);
			const sessionManager = SessionManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
			await resourceLoader.reload();

			const model = pickModel("anthropic");
			let providerToolNames: string[] = [];
			let systemPromptAtProvider = "";
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "Test", tools: [] },
				streamFn: (_model, context) => {
					providerToolNames = context.tools?.map((tool) => tool.name) ?? [];
					systemPromptAtProvider = context.systemPrompt ?? "";
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						const message = stoppedAssistantMessage();
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "stop", message });
					});
					return stream;
				},
			});
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
			const modelRegistry = await createModelRegistry(authStorage, tempDir);
			const session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: tempDir,
				modelRegistry,
				modelRuntime: getModelRuntime(modelRegistry),
				resourceLoader,
			});
			await session.bindExtensions({});

			expect(session.getAllTools().map((tool) => tool.name)).not.toContain("first_turn_tool");

			await session.prompt("first turn");

			expect(providerToolNames).toContain("first_turn_tool");
			expect(systemPromptAtProvider).toContain("DEFERRED-FIRST-TURN");

			session.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("loads deferred tools before manual compaction sends the first provider request", async () => {
		vi.useFakeTimers();
		try {
			writeFileSync(
				join(tempDir, "package.json"),
				JSON.stringify({ pi: { extensions: [{ path: "./deferred-compaction.mjs", load: "deferred" }] } }),
			);
			writeFileSync(
				join(tempDir, "deferred-compaction.mjs"),
				`
				export default function(pi) {
					pi.registerTool({
						name: "deferred_compaction_tool",
						label: "Deferred Compaction Tool",
						description: "Must be present before compaction reaches the provider",
						parameters: { type: "object", properties: {}, additionalProperties: false },
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					pi.on("before_agent_start", () => {
						pi.setActiveTools([...pi.getActiveTools(), "deferred_compaction_tool"]);
					});
				}
			`,
			);

			const settingsManager = SettingsManager.create(tempDir, agentDir);
			settingsManager.setProjectPackages([tempDir]);
			const sessionManager = SessionManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
			await resourceLoader.reload();

			const model = pickModel("anthropic");
			let providerToolNames: string[] = [];
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "Test", tools: [] },
				streamFn: (_model, context) => {
					providerToolNames = context.tools?.map((tool) => tool.name) ?? [];
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						const message = stoppedAssistantMessage();
						message.content = [{ type: "text", text: "summary" }];
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "stop", message });
					});
					return stream;
				},
			});
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
			const modelRegistry = await createModelRegistry(authStorage, tempDir);
			const session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: tempDir,
				modelRegistry,
				modelRuntime: getModelRuntime(modelRegistry),
				resourceLoader,
			});
			await session.bindExtensions({});

			const now = Date.now();
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `message to compact ${"x".repeat(32_000)}` }],
				timestamp: now - 1_000,
			});
			const compactableAssistant = stoppedAssistantMessage();
			compactableAssistant.content = [{ type: "text", text: "x".repeat(32_000) }];
			sessionManager.appendMessage({ ...compactableAssistant, timestamp: now - 750 });
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "recent message to keep" }],
				timestamp: now - 500,
			});
			const recentAssistant = stoppedAssistantMessage();
			recentAssistant.content = [{ type: "text", text: "y".repeat(10_000) }];
			sessionManager.appendMessage({ ...recentAssistant, timestamp: now - 250 });
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "newest turn" }],
				timestamp: now - 100,
			});
			session.agent.state.messages = sessionManager.buildSessionContext().messages;

			expect(session.getAllTools().map((tool) => tool.name)).not.toContain("deferred_compaction_tool");
			expect(
				prepareCompaction(sessionManager.getBranch(), { enabled: true, keepRecentTokens: 100, reserveTokens: 1 }),
			).toBeDefined();
			vi.spyOn(settingsManager, "getCompactionSettings").mockReturnValue({
				enabled: true,
				keepRecentTokens: 100,
				reserveTokens: 1,
				residentPrune: true,
			});

			await session.compact();

			expect(providerToolNames).toContain("deferred_compaction_tool");
			session.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("registers a deferred extension tool without activating it, and adds no core tool_search", async () => {
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({ pi: { extensions: [{ path: "./deferred-extension.mjs", load: "deferred" }] } }),
		);
		writeFileSync(
			join(tempDir, "deferred-extension.mjs"),
			`
				export default function(pi) {
					pi.registerTool({
						name: "late_deferred_tool",
						label: "Late Deferred Tool",
						description: "Deferred tool registered after startup",
						promptSnippet: "Run late deferred behavior",
						deferLoading: true,
						searchHint: "late deferred probe",
						parameters: { type: "object", properties: {}, additionalProperties: false },
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`,
		);

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setProjectPackages([tempDir]);
		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("tool_search");
		await session.bindExtensions({});
		await new Promise((resolve) => setTimeout(resolve, 350));

		// The deferred-tool engine and `tool_search` left fork core in e304781a9
		// (my-pi#1076); the my-pi pi-deferred-tools extension owns them now. Core
		// still registers a deferred tool and keeps it out of the active set, but
		// it no longer conjures a search tool of its own.
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(["late_deferred_tool"]));
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("tool_search");
		expect(session.getActiveToolNames()).not.toContain("late_deferred_tool");

		session.dispose();
	});

	it("activates allow-listed deferred tools and ignores unavailable names", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["allowed_deferred_tool", "unavailable_tool"],
			customTools: [
				{
					name: "allowed_deferred_tool",
					label: "Allowed Deferred Tool",
					description: "Child-scoped deferred tool",
					deferLoading: true,
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				},
			],
		});

		expect(session.getActiveToolNames()).toEqual(["allowed_deferred_tool"]);
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("unavailable_tool");

		session.dispose();
	});

	it("returns source metadata for SDK custom tools", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
			resourceLoader,
			customTools: [
				{
					name: "sdk_tool",
					label: "SDK Tool",
					description: "Tool registered through createAgentSession",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				},
			],
		});

		const sdkTool = session.getAllTools().find((tool) => tool.name === "sdk_tool");
		expect(sdkTool?.sourceInfo).toMatchObject({
			path: "<sdk:sdk_tool>",
			source: "sdk",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("sdk_tool");

		session.dispose();
	});

	it("keeps custom tools active but omits them from available tools when promptSnippet is not provided", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "hidden_tool",
							label: "Hidden Tool",
							description: "Description should not appear in available tools",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toContain("hidden_tool");
		expect(session.getActiveToolNames()).toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("Description should not appear in available tools");

		session.dispose();
	});

	it("lets extensions persist typed state in custom session entries", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("test.counter", { count: 2 });
		let observedCount = 0;

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					const counter = pi.state("test.counter", {
						defaultValue: { count: 0 },
						merge: (_previous, next) => next,
						parse: (value) =>
							value && typeof value === "object" && typeof (value as { count?: unknown }).count === "number"
								? { count: (value as { count: number }).count }
								: undefined,
					});
					pi.on("session_start", () => {
						observedCount = counter.update((current) => ({ count: current.count + 1 })).count;
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({});

		expect(observedCount).toBe(3);
		expect(
			sessionManager
				.getBranch()
				.flatMap((entry) => (entry.type === "custom" && entry.customType === "test.counter" ? [entry.data] : [])),
		).toEqual([{ count: 2 }, { count: 3 }]);

		session.dispose();
	});

	it("exposes full tool definitions through the fluent tools view", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		let deferredMetadata: { deferLoading?: boolean; searchHint?: string } | undefined;

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "deferred_extension_tool",
						label: "Deferred Extension Tool",
						description: "A deferred tool exposed through full definitions",
						parameters: Type.Object({}),
						deferLoading: true,
						searchHint: "deferred metadata probe",
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					});
					pi.on("session_start", () => {
						const definition = pi.tools.definitions().find((tool) => tool.name === "deferred_extension_tool");
						deferredMetadata = definition
							? { deferLoading: definition.deferLoading, searchHint: definition.searchHint }
							: undefined;
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({});

		expect(deferredMetadata).toEqual({ deferLoading: true, searchHint: "deferred metadata probe" });

		session.dispose();
	});

	it("shares opaque services between extensions without replacing the first registration", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		let observedService: { owner: string } | undefined;

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.harness.provide("test.service", { owner: "first" });
				},
				(pi) => {
					pi.harness.provide("test.service", { owner: "second" });
					pi.on("session_start", () => {
						observedService = pi.harness.use<{ owner: string }>("test.service");
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({});

		expect(observedService).toEqual({ owner: "first" });

		session.dispose();
	});

	it("keeps process-scoped services across reload and invalidates stale extension APIs", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const serviceId = `test.reload.${Date.now()}.${Math.random()}`;
		let generation = 0;
		let capturedPi: { getActiveTools(): string[] } | undefined;
		const observedGenerations: number[] = [];

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					generation += 1;
					capturedPi = pi;
					pi.harness.provide(serviceId, { generation }, { scope: "process" });
					pi.on("session_start", () => {
						const service = pi.harness.use<{ generation: number }>(serviceId);
						if (service) observedGenerations.push(service.generation);
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: pickModel("anthropic"),
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({ shutdownHandler: () => {} });
		const stalePi = capturedPi;
		await session.reload();

		expect(observedGenerations).toEqual([1, 1]);
		expect(() => stalePi?.getActiveTools()).toThrow(
			"This extension ctx is stale after session replacement or reload",
		);

		session.dispose();
	});
});
