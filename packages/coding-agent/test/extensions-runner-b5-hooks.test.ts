/**
 * Tests for the B5 hook batch added to the extension API:
 *
 * - `pi.registerMainPane` / `pi.showMainPane` / `pi.hideMainPane`
 * - `pi.registerOverlay` / `pi.showOverlay` / `pi.hideOverlay`
 * - `pi.registerFooter`
 *
 * Plus the runner-side accessors `getRegisteredMainPane`,
 * `getRegisteredOverlay`, `getRegisteredFooters`, and the `bindSlotUI` wiring
 * point used by interactive-mode to back the imperative show/hide API.
 *
 * Every hook is verified along two axes: registration writes to the
 * per-extension registry and the runner exposes it through the getter, and
 * the no-registration baseline keeps the API inert (silent no-ops, empty
 * lists).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner, type ExtensionSlotUIActions } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions, LoadExtensionsResult } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("ExtensionRunner B5 hooks", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-b5-hooks-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
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

	/** Capture every show/hide call so tests can assert the runtime flow end-to-end. */
	const createRecordingSlotActions = (): {
		actions: ExtensionSlotUIActions;
		calls: Array<{ kind: string; id: string; payload?: unknown }>;
	} => {
		const calls: Array<{ kind: string; id: string; payload?: unknown }> = [];
		return {
			calls,
			actions: {
				showMainPane: (id, payload) => calls.push({ kind: "showMainPane", id, payload }),
				hideMainPane: (id) => calls.push({ kind: "hideMainPane", id }),
				showOverlay: (id, payload) => calls.push({ kind: "showOverlay", id, payload }),
				hideOverlay: (id) => calls.push({ kind: "hideOverlay", id }),
			},
		};
	};

	describe("registerMainPane", () => {
		it("writes to the per-extension registry and the runner getter returns the factory", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMainPane("zoom", () => ({ kind: "zoom-component", dispose: () => {} }));
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "zoom-pane.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const factory = runner.getRegisteredMainPane("zoom");
			expect(factory).toBeDefined();
			const component = factory?.({} as never, {} as never, { payload: { taskId: "t-1" }, requestHide: () => {} });
			expect((component as { kind?: string }).kind).toBe("zoom-component");
		});

		it("first registering extension wins when multiple extensions register the same id", async () => {
			const a = `
				export default function(pi) {
					pi.registerMainPane("shared", () => ({ tag: "first" }));
				}
			`;
			const b = `
				export default function(pi) {
					pi.registerMainPane("shared", () => ({ tag: "second" }));
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), a);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), b);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const factory = runner.getRegisteredMainPane("shared");
			expect(factory).toBeDefined();
			const component = factory?.({} as never, {} as never, { payload: undefined, requestHide: () => {} });
			expect((component as { tag?: string }).tag).toBe("first");
		});

		it("showMainPane / hideMainPane delegate to the bound slot-UI handlers", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMainPane("zoom", () => ({}));
					pi.on("session_start", () => {
						pi.showMainPane("zoom", { taskId: "t-1" });
						pi.hideMainPane("zoom");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "zoom-show-hide.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const { actions, calls } = createRecordingSlotActions();
			runner.bindSlotUI(actions);

			await runner.emit({ type: "session_start", reason: "startup" });

			expect(calls).toEqual([
				{ kind: "showMainPane", id: "zoom", payload: { taskId: "t-1" } },
				{ kind: "hideMainPane", id: "zoom" },
			]);
		});

		it("showMainPane is a silent no-op when no slot-UI handler is bound", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMainPane("zoom", () => ({}));
					pi.on("session_start", () => {
						pi.showMainPane("zoom", { taskId: "t-1" });
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "zoom-unbound.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);
			// Deliberately do NOT call runner.bindSlotUI(...). The default no-op stubs
			// in the runtime must swallow the call without throwing.
			await expect(runner.emit({ type: "session_start", reason: "startup" })).resolves.not.toThrow();
		});
	});

	describe("registerOverlay", () => {
		it("writes to the per-extension registry and the runner getter returns the factory", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerOverlay("shortcuts", () => ({ kind: "shortcuts-overlay" }));
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "shortcuts-overlay.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const factory = runner.getRegisteredOverlay("shortcuts");
			expect(factory).toBeDefined();
			const component = factory?.({} as never, {} as never, { payload: undefined, requestHide: () => {} });
			expect((component as { kind?: string }).kind).toBe("shortcuts-overlay");
		});

		it("first registering extension wins when multiple extensions register the same id", async () => {
			const a = `
				export default function(pi) {
					pi.registerOverlay("shared", () => ({ tag: "first" }));
				}
			`;
			const b = `
				export default function(pi) {
					pi.registerOverlay("shared", () => ({ tag: "second" }));
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), a);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), b);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const factory = runner.getRegisteredOverlay("shared");
			expect(factory).toBeDefined();
			const component = factory?.({} as never, {} as never, { payload: undefined, requestHide: () => {} });
			expect((component as { tag?: string }).tag).toBe("first");
		});

		it("showOverlay / hideOverlay delegate to the bound slot-UI handlers", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerOverlay("shortcuts", () => ({}));
					pi.on("session_start", () => {
						pi.showOverlay("shortcuts", { source: "test" });
						pi.hideOverlay("shortcuts");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "overlay-show-hide.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const { actions, calls } = createRecordingSlotActions();
			runner.bindSlotUI(actions);

			await runner.emit({ type: "session_start", reason: "startup" });

			expect(calls).toEqual([
				{ kind: "showOverlay", id: "shortcuts", payload: { source: "test" } },
				{ kind: "hideOverlay", id: "shortcuts" },
			]);
		});
	});

	describe("registerFooter", () => {
		it("writes to the per-extension registry and getRegisteredFooters returns the spec", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFooter("zoom-pill", {
						render: () => "[ZOOM]",
						visible: () => true,
						onActivate: () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "zoom-footer.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const footers = runner.getRegisteredFooters();
			expect(footers).toHaveLength(1);
			expect(footers[0].id).toBe("zoom-pill");
			expect(footers[0].spec.render({ width: 80, theme: {} as never, selected: false })).toBe("[ZOOM]");
			expect(footers[0].spec.visible?.()).toBe(true);
		});

		it("getRegisteredFooters returns entries from every extension in load order", async () => {
			const a = `
				export default function(pi) {
					pi.registerFooter("a-pill", { render: () => "A", onActivate: () => {} });
				}
			`;
			const b = `
				export default function(pi) {
					pi.registerFooter("b-pill", { render: () => "B", onActivate: () => {} });
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-pill.ts"), a);
			fs.writeFileSync(path.join(extensionsDir, "b-pill.ts"), b);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const footers = runner.getRegisteredFooters();
			expect(footers.map((f) => f.id)).toEqual(["a-pill", "b-pill"]);
		});

		it("visible() runs on each invocation so footer pills can be reactive", async () => {
			const extCode = `
				globalThis.__b5FooterVisible = false;
				export default function(pi) {
					pi.registerFooter("toggle-pill", {
						render: () => "T",
						visible: () => globalThis.__b5FooterVisible,
						onActivate: () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "toggle-pill.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const [footer] = runner.getRegisteredFooters();
			expect(footer.spec.visible?.()).toBe(false);
			(globalThis as { __b5FooterVisible?: boolean }).__b5FooterVisible = true;
			expect(footer.spec.visible?.()).toBe(true);

			delete (globalThis as { __b5FooterVisible?: boolean }).__b5FooterVisible;
		});

		it("onActivate fires when the host invokes it; close() comes from the caller", async () => {
			const extCode = `
				globalThis.__b5FooterActivate = [];
				export default function(pi) {
					pi.registerFooter("activate-pill", {
						render: () => "A",
						onActivate: (api) => {
							globalThis.__b5FooterActivate.push("activated");
							api.close();
						},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "activate-pill.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			(globalThis as { __b5FooterActivate?: string[] }).__b5FooterActivate = [];
			let closed = false;
			const close = () => {
				closed = true;
			};
			const [footer] = runner.getRegisteredFooters();
			footer.spec.onActivate({ close });

			expect((globalThis as { __b5FooterActivate?: string[] }).__b5FooterActivate).toEqual(["activated"]);
			expect(closed).toBe(true);

			delete (globalThis as { __b5FooterActivate?: string[] }).__b5FooterActivate;
		});
	});

	describe("no-registration baseline", () => {
		it("registry getters return undefined / empty when no extension registered anything", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			expect(runner.getRegisteredMainPane("zoom")).toBeUndefined();
			expect(runner.getRegisteredOverlay("anything")).toBeUndefined();
			expect(runner.getRegisteredFooters()).toEqual([]);
		});

		it("show/hide calls from extensions are silent no-ops when no slot-UI is bound", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("session_start", () => {
						// No registrations, but show/hide should still be safe to call.
						pi.showMainPane("unknown", {});
						pi.hideMainPane("unknown");
						pi.showOverlay("unknown", {});
						pi.hideOverlay("unknown");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "baseline-noop.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const errors: unknown[] = [];
			runner.onError((err) => errors.push(err));
			await runner.emit({ type: "session_start", reason: "startup" });
			expect(errors).toEqual([]);
		});

		it("bindSlotUI handlers are NOT called when extension never invokes show/hide", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMainPane("zoom", () => ({}));
					pi.registerOverlay("shortcuts", () => ({}));
					pi.registerFooter("z", { render: () => "Z", onActivate: () => {} });
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "register-only.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = createRunner(result);

			const { actions, calls } = createRecordingSlotActions();
			runner.bindSlotUI(actions);

			await runner.emit({ type: "session_start", reason: "startup" });

			expect(calls).toEqual([]);
			// Registrations still visible through getters.
			expect(runner.getRegisteredMainPane("zoom")).toBeDefined();
			expect(runner.getRegisteredOverlay("shortcuts")).toBeDefined();
			expect(runner.getRegisteredFooters().map((f) => f.id)).toEqual(["z"]);
		});
	});
});
