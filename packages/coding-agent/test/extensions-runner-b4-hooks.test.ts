/**
 * Tests for the B4 hook batch added to the extension API:
 *
 * - `pi.registerTelemetry(impl)` + `pi.getTelemetry()` + the runner's
 *   `getTelemetry()` accessor. First-registration-wins to protect live
 *   consumers from accidental double-loads.
 * - Documents which existing on() events carry the instrument-point metadata
 *   that `pi-observability` will fan into the telemetry sink: provider
 *   before/after (`before_provider_request`, `after_provider_response`),
 *   compaction before/after (`session_before_compact`, `session_compact`),
 *   tool-call before/after (`tool_call`, `tool_result`). Those event shapes
 *   already exist in core; B4 does not duplicate them.
 *
 * Each hook is verified along two axes: it fires when an extension registers,
 * and existing behavior is unchanged when no extension registers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	AgentTelemetry,
	ExtensionActions,
	ExtensionContextActions,
	LoadExtensionsResult,
	TelemetryEvent,
} from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("ExtensionRunner B4 hooks", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-b4-hooks-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = await createModelRegistry(authStorage, tempDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		getToolDefinitions: () => [],
		getCustomEntries: () => [],
		setActiveTools: () => {},
		setDeferredOverrides: () => {},
		setToolNamespaces: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		setExtensionConfigValue: () => {},
	};

	const extensionContextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		requestStopAfterTurn: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		reload: async () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getEffectiveSystemPrompt: async () => "",
		forkAgent: async () => {
			throw new Error("forkAgent not implemented in test runner");
		},
		transcriptAppend: () => {},
		getScopedModels: () => [],
	};

	const createRunner = (result: LoadExtensionsResult): ExtensionRunner => {
		const runner = new ExtensionRunner(
			result.extensions,
			result.deferredExtensions,
			result.runtime,
			result.eventBus,
			tempDir,
			sessionManager,
			modelRegistry,
		);
		runner.bindCore(extensionActions, extensionContextActions);
		return runner;
	};

	describe("registerTelemetry / getTelemetry", () => {
		it("lets a producer extension publish a telemetry sink that consumers read through core only", async () => {
			const producer = `
				const recorded = [];
				globalThis.__b4TelemetryInstance = {
					record(event) { recorded.push(event); },
					_recorded: recorded,
				};
				export default function(pi) {
					pi.registerTelemetry(globalThis.__b4TelemetryInstance);
				}
			`;
			const consumer = `
				globalThis.__b4ConsumerReadback = null;
				export default function(pi) {
					globalThis.__b4ConsumerReadback = pi.getTelemetry();
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-producer.ts"), producer);
			fs.writeFileSync(path.join(extensionsDir, "b-consumer.ts"), consumer);

			await discoverAndLoadExtensions([], tempDir, tempDir);

			const consumerReadback = (globalThis as any).__b4ConsumerReadback as AgentTelemetry | null;
			const producerInstance = (globalThis as any).__b4TelemetryInstance as AgentTelemetry;
			expect(consumerReadback).toBe(producerInstance);

			// Consumer fan-in works through the shared sink.
			consumerReadback?.record({ type: "memory.saved", entryId: "abc-123" });
			consumerReadback?.record({ type: "goal.tick", status: "active" });
			const recorded = (producerInstance as any)._recorded as TelemetryEvent[];
			expect(recorded.map((e) => e.type)).toEqual(["memory.saved", "goal.tick"]);

			delete (globalThis as any).__b4TelemetryInstance;
			delete (globalThis as any).__b4ConsumerReadback;
		});

		it("first registration wins to protect live consumers from accidental double-loads", async () => {
			const a = `
				globalThis.__b4FirstSink = { record(e) { (globalThis.__b4FirstSinkLog ??= []).push(e); } };
				export default function(pi) {
					pi.registerTelemetry(globalThis.__b4FirstSink);
				}
			`;
			const b = `
				globalThis.__b4SecondSink = { record(e) { (globalThis.__b4SecondSinkLog ??= []).push(e); } };
				export default function(pi) {
					pi.registerTelemetry(globalThis.__b4SecondSink);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), a);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), b);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const sink = runner.getTelemetry();
			expect(sink).toBe((globalThis as any).__b4FirstSink);
			sink?.record({ type: "smoke" });
			expect((globalThis as any).__b4FirstSinkLog).toHaveLength(1);
			expect((globalThis as any).__b4SecondSinkLog).toBeUndefined();

			delete (globalThis as any).__b4FirstSink;
			delete (globalThis as any).__b4SecondSink;
			delete (globalThis as any).__b4FirstSinkLog;
			delete (globalThis as any).__b4SecondSinkLog;
		});

		it("returns undefined when no extension registers a telemetry sink", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);
			expect(runner.getTelemetry()).toBeUndefined();
		});
	});

	describe("instrument-point hooks already cover provider / compaction / tool-call lifecycles", () => {
		it("provider before/after, compaction before/after, and tool-call before/after events are all in the ExtensionAPI", async () => {
			// This is a contract test: it asserts that an extension registering
			// handlers for the six instrument-point events does not blow up at
			// load time and that the runner reports each event as having a
			// handler. The actual firing of these events is exercised by the
			// existing test suites (provider tests, compaction tests, agent-tool
			// tests). B4 does not add new event types because the existing
			// surface already covers the lifecycle.
			const ext = `
				export default function(pi) {
					pi.on("before_provider_request", async () => {});
					pi.on("after_provider_response", async () => {});
					pi.on("session_before_compact", async () => {});
					pi.on("session_compact", async () => {});
					pi.on("tool_call", async () => {});
					pi.on("tool_result", async () => {});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "instrument-points.ts"), ext);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			for (const eventType of [
				"before_provider_request",
				"after_provider_response",
				"session_before_compact",
				"session_compact",
				"tool_call",
				"tool_result",
			]) {
				expect(runner.hasHandlers(eventType)).toBe(true);
			}
		});

		it("a telemetry-bridging extension can fan instrument-point events into the registered telemetry sink", async () => {
			// Pattern that `pi-observability` will follow once it ships: register
			// the telemetry impl, then subscribe to the six instrument-point
			// events and `record()` each one as a TelemetryEvent. This test
			// proves the bridging code can be written entirely outside of core.
			const ext = `
				const events = [];
				globalThis.__b4BridgedEvents = events;
				export default function(pi) {
					const telemetry = {
						record(event) { events.push(event); },
					};
					pi.registerTelemetry(telemetry);

					pi.on("before_provider_request", async (event) => {
						telemetry.record({ type: "provider.before", payload: event.payload });
					});
					pi.on("after_provider_response", async (event) => {
						telemetry.record({ type: "provider.after", status: event.status });
					});
					pi.on("session_before_compact", async () => {
						telemetry.record({ type: "compaction.before" });
					});
					pi.on("session_compact", async () => {
						telemetry.record({ type: "compaction.after" });
					});
					pi.on("tool_call", async (event) => {
						telemetry.record({ type: "tool.before", toolName: event.toolName });
					});
					pi.on("tool_result", async (event) => {
						telemetry.record({ type: "tool.after", toolName: event.toolName });
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "bridge.ts"), ext);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			// Drive synthetic events through the runner's existing dispatchers.
			await runner.emit({ type: "session_before_compact" } as never);
			await runner.emit({ type: "session_compact" } as never);

			const recorded = (globalThis as any).__b4BridgedEvents as TelemetryEvent[];
			const types = recorded.map((e) => e.type);
			expect(types).toContain("compaction.before");
			expect(types).toContain("compaction.after");

			delete (globalThis as any).__b4BridgedEvents;
		});
	});

	describe("absence of extensions leaves B4 surfaces inert", () => {
		it("getTelemetry returns undefined and existing instrument hooks remain off", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);
			expect(runner.getTelemetry()).toBeUndefined();
			for (const eventType of [
				"before_provider_request",
				"after_provider_response",
				"session_before_compact",
				"session_compact",
				"tool_call",
				"tool_result",
			]) {
				expect(runner.hasHandlers(eventType)).toBe(false);
			}
		});
	});
});
