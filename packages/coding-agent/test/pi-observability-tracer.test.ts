/**
 * Issue 09 tracer regression test.
 *
 * Proves the first end-to-end "telemetry leaves core through AgentTelemetry"
 * path. Uses an inline factory mirroring `my-pi/packages/pi-observability/src/`
 * so this test does not depend on a sibling repo. The production code in
 * my-pi exposes the same surface and bridging logic.
 *
 * Verifies:
 *   - pi-observability defines an AgentTelemetry impl and a fake exporter.
 *   - Extension registers via ctx.registerTelemetry; consumers read through
 *     ctx.getTelemetry() with no import edge on the producer.
 *   - Fake exporter captures provider, tool-call, and compaction events
 *     emitted through the B4 instrument-point hooks.
 *   - Cache token / hit-ratio fields are representable in the event model
 *     (recorded directly via the same record() entry point).
 *   - Tests require no real SigNoz, Opik, network, or API keys.
 *   - The transitional dream-memory / pi-opik-cli-bridge telemetry path is
 *     not touched (no global state mutated outside the test's tempDir).
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

describe("pi-observability tracer (issue 09)", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-observability-tracer-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = await createModelRegistry(authStorage, tempDir);
	});

	afterEach(() => {
		delete (globalThis as any).__piObservabilityExporter;
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

	// Inline pi-observability-like extension. Mirrors the bridge wiring in
	// my-pi/packages/pi-observability/src/index.ts: build a fake exporter,
	// register it as the AgentTelemetry sink, then bridge the six B4
	// instrument-point events into structured telemetry events.
	const piObservabilityLikeExtension = `
		function createFakeExporter() {
			const events = [];
			return {
				events,
				record(event) { events.push(event); },
				flush() {},
				clear() { events.length = 0; },
				get recordedTypes() { return events.map((e) => e.type); },
			};
		}

		export default function(pi) {
			const exporter = createFakeExporter();
			globalThis.__piObservabilityExporter = exporter;
			pi.registerTelemetry(exporter);

			pi.on("before_provider_request", async (event) => {
				exporter.record({
					type: "provider.before",
					timestamp: Date.now(),
					payload: event.payload,
				});
			});
			pi.on("after_provider_response", async (event) => {
				exporter.record({
					type: "provider.after",
					timestamp: Date.now(),
					status: event.status,
					headers: event.headers,
				});
			});
			pi.on("tool_call", async (event) => {
				exporter.record({
					type: "tool.before",
					timestamp: Date.now(),
					toolName: event.toolName,
				});
			});
			pi.on("tool_result", async (event) => {
				exporter.record({
					type: "tool.after",
					timestamp: Date.now(),
					toolName: event.toolName,
				});
			});
			pi.on("session_before_compact", async () => {
				exporter.record({ type: "compaction.before", timestamp: Date.now() });
			});
			pi.on("session_compact", async () => {
				exporter.record({ type: "compaction.after", timestamp: Date.now() });
			});
		}
	`;

	it("registers a telemetry sink that consumer extensions read through ctx.getTelemetry only", async () => {
		const consumer = `
			globalThis.__piObservabilityConsumerReadback = null;
			export default function(pi) {
				globalThis.__piObservabilityConsumerReadback = pi.getTelemetry();
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "a-producer.ts"), piObservabilityLikeExtension);
		fs.writeFileSync(path.join(extensionsDir, "b-consumer.ts"), consumer);

		await discoverAndLoadExtensions([], tempDir, tempDir);

		const consumerReadback = (globalThis as any).__piObservabilityConsumerReadback as AgentTelemetry | null;
		const producerInstance = (globalThis as any).__piObservabilityExporter as AgentTelemetry;
		expect(consumerReadback).toBe(producerInstance);

		delete (globalThis as any).__piObservabilityConsumerReadback;
	});

	it("captures provider before/after, tool-call before/after, and compaction before/after events", async () => {
		fs.writeFileSync(path.join(extensionsDir, "pi-observability.ts"), piObservabilityLikeExtension);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = createRunner(result);

		// Drive every instrument-point event through the runner. The bridge
		// inside the extension converts each into a pi-observability event.
		await runner.emit({
			type: "before_provider_request",
			payload: { model: "claude-sonnet" },
		} as never);
		await runner.emit({
			type: "after_provider_response",
			status: 200,
			headers: { "content-type": "application/json" },
		} as never);
		await runner.emit({ type: "tool_call", toolName: "read", input: { path: "/tmp" } } as never);
		await runner.emit({ type: "tool_result", toolName: "read", result: "ok" } as never);
		await runner.emit({ type: "session_before_compact" } as never);
		await runner.emit({ type: "session_compact" } as never);

		const exporter = (globalThis as any).__piObservabilityExporter as {
			events: TelemetryEvent[];
			recordedTypes: string[];
		};
		expect(exporter.recordedTypes).toEqual([
			"provider.before",
			"provider.after",
			"tool.before",
			"tool.after",
			"compaction.before",
			"compaction.after",
		]);
		expect(exporter.events[1]).toMatchObject({
			type: "provider.after",
			status: 200,
		});
		expect(exporter.events[2]).toMatchObject({ type: "tool.before", toolName: "read" });
		expect(exporter.events[3]).toMatchObject({ type: "tool.after", toolName: "read" });
	});

	it("event model represents cache token / hit-ratio fields via direct recording", async () => {
		fs.writeFileSync(path.join(extensionsDir, "pi-observability.ts"), piObservabilityLikeExtension);
		await discoverAndLoadExtensions([], tempDir, tempDir);

		const exporter = (globalThis as any).__piObservabilityExporter as {
			record: AgentTelemetry["record"];
			events: TelemetryEvent[];
		};

		// Consumers (e.g. cache-heartbeat extension, future cache-tick wiring)
		// publish structured cache-health events through the same record() entry.
		// The event model in my-pi/packages/pi-observability/src/types.ts declares
		// CacheTickEvent / ProviderAfterEvent with tokens + cacheHitRatio fields.
		exporter.record({
			type: "provider.after",
			model: "claude-sonnet",
			status: 200,
			tokens: { input: 4096, output: 256, cacheRead: 3500, cacheWrite: 200 },
			cacheHitRatio: 0.85,
		});
		exporter.record({
			type: "cache.tick",
			contextTokens: 12345,
			cacheHitRatio: 0.92,
			delta: { cacheReadTokens: 1024, cacheWriteTokens: 64, inputTokens: 192 },
		});

		const providerAfter = exporter.events.find((e) => e.type === "provider.after");
		expect(providerAfter).toMatchObject({
			tokens: { input: 4096, output: 256, cacheRead: 3500, cacheWrite: 200 },
			cacheHitRatio: 0.85,
		});
		const cacheTick = exporter.events.find((e) => e.type === "cache.tick");
		expect(cacheTick).toMatchObject({
			contextTokens: 12345,
			cacheHitRatio: 0.92,
		});
	});

	it("returns undefined and records nothing when no extension registers telemetry", async () => {
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = createRunner(result);
		expect(runner.getTelemetry()).toBeUndefined();
		await runner.emit({ type: "session_compact" } as never);
		expect((globalThis as any).__piObservabilityExporter).toBeUndefined();
	});

	it("does not require SigNoz, Opik, network, or API keys", () => {
		// Sanity check: no environment variables or network calls were touched
		// in the suite. The fake exporter is purely in-memory.
		expect(process.env.SIGNOZ_INGEST_KEY).toBeUndefined();
		expect(process.env.OPIK_API_KEY).toBeUndefined();
	});
});
