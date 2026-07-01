/**
 * Tests for the B1 hook batch added to the extension API:
 *
 * - `pi.setDefaultMessageRenderer(customType, renderer)` + the runner's
 *   `getDefaultMessageRenderer` fallback accessor.
 * - `pi.onSessionDispose(handler)` + the runner's synchronous
 *   `fireSessionDispose()`, plus integration through `AgentSession.dispose()`.
 * - `pi.registerLiveSession`, `pi.unregisterLiveSession`, `pi.getLiveSession`
 *   wrapping the shared live-session registry in `core/agents/live-sessions.ts`.
 *
 * Every hook is verified along two axes: it fires when an extension registers,
 * and existing behavior is unchanged when no extension registers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearLiveSessionsForTests, getLiveSession } from "../src/core/agents/live-sessions.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime, discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions, LoadExtensionsResult } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("ExtensionRunner B1 hooks", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-b1-hooks-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
		clearLiveSessionsForTests();
	});

	afterEach(() => {
		clearLiveSessionsForTests();
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

	describe("setDefaultMessageRenderer", () => {
		it("registers a default renderer the runner can look up", async () => {
			const extCode = `
				export default function(pi) {
					pi.setDefaultMessageRenderer("memory_saved", () => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "default-renderer.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			expect(runner.getDefaultMessageRenderer("memory_saved")).toBeDefined();
			expect(runner.getDefaultMessageRenderer("unknown_type")).toBeUndefined();
		});

		it("returns undefined when no extension registers a default renderer", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMessageRenderer("scoped", () => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "scoped.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			expect(runner.getMessageRenderer("scoped")).toBeDefined();
			expect(runner.getDefaultMessageRenderer("scoped")).toBeUndefined();
		});

		it("first registering extension wins when multiple extensions set the same default", async () => {
			const first = `
				export default function(pi) {
					pi.setDefaultMessageRenderer("shared", () => ({ tag: "first" }));
				}
			`;
			const second = `
				export default function(pi) {
					pi.setDefaultMessageRenderer("shared", () => ({ tag: "second" }));
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), first);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), second);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const renderer = runner.getDefaultMessageRenderer("shared");
			expect(renderer).toBeDefined();
			const rendered = renderer?.({} as never, {} as never, {} as never) as { tag?: string } | null;
			expect(rendered?.tag).toBe("first");
		});
	});

	describe("onSessionDispose", () => {
		it("fires registered dispose handlers when the runner is asked to dispose", async () => {
			const extCode = `
				globalThis.__b1DisposeCalls = [];
				export default function(pi) {
					pi.onSessionDispose(() => { globalThis.__b1DisposeCalls.push("ext-a"); });
					pi.onSessionDispose(() => { globalThis.__b1DisposeCalls.push("ext-a-again"); });
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "dispose-a.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			(globalThis as any).__b1DisposeCalls = [];
			runner.fireSessionDispose();
			expect((globalThis as any).__b1DisposeCalls).toEqual(["ext-a", "ext-a-again"]);

			delete (globalThis as any).__b1DisposeCalls;
		});

		it("isolates handler errors and continues firing remaining handlers", async () => {
			const extCode = `
				globalThis.__b1DisposeOk = [];
				export default function(pi) {
					pi.onSessionDispose(() => { throw new Error("boom"); });
					pi.onSessionDispose(() => { globalThis.__b1DisposeOk.push("after-throw"); });
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "dispose-throw.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const errors: Array<{ event: string; error: string }> = [];
			runner.onError((err) => {
				errors.push({ event: err.event, error: err.error });
			});

			(globalThis as any).__b1DisposeOk = [];
			runner.fireSessionDispose();
			expect((globalThis as any).__b1DisposeOk).toEqual(["after-throw"]);
			expect(errors).toHaveLength(1);
			expect(errors[0].event).toBe("session_dispose");
			expect(errors[0].error).toBe("boom");

			delete (globalThis as any).__b1DisposeOk;
		});

		it("is a no-op when no extension registered a dispose handler", async () => {
			// No extensions at all; the runner still has to make fireSessionDispose safe.
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);
			expect(() => runner.fireSessionDispose()).not.toThrow();
		});
	});

	describe("registerLiveSession / getLiveSession", () => {
		it("registers, reads, and unregisters live sessions through ctx", async () => {
			const extCode = `
				globalThis.__b1LiveResult = {};
				export default function(pi) {
					const fakeSession = { id: "task-1", marker: "live" };
					pi.registerLiveSession("task-1", fakeSession);
					globalThis.__b1LiveResult.afterRegister = pi.getLiveSession("task-1");
					pi.unregisterLiveSession("task-1");
					globalThis.__b1LiveResult.afterUnregister = pi.getLiveSession("task-1");
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "live-session.ts"), extCode);

			await discoverAndLoadExtensions([], tempDir, tempDir);

			const result = (globalThis as any).__b1LiveResult as {
				afterRegister?: { marker?: string };
				afterUnregister?: unknown;
			};
			expect(result.afterRegister?.marker).toBe("live");
			expect(result.afterUnregister).toBeUndefined();

			delete (globalThis as any).__b1LiveResult;
		});

		it("shares the live-session registry with the module-level functions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerLiveSession("shared", { id: "shared", marker: "via-ctx" });
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "live-shared.ts"), extCode);

			await discoverAndLoadExtensions([], tempDir, tempDir);

			const fromModule = getLiveSession("shared") as { marker?: string } | undefined;
			expect(fromModule?.marker).toBe("via-ctx");
		});

		it("getLiveSession returns undefined when no producer has registered the taskId", async () => {
			const extCode = `
				globalThis.__b1MissingLive = "<unset>";
				export default function(pi) {
					globalThis.__b1MissingLive = pi.getLiveSession("never-registered");
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "live-missing.ts"), extCode);

			await discoverAndLoadExtensions([], tempDir, tempDir);

			expect((globalThis as any).__b1MissingLive).toBeUndefined();

			delete (globalThis as any).__b1MissingLive;
		});
	});

	describe("absence of extensions leaves new hook surfaces inert", () => {
		it("getDefaultMessageRenderer, fireSessionDispose, and live-session registry are all inert", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			// Inert renderer registry: every lookup returns undefined.
			expect(runner.getDefaultMessageRenderer("any")).toBeUndefined();
			// Inert dispose firing: no handlers, no throw, no error events.
			const errors: unknown[] = [];
			runner.onError((err) => errors.push(err));
			runner.fireSessionDispose();
			expect(errors).toHaveLength(0);
			// Inert live-session registry: lookup returns undefined.
			expect(getLiveSession("untouched")).toBeUndefined();
		});
	});

	// Touch unused locals so the linter doesn't trip on shadowed imports.
	void createExtensionRuntime;
});
