import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { pickModel } from "./helpers/models.ts";

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

	it("adds tool_search when a deferred extension is the first deferred-tool provider", async () => {
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

		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["late_deferred_tool", "tool_search"]),
		);
		expect(session.getActiveToolNames()).toContain("tool_search");
		expect(session.getActiveToolNames()).not.toContain("late_deferred_tool");

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
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
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
