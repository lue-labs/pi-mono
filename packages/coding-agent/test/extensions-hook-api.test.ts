import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import "../src/core/extensions/core-extension-actions.ts";
import {
	addAction,
	applyFilters,
	getActions,
	getFilters,
	load,
	removeAction,
	removeFilter,
	removeHook,
} from "../src/core/extensions/extension-hooks.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { LoadExtensionsResult } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { assistantMsg, createTestExtensionsResult, userMsg } from "./utilities.ts";

describe("extension hooks API", () => {
	let tempDir: string;
	let hookName: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-hooks-"));
		hookName = `test:hook:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	});

	afterEach(() => {
		removeHook(hookName);
		removeFilter("provider:beforeRequest", "test-provider-filter");
		removeFilter("systemPrompt:build", "test-system-prompt-filter");
		removeFilter("systemPrompt:build", "test-extension-config");
		removeFilter("message:end", "test-message-filter");
		removeAction(load, "test-replaced-load-action");
		removeAction(load, "test-replacement-load-action");
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function createRunner(result: LoadExtensionsResult): ExtensionRunner {
		return new ExtensionRunner(
			result.extensions,
			result.deferredExtensions,
			result.runtime,
			result.eventBus,
			tempDir,
			SessionManager.inMemory(),
			ModelRegistry.create(AuthStorage.create(path.join(tempDir, "auth.json"))),
		);
	}

	function systemPromptOptions() {
		return {
			cwd: tempDir,
			selectedTools: [],
			toolSnippets: {},
			promptGuidelines: [],
			appendSystemPrompt: "",
			contextFiles: [],
			skills: [],
		};
	}

	it("supports fluent and direct action/filter registration with priority ordering and removal", async () => {
		const seen: string[] = [];
		let directApplyResult = "";
		await createTestExtensionsResult(
			[
				async (pi) => {
					const handle = pi.hooks.register(hookName, { description: "test hook" });
					handle.action(
						"later",
						() => {
							seen.push("later");
						},
						{ priority: 20 },
					);
					handle.action("removed", () => {
						seen.push("removed");
					});
					handle.removeAction("removed");
					pi.hooks.addAction(
						hookName,
						"earlier",
						() => {
							seen.push("earlier");
						},
						{ priority: 5 },
					);

					handle.filter<string>("append-b", (value) => `${value}b`, { priority: 20 });
					pi.hooks.addFilter<string>(hookName, "append-a", (value) => `${value}a`, { priority: 5 });
					pi.hooks.addFilter<string>(hookName, "removed-filter", (value) => `${value}x`);
					pi.hooks.removeFilter(hookName, "removed-filter");
					directApplyResult = await pi.hooks.applyFilters(hookName, "");
				},
			],
			tempDir,
		);

		for (const action of getActions(hookName)) {
			await action.callback({} as never);
		}

		expect(getActions(hookName).map((action) => action.id)).toEqual(["earlier", "later"]);
		expect(seen).toEqual(["earlier", "later"]);
		expect(getFilters(hookName).map((filter) => filter.id)).toEqual(["append-a", "append-b"]);
		expect(directApplyResult).toBe("ab");
		expect(await applyFilters(hookName, "")).toBe("ab");
	});

	it("exposes built-in load actions with stable ids", () => {
		expect(getActions(load).map((action) => action.id)).toEqual(
			expect.arrayContaining(["agentsTools", "agentsUI", "bashBgJobs", "deferredTools"]),
		);
	});

	it("lets extensions read their namespace config from the runtime", async () => {
		const result = await createTestExtensionsResult(
			[
				(pi) => {
					pi.hooks.addFilter<string>("systemPrompt:build", "test-extension-config", (prompt) => {
						const cfg = pi.getExtensionConfig<{ suffix?: string }>("test-extension");
						return `${prompt}${cfg?.suffix ?? ""}`;
					});
				},
			],
			tempDir,
		);
		result.runtime.extensionConfig = {
			"test-extension": { suffix: " configured" },
		};
		const runner = createRunner(result);

		const promptResult = await runner.emitBeforeAgentStart("hello", undefined, "base", systemPromptOptions());

		expect(promptResult?.systemPrompt).toBe("base configured");
	});

	it("applies filters at provider, system prompt, and message-end seams after compatible events", async () => {
		const result = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("before_provider_request", (event) => ({ ...(event.payload as object), fromEvent: true }));
					pi.hooks.addFilter<{ fromEvent?: boolean; fromFilter?: boolean }>(
						"provider:beforeRequest",
						"test-provider-filter",
						(payload) => ({ ...payload, fromFilter: true }),
					);

					pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\nevent` }));
					pi.hooks.addFilter<string>(
						"systemPrompt:build",
						"test-system-prompt-filter",
						(prompt) => `${prompt}\nfilter`,
					);

					pi.on("message_end", (event) => ({
						message: {
							...event.message,
							content: [{ type: "text", text: "event" }],
						},
					}));
					pi.hooks.addFilter<ReturnType<typeof assistantMsg>>("message:end", "test-message-filter", (message) => ({
						...message,
						content: [{ type: "text", text: "filter" }],
					}));
				},
			],
			tempDir,
		);
		const runner = createRunner(result);

		expect(await runner.emitBeforeProviderRequest({ base: true })).toEqual({
			base: true,
			fromEvent: true,
			fromFilter: true,
		});

		const promptResult = await runner.emitBeforeAgentStart("hello", undefined, "base", {
			cwd: tempDir,
			selectedTools: [],
			toolSnippets: {},
			promptGuidelines: [],
			appendSystemPrompt: "",
			contextFiles: [],
			skills: [],
		});
		expect(promptResult?.systemPrompt).toBe("base\nfilter\nevent");

		const message = assistantMsg("base");
		const replacement = await runner.emitMessageEnd({ type: "message_end", message });
		expect((replacement as ReturnType<typeof assistantMsg> | undefined)?.content).toEqual([
			{ type: "text", text: "filter" },
		]);
	});

	it("lets eager extensions remove and replace load actions by id", async () => {
		let originalCalled = false;
		let replacementCalled = false;
		addAction(load, "test-replaced-load-action", () => {
			originalCalled = true;
		});

		await createTestExtensionsResult(
			[
				(pi) => {
					pi.hooks.removeAction(load, "test-replaced-load-action");
					pi.hooks.addAction(load, "test-replacement-load-action", () => {
						replacementCalled = true;
					});
				},
			],
			tempDir,
		);

		expect(getActions(load).some((action) => action.id === "test-replaced-load-action")).toBe(false);
		const replacement = getActions(load).find((action) => action.id === "test-replacement-load-action");
		expect(replacement).toBeDefined();
		await replacement?.callback({} as never);
		expect(originalCalled).toBe(false);
		expect(replacementCalled).toBe(true);
	});

	describe("cache-critical hook contracts", () => {
		it("lets context handlers replace model-facing messages without mutating the transcript", async () => {
			const result = await createTestExtensionsResult(
				[
					(pi) => {
						pi.on("context", (event) => ({
							messages: event.messages.filter(
								(message) =>
									!(message.role === "custom" && message.customType === "dream-memory.active-recall"),
							),
						}));
						pi.on("context", (event) => ({
							messages: [
								...event.messages,
								{
									role: "custom" as const,
									customType: "dream-memory.active-recall",
									content: "fresh recall",
									display: false,
									timestamp: 2,
								},
							],
						}));
					},
				],
				tempDir,
			);
			const runner = createRunner(result);
			const first = userMsg("stable prefix");
			const staleRecall = {
				role: "custom" as const,
				customType: "dream-memory.active-recall",
				content: "stale recall",
				display: false,
				timestamp: 1,
			};
			const latest = userMsg("latest user");
			const transcript = [first, staleRecall, latest];

			const modelMessages = await runner.emitContext(transcript);

			expect(transcript).toEqual([first, staleRecall, latest]);
			expect(modelMessages).toEqual([
				first,
				latest,
				{
					role: "custom",
					customType: "dream-memory.active-recall",
					content: "fresh recall",
					display: false,
					timestamp: 2,
				},
			]);
		});

		it("lets provider filters remove volatile request fields after request hooks run", async () => {
			type ProviderPayload = {
				messages: Array<{ role: string; content: string }>;
				tools: Array<{ name: string }>;
				nonce?: string;
			};
			const stablePayload: ProviderPayload = {
				messages: [{ role: "user", content: "stable" }],
				tools: [{ name: "Read" }],
			};
			let nonce = 0;
			const result = await createTestExtensionsResult(
				[
					(pi) => {
						pi.on("before_provider_request", (event) => ({
							...(event.payload as ProviderPayload),
							nonce: `turn-${++nonce}`,
						}));
						pi.hooks.addFilter<ProviderPayload>("provider:beforeRequest", "test-provider-filter", (payload) => {
							const { nonce: _nonce, ...cacheStablePayload } = payload;
							return cacheStablePayload;
						});
					},
				],
				tempDir,
			);
			const runner = createRunner(result);

			expect(await runner.emitBeforeProviderRequest(stablePayload)).toEqual(stablePayload);
			expect(await runner.emitBeforeProviderRequest(stablePayload)).toEqual(stablePayload);
		});

		it("runs systemPrompt:build before before_agent_start so dynamic inputs can be normalized", async () => {
			const seenByBeforeAgentStart: string[] = [];
			const result = await createTestExtensionsResult(
				[
					(pi) => {
						pi.hooks.addFilter<string>("systemPrompt:build", "test-system-prompt-filter", (prompt) =>
							prompt.replace(/^volatile:.*$/m, "volatile:<stable>"),
						);
						pi.on("before_agent_start", (event) => {
							seenByBeforeAgentStart.push(event.systemPrompt);
							return { systemPrompt: `${event.systemPrompt}\ntail:${event.prompt}` };
						});
					},
				],
				tempDir,
			);
			const runner = createRunner(result);

			const first = await runner.emitBeforeAgentStart(
				"turn one",
				undefined,
				"base\nvolatile:one",
				systemPromptOptions(),
			);
			const second = await runner.emitBeforeAgentStart(
				"turn two",
				undefined,
				"base\nvolatile:two",
				systemPromptOptions(),
			);

			expect(seenByBeforeAgentStart).toEqual(["base\nvolatile:<stable>", "base\nvolatile:<stable>"]);
			expect(first?.systemPrompt).toBe("base\nvolatile:<stable>\ntail:turn one");
			expect(second?.systemPrompt).toBe("base\nvolatile:<stable>\ntail:turn two");
		});

		it("runs message:end filters after message_end handlers so volatile transcript changes can be normalized", async () => {
			let suffix = 0;
			const result = await createTestExtensionsResult(
				[
					(pi) => {
						pi.on("message_end", (event) => ({
							message: {
								...event.message,
								content: [{ type: "text", text: `volatile:${++suffix}` }],
							},
						}));
						pi.hooks.addFilter<ReturnType<typeof assistantMsg>>(
							"message:end",
							"test-message-filter",
							(message) => ({
								...message,
								content: [{ type: "text", text: "stable" }],
							}),
						);
					},
				],
				tempDir,
			);
			const runner = createRunner(result);

			const first = await runner.emitMessageEnd({ type: "message_end", message: assistantMsg("base") });
			const second = await runner.emitMessageEnd({ type: "message_end", message: assistantMsg("base") });

			expect((first as ReturnType<typeof assistantMsg> | undefined)?.content).toEqual([
				{ type: "text", text: "stable" },
			]);
			expect((second as ReturnType<typeof assistantMsg> | undefined)?.content).toEqual([
				{ type: "text", text: "stable" },
			]);
		});
	});
});
