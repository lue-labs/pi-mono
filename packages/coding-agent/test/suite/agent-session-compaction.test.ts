import type { AgentTool } from "@valkyriweb/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
} from "@valkyriweb/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS } from "../../src/core/tool-artifacts.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		thresholdMode?: "run" | "defer",
	) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

/** Fork-owned CacheHeartbeatManager internals (src/core/cache-heartbeat.ts). */
type CacheHeartbeatInternals = {
	noteActivity: () => void;
	_runBaseCacheHeartbeat: () => Promise<void>;
	_runSessionCacheHeartbeat: () => Promise<void>;
	_sessionHeartbeatTargetTimestamp?: number;
	_sessionHeartbeatUsedTimestamp?: number;
};

function heartbeatInternals(harness: Harness): CacheHeartbeatInternals {
	return (harness.session as unknown as { _cacheHeartbeat: CacheHeartbeatInternals })._cacheHeartbeat;
}

function createUsage(totalTokens: number, cacheTokens = 0) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: cacheTokens,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		cacheTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0, options.cacheTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function seedLargeCompactableSession(harness: Harness): string {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	const oldUserId = harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: `message to compact ${"x".repeat(32_000)}` }],
		timestamp: now - 3000,
	});
	const oldAssistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 2500,
	});
	oldAssistant.content = [{ type: "text", text: `assistant response to compact ${"x".repeat(32_000)}` }];
	harness.sessionManager.appendMessage(oldAssistant);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "kept user" }],
		timestamp: now - 1500,
	});
	const keptAssistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	keptAssistant.content = [{ type: "text", text: "kept assistant" }];
	harness.sessionManager.appendMessage(keptAssistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return oldUserId;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const summaryUsage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							usage: summaryUsage,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const statsBefore = harness.session.getSessionStats();

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(result.summary).toBe("summary from extension");
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("leaves resident history untouched when resident prune is explicitly disabled", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, residentPrune: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const oldUserId = seedLargeCompactableSession(harness);

		await harness.session.compact();

		expect(harness.eventsOfType("resident_prune")).toHaveLength(0);
		expect(JSON.stringify(harness.sessionManager.getEntry(oldUserId))).toContain("message to compact");
	});

	it("stubs resident history by default after successful compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const oldUserId = seedLargeCompactableSession(harness);

		await harness.session.compact();

		expect(harness.eventsOfType("resident_prune")[0]?.result.entriesStubbed).toBeGreaterThan(0);
		expect(JSON.stringify(harness.sessionManager.getEntry(oldUserId))).toContain("Resident session payload pruned");
	});

	it("stubs resident history only after successful opt-in manual compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, residentPrune: true } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const oldUserId = seedLargeCompactableSession(harness);
		const systemPromptBefore = harness.session.systemPrompt;
		const activeToolNamesBefore = harness.session.getActiveToolNames();
		const activeToolRefsBefore = [...harness.session.agent.state.tools];

		await harness.session.compact();

		const pruneEvent = harness.eventsOfType("resident_prune")[0];
		expect(pruneEvent?.result.entriesStubbed).toBeGreaterThan(0);
		expect(pruneEvent?.result.payloadBytesAfter).toBeLessThan(pruneEvent!.result.payloadBytesBefore * 0.2);
		expect(JSON.stringify(harness.sessionManager.getEntry(oldUserId))).toContain("Resident session payload pruned");
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
		expect(harness.session.systemPrompt).toBe(systemPromptBefore);
		expect(harness.session.getActiveToolNames()).toEqual(activeToolNamesBefore);
		expect(harness.session.agent.state.tools).toEqual(activeToolRefsBefore);
	});

	it("stubs resident history when enabled only by PI_RESIDENT_SESSION_PRUNE", async () => {
		vi.stubEnv("PI_RESIDENT_SESSION_PRUNE", "1");
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const oldUserId = seedLargeCompactableSession(harness);

		await harness.session.compact();

		expect(harness.eventsOfType("resident_prune")[0]?.result.entriesStubbed).toBeGreaterThan(0);
		expect(JSON.stringify(harness.sessionManager.getEntry(oldUserId))).toContain("Resident session payload pruned");
	});

	it("does not prune resident history when manual compaction is cancelled", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, residentPrune: true } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		const oldUserId = seedLargeCompactableSession(harness);

		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");

		expect(harness.eventsOfType("resident_prune")).toHaveLength(0);
		expect(JSON.stringify(harness.sessionManager.getEntry(oldUserId))).toContain("message to compact");
	});

	it("emits resident prune after successful opt-in auto-compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, residentPrune: true } },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);
		const oldUserId = seedLargeCompactableSession(harness);
		useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const pruneEvent = harness.eventsOfType("resident_prune")[0];
		expect(pruneEvent).toMatchObject({ reason: "threshold" });
		expect(pruneEvent?.result.entriesStubbed).toBeGreaterThan(0);
		expect(JSON.stringify(harness.sessionManager.getEntry(oldUserId))).toContain("Resident session payload pruned");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("generates manual compaction summaries with the parent prompt and message prefix", async () => {
		const harness = await createHarness({ withConfiguredAuth: false, systemPrompt: "parent system prompt" });
		harnesses.push(harness);
		seedCompactableSession(harness);
		let capturedContext: Context | undefined;
		harness.session.agent.streamFunction = (model, context) => {
			capturedContext = context;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					...fauxAssistantMessage("cache safe summary"),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(10),
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		await harness.session.compact();

		expect(capturedContext?.systemPrompt).toBe(harness.session.systemPrompt);
		expect(capturedContext?.systemPrompt).not.toContain("context summarization assistant");
		expect(capturedContext?.messages.at(0)?.role).toBe("user");
		expect(capturedContext?.messages.at(-1)?.role).toBe("user");
		expect(JSON.stringify(capturedContext?.messages.at(-1))).toContain("active session context");
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("refreshes a session cache heartbeat once for an idle target turn", async () => {
		const now = Date.now();
		const harness = await createHarness({
			provider: "openai-codex",
			settings: {
				cacheHeartbeat: {
					enabled: true,
					workingHours: { days: [new Date().getDay()], start: "00:00", end: "23:59" },
				},
			},
		});
		harnesses.push(harness);
		const assistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			cacheTokens: 5_000,
			timestamp: now,
		});
		const imageData = "a".repeat(2 * 1024 * 1024);
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "image", data: imageData, mimeType: "image/png" }], timestamp: now - 2000 },
			{ role: "user", content: [{ type: "image", data: imageData, mimeType: "image/png" }], timestamp: now - 1000 },
			assistant,
		];

		const calls: Array<{ context: unknown; options: unknown }> = [];
		harness.session.agent.streamFunction = (model, context, options) => {
			calls.push({ context, options });
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("."),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: createUsage(1),
					},
				});
			});
			return stream;
		};
		const heartbeat = heartbeatInternals(harness);
		heartbeat._sessionHeartbeatTargetTimestamp = now;

		await heartbeat._runSessionCacheHeartbeat();
		await heartbeat._runSessionCacheHeartbeat();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options).toMatchObject({ cacheRetention: "long", maxTokens: 1, maxRetries: 0 });
		const heartbeatMessages = (calls[0]?.context as Context).messages;
		const imageBlocks = (messages: unknown[]) =>
			messages.flatMap((message) => {
				const content = (message as { content?: unknown }).content;
				return Array.isArray(content) ? content : [];
			});
		const isImageBlock = (block: unknown): block is { type: "image"; data: string } =>
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "image" &&
			"data" in block &&
			typeof block.data === "string";
		const heartbeatImageChars = imageBlocks(heartbeatMessages)
			.filter(isImageBlock)
			.reduce((total, block) => total + block.data.length, 0);
		expect(heartbeatImageChars).toBeLessThanOrEqual(MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS);
		const storedImageCount = imageBlocks(harness.session.agent.state.messages).filter(isImageBlock).length;
		expect(storedImageCount).toBe(2);
	});

	it("skips cache heartbeats for providers outside the allowlist", async () => {
		const now = Date.now();
		const harness = await createHarness({
			provider: "faux-provider",
			settings: {
				cacheHeartbeat: {
					enabled: true,
					workingHours: { days: [new Date().getDay()], start: "00:00", end: "23:59" },
				},
			},
		});
		harnesses.push(harness);
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "before idle" }], timestamp: now - 1000 },
			createAssistant(harness, { timestamp: now }),
		];

		const calls: unknown[] = [];
		harness.session.agent.streamFunction = (_model, context) => {
			calls.push(context);
			return createAssistantMessageEventStream();
		};
		const heartbeat = heartbeatInternals(harness);
		heartbeat._sessionHeartbeatTargetTimestamp = now;

		await heartbeat._runSessionCacheHeartbeat();

		expect(calls).toHaveLength(0);
	});

	it("tracks base cache warmth and refreshes it only after the heartbeat interval", async () => {
		const harness = await createHarness({
			provider: "openai-codex",
			settings: {
				cacheHeartbeat: {
					enabled: true,
					intervalMs: 60_000,
					workingHours: { days: [new Date().getDay()], start: "00:00", end: "23:59" },
				},
			},
		});
		harnesses.push(harness);

		const calls: unknown[] = [];
		harness.session.agent.streamFunction = (model) => {
			calls.push(model);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("."),
						provider: model.provider,
						model: model.id,
						usage: createUsage(10, 8),
					},
				});
			});
			return stream;
		};
		const heartbeat = heartbeatInternals(harness);

		heartbeat.noteActivity();
		await heartbeat._runBaseCacheHeartbeat();

		expect(calls).toHaveLength(1);
		expect(harness.eventsOfType("cache_heartbeat")[0]).toMatchObject({
			type: "cache_heartbeat",
			scope: "base",
			provider: "openai-codex",
			cacheRead: 8,
			input: 10,
		});
	});

	it("backs off cache heartbeats after rate-limit errors", async () => {
		const now = Date.now();
		const harness = await createHarness({
			provider: "openai-codex",
			settings: {
				cacheHeartbeat: {
					enabled: true,
					rateLimitCooldownMs: 60_000,
					workingHours: { days: [new Date().getDay()], start: "00:00", end: "23:59" },
				},
			},
		});
		harnesses.push(harness);
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "before idle" }], timestamp: now - 1000 },
			createAssistant(harness, { timestamp: now }),
		];
		let calls = 0;
		harness.session.agent.streamFunction = () => {
			calls++;
			throw new Error("429 rate limit");
		};
		const heartbeat = heartbeatInternals(harness);
		heartbeat._sessionHeartbeatTargetTimestamp = now;

		await heartbeat._runSessionCacheHeartbeat();
		heartbeat._sessionHeartbeatUsedTimestamp = undefined;
		await heartbeat._runSessionCacheHeartbeat();

		expect(calls).toBe(1);
	});

	it("emits an idle cache hint once when continuing after a long idle gap", async () => {
		const now = Date.now();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("next")]);
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "before idle" }], timestamp: now - 60 * 60 * 1000 - 1000 },
			createAssistant(harness, {
				stopReason: "stop",
				totalTokens: 10_000,
				cacheTokens: 5_000,
				timestamp: now - 60 * 60 * 1000,
			}),
		];

		await harness.session.prompt("continue");
		await harness.session.prompt("continue again");

		const hints = harness.eventsOfType("idle_cache_hint");
		expect(hints).toHaveLength(1);
		expect(hints[0]?.message).toContain("prompt-cache warmth may be gone");
	});

	it("defers threshold compaction until the next prompt check", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", contextWindow: 200_000 }] });
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const assistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(assistant, true, "defer");
		await sessionInternals._checkCompaction(assistant, false, "run");

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("runs threshold compaction before custom-message triggerTurn turns", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", contextWindow: 200_000 }] });
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		harness.setResponses([fauxAssistantMessage("turn after compaction")]);
		const bigAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			bigAssistant,
		];
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await harness.session.sendCustomMessage(
			{ customType: "test", content: [{ type: "text", text: "continue goal" }], display: false },
			{ triggerTurn: true },
		);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("compacts mid-run when a continuing turn crosses the threshold, then resumes", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			// The faux provider simulates small usage numbers; pull the threshold
			// down to ~1000 tokens (comfortably above the fixed system-prompt+tools
			// prefix so the fixed-prefix-overflow guard does not treat this as a
			// structural no-op) so the first turn's larger echoed payload is over it.
			settings: { compaction: { reserveTokens: 199_000, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "mid-run summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi ".repeat(2000) }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done after compaction"),
		]);

		await harness.session.prompt("start");

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		const lastMessage = harness.session.messages.at(-1);
		expect(lastMessage?.role).toBe("assistant");
		expect(getMessageText(lastMessage)).toContain("done after compaction");
	});

	it("keeps defer semantics when an over-threshold run ends naturally", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			settings: { compaction: { reserveTokens: 199_990, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("big final answer")]);

		await harness.session.prompt("start");

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(0);
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
