/**
 * Issue 07 tracer regression test.
 *
 * Proves the first end-to-end "agent definition lives outside core" path:
 *
 * - An extension (acting as `pi-agents`) registers an agent definition through
 *   `ctx.registerAgentDefinitions` plus a `RunRegistry` impl through
 *   `ctx.registerRunRegistry`.
 * - When the runner binds, it publishes the registered definitions through the
 *   core `extension-source` bridge.
 * - `loadAgentRegistry` merges that bridge into the agent registry without an
 *   import edge from core to the producer package.
 * - Headless consumer code (no `pi-agent-ui`) can discover the agent and read
 *   run state through `ctx.getRunRegistry`.
 *
 * The full extraction of `core/agents/executor.ts` and `status.ts` into the
 * `pi-agents` package is intentionally out of scope for this tracer; later
 * issues move the engine itself. Push / background completion behavior is also
 * left intact in core for this iteration and tracked as a follow-up.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../src/core/agents/executor.ts";
import { clearAgentExtensionDefinitionsProviderForTests } from "../src/core/agents/extension-source.ts";
import { findAgentDefinition, loadAgentRegistry } from "../src/core/agents/registry.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionAPI,
	ExtensionContextActions,
	LoadExtensionsResult,
	RunRegistry,
} from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";
import { createHarness } from "./suite/harness.ts";

describe("pi-agents tracer (issue 07)", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-tracer-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = await createModelRegistry(authStorage, tempDir);
		clearAgentExtensionDefinitionsProviderForTests();
	});

	afterEach(() => {
		clearAgentExtensionDefinitionsProviderForTests();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		commitSessionUnit: (draft) => sessionManager.commitSessionUnit(draft),
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
			throw new Error("forkAgent not implemented in tracer test");
		},
		transcriptAppend: () => {},
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

	// Inline minimal pi-agents-like extension. Registers ONE tracer agent and a
	// RunRegistry adapter. Lives inline so the test does not import the my-pi
	// `pi-agents` package (which lives in a sibling repo) and so the production
	// extension can evolve without breaking this regression test.
	const piAgentsLikeExtension = `
		const runs = new Map();
		runs.set("tracer-run-1", { id: "tracer-run-1", status: "running", agent: "tracer" });

		globalThis.__piAgentsRunRegistry = {
			listRuns() { return Array.from(runs.values()); },
			getRun(id) { return runs.get(id); },
		};

		export default function(pi) {
			pi.registerAgentDefinitions([
				{
					id: "tracer",
					description: "Headless tracer agent owned by pi-agents (issue 07 extraction bullet).",
					prompt: "You are the pi-agents headless tracer agent.",
					source: "builtin",
					defaultContext: "default",
					inheritProjectContext: false,
					inheritSkills: false,
				},
			]);
			pi.registerRunRegistry(globalThis.__piAgentsRunRegistry);
		}
	`;

	it("publishes the registered agent through loadAgentRegistry without an import edge", async () => {
		fs.writeFileSync(path.join(extensionsDir, "pi-agents.ts"), piAgentsLikeExtension);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		createRunner(result);

		// Consumer side: loadAgentRegistry merges in extension defs through the
		// module-level bridge installed by the runner. No code path here imports
		// the pi-agents-like extension directly.
		const registry = await loadAgentRegistry({ cwd: tempDir, agentScope: "user" });
		const tracer = findAgentDefinition(registry, "tracer");

		expect(tracer).toBeDefined();
		expect(tracer?.description).toContain("pi-agents");
		expect(tracer?.defaultContext).toBe("default");

		delete (globalThis as any).__piAgentsRunRegistry;
	});

	it("preserves builtin agents while letting the extension contribute additional ones", async () => {
		fs.writeFileSync(path.join(extensionsDir, "pi-agents.ts"), piAgentsLikeExtension);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		createRunner(result);

		const registry = await loadAgentRegistry({ cwd: tempDir, agentScope: "user" });
		const ids = registry.agents.map((agent) => agent.id);

		// All five built-ins still load alongside the tracer agent.
		for (const builtin of ["general", "worker", "explore", "decompose", "plan", "reviewer"]) {
			expect(ids).toContain(builtin);
		}
		expect(ids).toContain("tracer");

		delete (globalThis as any).__piAgentsRunRegistry;
	});

	it("lets the extension definition override a same-id user/project source for clean extraction", async () => {
		const ext = `
			export default function(pi) {
				pi.registerAgentDefinitions([
					{
						id: "general",
						description: "general from pi-agents (post-extraction)",
						prompt: "general from pi-agents",
						source: "builtin",
					},
				]);
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "pi-agents-override.ts"), ext);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		createRunner(result);

		const registry = await loadAgentRegistry({ cwd: tempDir, agentScope: "user" });
		const general = findAgentDefinition(registry, "general");

		// Extension defs merge after user/project sources; same-id entries win.
		expect(general?.description).toBe("general from pi-agents (post-extraction)");
	});

	it("executes the extension-registered tracer agent without pi-agent-ui", async () => {
		const piAgentsFactory = (pi: ExtensionAPI): void => {
			pi.registerAgentDefinitions([
				{
					id: "tracer",
					description: "Headless tracer agent owned by pi-agents (issue 07 extraction bullet).",
					prompt: "You are the pi-agents headless tracer agent.",
					source: "builtin",
					defaultContext: "default",
					inheritProjectContext: false,
					inheritSkills: false,
				},
			]);
		};
		const harness = await createHarness({ extensionFactories: [piAgentsFactory] });
		harness.setResponses([fauxAssistantMessage("tracer child completed")]);

		try {
			await harness.session.bindExtensions({});
			const details = await executeAgentTool(
				{ mode: "single", tasks: [{ agent: "tracer", task: "prove headless execution" }] },
				{
					parentServices: {
						cwd: harness.tempDir,
						agentDir: harness.tempDir,
						authStorage: harness.authStorage,
						settingsManager: harness.settingsManager,
						modelRegistry: harness.session.modelRegistry,
					},
					parentActiveTools: [],
					parentSessionManager: harness.sessionManager,
					parentModel: harness.getModel(),
					parentThinkingLevel: "off",
				},
			);

			expect(details.status).toBe("completed");
			expect(details.runs[0]?.agent).toBe("tracer");
			expect(details.runs[0]?.finalOutput).toContain("tracer child completed");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("exposes pi-agents run state through ctx.getRunRegistry for headless consumers", async () => {
		const consumer = `
			globalThis.__piAgentsConsumerReadback = null;
			export default function(pi) {
				pi.onSessionDispose(() => {});
				globalThis.__piAgentsConsumerReadback = pi.getRunRegistry();
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "a-producer.ts"), piAgentsLikeExtension);
		fs.writeFileSync(path.join(extensionsDir, "b-consumer.ts"), consumer);

		await discoverAndLoadExtensions([], tempDir, tempDir);

		const readback = (globalThis as any).__piAgentsConsumerReadback as RunRegistry | null;
		const producerInstance = (globalThis as any).__piAgentsRunRegistry as RunRegistry;
		expect(readback).toBe(producerInstance);
		expect(readback?.getRun("tracer-run-1")).toEqual({ id: "tracer-run-1", status: "running", agent: "tracer" });

		delete (globalThis as any).__piAgentsRunRegistry;
		delete (globalThis as any).__piAgentsConsumerReadback;
	});

	it("loadAgentRegistry accepts an explicit extensionDefinitions argument for test isolation", async () => {
		// No extension loaded; pass an explicit empty array AND a one-off
		// definition to prove the explicit path bypasses the module bridge.
		const registry = await loadAgentRegistry({
			cwd: tempDir,
			agentScope: "user",
			extensionDefinitions: [
				{
					id: "isolated-tracer",
					description: "Explicit test-isolated definition",
					prompt: "isolated",
					source: "builtin",
				},
			],
		});
		expect(findAgentDefinition(registry, "isolated-tracer")?.description).toBe("Explicit test-isolated definition");
	});

	it("returns to baseline (no extension defs) when no producer registers", async () => {
		// No extension at all \u2014 just the bridge in its empty state.
		const registry = await loadAgentRegistry({ cwd: tempDir, agentScope: "user" });
		expect(findAgentDefinition(registry, "tracer")).toBeUndefined();
		// Builtins still load.
		expect(findAgentDefinition(registry, "general")).toBeDefined();
	});
});
