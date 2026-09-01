/**
 * Tests for the B2/B3 hook batch added to the extension API:
 *
 * - B2: `pi.registerAgentDefinitions`, `pi.registerAgentChains`,
 *   `pi.registerContextMode`, plus the runner's `getRegisteredAgentDefinitions`,
 *   `getRegisteredAgentChains`, and `getRegisteredContextMode` accessors that
 *   consumer packages read without an import edge on the producer.
 * - B3: `pi.registerRunRegistry` / `pi.getRunRegistry` plus the runner's
 *   `getRunRegistry` accessor. First-registration-wins so accidental double
 *   loads do not swap the registry under live consumers.
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
	ExtensionActions,
	ExtensionContextActions,
	LoadExtensionsResult,
	RunRegistry,
} from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("ExtensionRunner B2/B3 hooks", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-b2-b3-hooks-"));
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
		setExtensionConfigValue: () => ({}),
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

	describe("agent definitions registry (B2)", () => {
		it("exposes extension-registered agent definitions through the runner", async () => {
			const producer = `
				export default function(pi) {
					pi.registerAgentDefinitions([
						{
							id: "fake-explore",
							description: "Fake explore",
							prompt: "explore",
							source: "builtin",
						},
						{
							id: "fake-decompose",
							description: "Fake decompose",
							prompt: "decompose",
							source: "builtin",
						},
					]);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "producer.ts"), producer);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const ids = runner.getRegisteredAgentDefinitions().map((def) => def.id);
			expect(ids).toEqual(["fake-explore", "fake-decompose"]);
		});

		it("aggregates definitions from every producer extension", async () => {
			fs.writeFileSync(
				path.join(extensionsDir, "a.ts"),
				`export default function(pi) {
					pi.registerAgentDefinitions([{ id: "a", description: "", prompt: "", source: "builtin" }]);
				}`,
			);
			fs.writeFileSync(
				path.join(extensionsDir, "b.ts"),
				`export default function(pi) {
					pi.registerAgentDefinitions([{ id: "b", description: "", prompt: "", source: "builtin" }]);
				}`,
			);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			expect(
				runner
					.getRegisteredAgentDefinitions()
					.map((d) => d.id)
					.sort(),
			).toEqual(["a", "b"]);
		});

		it("returns an empty list when no extension registers definitions", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);
			expect(runner.getRegisteredAgentDefinitions()).toEqual([]);
		});
	});

	describe("agent chains registry (B2)", () => {
		it("exposes extension-registered chains through the runner", async () => {
			const producer = `
				export default function(pi) {
					pi.registerAgentChains([
						{
							name: "fake-chain",
							source: "user",
							path: "/fake/path/chain.yml",
							chain: [{ agent: "explore", task: "stub" }],
						},
					]);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "chains.ts"), producer);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const chains = runner.getRegisteredAgentChains();
			expect(chains).toHaveLength(1);
			expect(chains[0].name).toBe("fake-chain");
			expect(chains[0].chain[0].agent).toBe("explore");
		});

		it("returns an empty list when no extension registers chains", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);
			expect(runner.getRegisteredAgentChains()).toEqual([]);
		});
	});

	describe("context modes registry (B2)", () => {
		it("exposes extension-registered context modes through the runner", async () => {
			const producer = `
				export default function(pi) {
					pi.registerContextMode("agentic-research", {
						includeTranscript: false,
						includeProjectContext: true,
						includeSkills: true,
						includeAppendSystemPrompt: true,
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ctx-mode.ts"), producer);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const policy = runner.getRegisteredContextMode("agentic-research");
			expect(policy).toBeDefined();
			expect(policy?.includeTranscript).toBe(false);
			expect(policy?.includeProjectContext).toBe(true);
			expect(runner.getRegisteredContextMode("unknown")).toBeUndefined();
		});

		it("last-registration-wins within a single extension; first-extension-wins across extensions", async () => {
			fs.writeFileSync(
				path.join(extensionsDir, "a-shared.ts"),
				`export default function(pi) {
					pi.registerContextMode("shared", {
						includeTranscript: true,
						includeProjectContext: true,
						includeSkills: true,
						includeAppendSystemPrompt: true,
					});
					pi.registerContextMode("shared", {
						includeTranscript: false,
						includeProjectContext: true,
						includeSkills: true,
						includeAppendSystemPrompt: true,
					});
				}`,
			);
			fs.writeFileSync(
				path.join(extensionsDir, "b-shared.ts"),
				`export default function(pi) {
					pi.registerContextMode("shared", {
						includeTranscript: true,
						includeProjectContext: false,
						includeSkills: false,
						includeAppendSystemPrompt: false,
					});
				}`,
			);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			// First extension wins (alphabetical load order: a-shared before b-shared).
			// Within that extension, the second register call overwrites the first.
			const policy = runner.getRegisteredContextMode("shared");
			expect(policy?.includeTranscript).toBe(false);
			expect(policy?.includeProjectContext).toBe(true);
		});

		it("returns undefined when no extension registers a context mode", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);
			expect(runner.getRegisteredContextMode("anything")).toBeUndefined();
		});
	});

	describe("run registry (B3)", () => {
		it("lets a producer extension publish a registry that a consumer reads through core only", async () => {
			// Producer extension writes a custom registry into a global so we can
			// assert that its instance is exactly what the consumer reads back.
			const producer = `
				const runs = new Map();
				runs.set("run-1", { id: "run-1", status: "running" });
				globalThis.__b3RunRegistryInstance = {
					listRuns() { return Array.from(runs.values()); },
					getRun(id) { return runs.get(id); },
				};
				export default function(pi) {
					pi.registerRunRegistry(globalThis.__b3RunRegistryInstance);
				}
			`;
			// Consumer extension only reads via ctx.getRunRegistry \u2014 no import edge on the producer.
			const consumer = `
				globalThis.__b3ConsumerReadback = null;
				export default function(pi) {
					globalThis.__b3ConsumerReadback = pi.getRunRegistry();
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-producer.ts"), producer);
			fs.writeFileSync(path.join(extensionsDir, "b-consumer.ts"), consumer);

			await discoverAndLoadExtensions([], tempDir, tempDir);

			const consumerReadback = (globalThis as any).__b3ConsumerReadback as RunRegistry | null;
			const producerInstance = (globalThis as any).__b3RunRegistryInstance as RunRegistry;

			expect(consumerReadback).toBe(producerInstance);
			expect(consumerReadback?.listRuns()).toEqual([{ id: "run-1", status: "running" }]);
			expect(consumerReadback?.getRun("run-1")).toEqual({ id: "run-1", status: "running" });

			delete (globalThis as any).__b3RunRegistryInstance;
			delete (globalThis as any).__b3ConsumerReadback;
		});

		it("first registration wins to protect live consumers from accidental double-loads", async () => {
			const a = `
				globalThis.__b3FirstRegistry = { listRuns: () => [{ tag: "first" }], getRun: () => undefined };
				export default function(pi) {
					pi.registerRunRegistry(globalThis.__b3FirstRegistry);
				}
			`;
			const b = `
				globalThis.__b3SecondRegistry = { listRuns: () => [{ tag: "second" }], getRun: () => undefined };
				export default function(pi) {
					pi.registerRunRegistry(globalThis.__b3SecondRegistry);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), a);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), b);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const registry = runner.getRunRegistry();
			expect(registry).toBe((globalThis as any).__b3FirstRegistry);
			expect(registry?.listRuns()).toEqual([{ tag: "first" }]);

			delete (globalThis as any).__b3FirstRegistry;
			delete (globalThis as any).__b3SecondRegistry;
		});

		it("returns undefined when no extension registers a run registry", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);
			expect(runner.getRunRegistry()).toBeUndefined();
		});
	});

	describe("absence of extensions leaves new B2/B3 surfaces inert", () => {
		it("getRegistered* returns empty/undefined when no extension registers", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);
			expect(runner.getRegisteredAgentDefinitions()).toEqual([]);
			expect(runner.getRegisteredAgentChains()).toEqual([]);
			expect(runner.getRegisteredContextMode("default")).toBeUndefined();
			expect(runner.getRunRegistry()).toBeUndefined();
		});
	});
});
