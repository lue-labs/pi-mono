/**
 * Deferred extensions register their commands only after
 * `loadDeferredExtensions()` runs (~250ms after session start). UI surfaces
 * built from startup snapshots (the slash-command autocomplete list) must be
 * told to rebuild, or deferred commands like /recap never appear in the menu.
 *
 * Covers `ExtensionRunner.onDeferredExtensionsLoaded`:
 * - fires after deferred extensions load, once their commands are resolvable
 * - does not fire when there is nothing deferred
 * - fires at most once (loadDeferredExtensions is memoised)
 *
 * Note: loading extension files requires the workspace `dist/` builds to exist
 * (`packages/{agent,tui,ai}/dist`) — without them the loader falls back to
 * `import.meta.resolve`, which vitest's SSR transform does not provide.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions, LoadExtensionsResult } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("ExtensionRunner deferred extension commands", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-commands-"));
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

	const writeCommandExtension = (name: string): string => {
		const file = path.join(tempDir, `${name}.ts`);
		fs.writeFileSync(
			file,
			`
				export default function(pi) {
					pi.registerCommand("${name}", {
						description: "test command",
						handler: async () => {},
					});
				}
			`,
		);
		return file;
	};

	it("notifies listeners after deferred extensions load and their commands resolve", async () => {
		const file = writeCommandExtension("recap");
		const result = await loadExtensions([{ path: file, load: "deferred" }], tempDir);
		expect(result.errors).toEqual([]);
		const runner = createRunner(result);
		const loadErrors: string[] = [];
		runner.onError((e) => loadErrors.push(e.error));

		// Before the deferred load, the command is invisible — this is the state
		// the startup autocomplete snapshot is built from.
		expect(runner.getCommand("recap")).toBeUndefined();

		let notified = 0;
		runner.onDeferredExtensionsLoaded(() => {
			notified += 1;
			// By notification time the command must already be resolvable, so a
			// rebuild of the autocomplete list picks it up.
			expect(runner.getCommand("recap")).toBeDefined();
		});

		await runner.loadDeferredExtensions();
		expect(loadErrors).toEqual([]);
		expect(notified).toBe(1);
		expect(runner.getCommand("recap")).toBeDefined();

		// Idempotent: a second call must not re-load or re-notify.
		await runner.loadDeferredExtensions();
		expect(notified).toBe(1);
	});

	it("does not notify when there are no deferred extensions", async () => {
		const file = writeCommandExtension("eager");
		const result = await loadExtensions([file], tempDir);
		expect(result.errors).toEqual([]);
		const runner = createRunner(result);

		let notified = 0;
		runner.onDeferredExtensionsLoaded(() => {
			notified += 1;
		});

		await runner.loadDeferredExtensions();
		expect(notified).toBe(0);
		expect(runner.getCommand("eager")).toBeDefined();
	});
});
