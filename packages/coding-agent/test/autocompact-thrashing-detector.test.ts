/**
 * Wiring/order tests for the auto-compaction thrashing detector
 * (CC 2.1.201 autocompact-thrashing parity, Slice C).
 *
 * These tests exercise `_runAutoCompaction`'s breaker short-circuits directly
 * (no real LLM/API calls): the failure circuit breaker and the fixed-prefix
 * overflow guard both return before any network/auth code runs, so they can
 * be driven with a fully offline in-memory session. Pure rapid-refill streak
 * math is covered separately in `test/compaction.test.ts`.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@valkyriweb/pi-agent-core";
import type { AssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { COMPACTION_FAILURE_TRIP_COUNT } from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { pickModel } from "./helpers/models.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

function createMockUsage(input: number, output: number) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(provider: string, modelId: string, text = "ok"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: createMockUsage(10, 5),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider,
		model: modelId,
	} as AssistantMessage;
}

describe("auto-compaction thrashing detector wiring", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-thrashing-detector-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
	});

	async function createSession(contextWindow: number) {
		const baseModel = pickModel("anthropic");
		const model = { ...baseModel, contextWindow };

		const agent = new Agent({
			getApiKey: () => "unused-test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
			},
		});

		const sessionManager = SessionManager.inMemory(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		return { session, sessionManager, model };
	}

	it("failure circuit breaker short-circuits BEFORE the rapid-refill check runs", async () => {
		const { session } = await createSession(200000);
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));

		const s = session as unknown as {
			_autoCompactDisabledThisSession: boolean;
			_consecutiveCompactionFailures: number;
			_consecutiveRapidRefills: number;
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
		};

		// Trip the failure breaker directly (as 3 consecutive real compaction
		// failures would), and separately arm the rapid-refill streak one step
		// away from tripping too - if the rapid-refill path ran, it would emit
		// a "thrashing" compaction_end event and reset the streak to 0.
		s._autoCompactDisabledThisSession = true;
		s._consecutiveCompactionFailures = COMPACTION_FAILURE_TRIP_COUNT;
		s._consecutiveRapidRefills = COMPACTION_FAILURE_TRIP_COUNT - 1;

		const result = await s._runAutoCompaction("threshold", false);

		expect(result).toBe(false);
		// No compaction_start/compaction_end event at all: the failure breaker
		// returns immediately, proving it is checked before the rapid-refill
		// evaluation (which would have emitted a distinct "thrashing" message).
		expect(events.filter((e) => e.type === "compaction_start" || e.type === "compaction_end")).toHaveLength(0);
		// The rapid-refill streak is untouched, proving evaluateRapidRefill() never ran.
		expect(s._consecutiveRapidRefills).toBe(COMPACTION_FAILURE_TRIP_COUNT - 1);
	});

	it("consecutive compaction failures trip the breaker and disable auto-compaction for the session", async () => {
		const { session, sessionManager } = await createSession(200000);
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));

		const s = session as unknown as {
			_autoCompactDisabledThisSession: boolean;
			_consecutiveCompactionFailures: number;
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
		};

		expect(s._autoCompactDisabledThisSession).toBe(false);

		// Force the real catch block to run (and increment the real failure
		// counter) by making a call inside the try throw, with no network/auth
		// dependency: getBranch() is called for the rapid-refill check before any
		// auth/compaction attempt, so throwing there exercises the actual
		// increment-and-trip logic in `_runAutoCompaction`'s catch block.
		const originalGetBranch = sessionManager.getBranch.bind(sessionManager);
		let callCount = 0;
		sessionManager.getBranch = (() => {
			callCount++;
			throw new Error(`simulated compaction failure #${callCount}`);
		}) as typeof sessionManager.getBranch;

		try {
			const first = await s._runAutoCompaction("threshold", false);
			expect(first).toBe(false);
			expect(s._consecutiveCompactionFailures).toBe(1);
			expect(s._autoCompactDisabledThisSession).toBe(false);

			const second = await s._runAutoCompaction("threshold", false);
			expect(second).toBe(false);
			expect(s._consecutiveCompactionFailures).toBe(2);
			expect(s._autoCompactDisabledThisSession).toBe(false);

			const third = await s._runAutoCompaction("threshold", false);
			expect(third).toBe(false);
			expect(s._consecutiveCompactionFailures).toBe(COMPACTION_FAILURE_TRIP_COUNT);
			expect(s._autoCompactDisabledThisSession).toBe(true);

			const breakerEvent = events.find(
				(e) =>
					e.type === "compaction_end" &&
					(e as { errorMessage?: string }).errorMessage?.includes("circuit breaker"),
			);
			expect(breakerEvent).toBeDefined();
		} finally {
			sessionManager.getBranch = originalGetBranch;
		}

		// Once disabled, _runAutoCompaction short-circuits on every subsequent call
		// (proving the failure breaker is the very first check, ahead of getBranch()).
		const result = await s._runAutoCompaction("threshold", false);
		expect(result).toBe(false);
		expect(events.filter((e) => e.type === "compaction_start")).toHaveLength(0);
	});

	it("fixed-prefix-overflow guard skips compaction with a distinct message when the prefix alone exceeds the threshold", async () => {
		// A tiny contextWindow guarantees contextWindow - reserveTokens is <= 0,
		// so any non-empty system prompt trips the guard before any auth/network call.
		const { session } = await createSession(100);
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));

		const s = session as unknown as {
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
		};

		const result = await s._runAutoCompaction("threshold", false);

		expect(result).toBe(false);
		const compactionEnd = events.find((e) => e.type === "compaction_end");
		expect(compactionEnd).toBeDefined();
		expect((compactionEnd as { errorMessage?: string }).errorMessage).toContain(
			"fixed prefix (system prompt + tools) alone exceeds the compaction threshold",
		);
		// Guard fires without ever emitting compaction_start (no attempt was made).
		expect(events.filter((e) => e.type === "compaction_start")).toHaveLength(0);
	});

	it("rapid-refill trip emits the thrashing message and resets the streak", async () => {
		const { session, sessionManager, model } = await createSession(200000);
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));

		// Seed a compaction entry so hadPriorCompaction is true, then a single
		// assistant turn after it (turnsSinceCompaction = 1 < RAPID_REFILL_WINDOW).
		const firstMsgId = sessionManager.appendMessage(createAssistantMessage(model.provider, model.id));
		sessionManager.appendCompaction("prior summary", firstMsgId, 1000, undefined, false);
		sessionManager.appendMessage(createAssistantMessage(model.provider, model.id));

		const s = session as unknown as {
			_consecutiveRapidRefills: number;
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
		};

		// Arm the streak one below the trip count, as if 2 prior rapid refills
		// already happened this session.
		s._consecutiveRapidRefills = 2;

		const result = await s._runAutoCompaction("threshold", false);

		expect(result).toBe(false);
		const compactionEnd = events.find((e) => e.type === "compaction_end");
		expect(compactionEnd).toBeDefined();
		expect((compactionEnd as { errorMessage?: string }).errorMessage).toContain("Auto-compaction is thrashing");
		// Streak resets to 0 after tripping so it doesn't re-emit every subsequent turn.
		expect(s._consecutiveRapidRefills).toBe(0);
		expect(events.filter((e) => e.type === "compaction_start")).toHaveLength(0);
	});

	it("transient provider failures (rate limits) never count toward the failure breaker", async () => {
		const { session, sessionManager } = await createSession(200000);
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));

		const s = session as unknown as {
			_autoCompactDisabledThisSession: boolean;
			_consecutiveCompactionFailures: number;
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
		};

		const originalGetBranch = sessionManager.getBranch.bind(sessionManager);
		sessionManager.getBranch = (() => {
			throw new Error(
				'Summarization failed: OpenAI API error (429): {"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"pro","resets_at":1783690536,"eligible_promo":null,"resets_in_seconds":5905}',
			);
		}) as typeof sessionManager.getBranch;

		try {
			// Far past COMPACTION_FAILURE_TRIP_COUNT: a rate-limit window that
			// outlasts many threshold checks must still not trip the breaker.
			for (let i = 0; i < COMPACTION_FAILURE_TRIP_COUNT + 2; i++) {
				expect(await s._runAutoCompaction("threshold", false)).toBe(false);
			}
			expect(s._consecutiveCompactionFailures).toBe(0);
			expect(s._autoCompactDisabledThisSession).toBe(false);
			expect(
				events.some(
					(e) =>
						e.type === "compaction_end" &&
						(e as { errorMessage?: string }).errorMessage?.includes("circuit breaker"),
				),
			).toBe(false);
		} finally {
			sessionManager.getBranch = originalGetBranch;
		}
	});

	it("a transient failure neither increments nor resets a real-failure streak", async () => {
		const { session, sessionManager } = await createSession(200000);
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));

		const s = session as unknown as {
			_autoCompactDisabledThisSession: boolean;
			_consecutiveCompactionFailures: number;
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
		};

		const originalGetBranch = sessionManager.getBranch.bind(sessionManager);
		const throwStructural = (() => {
			throw new Error("simulated structural compaction failure");
		}) as typeof sessionManager.getBranch;
		const throwTransient = (() => {
			throw new Error('Anthropic API error (529): {"type":"overloaded_error","message":"Overloaded"}');
		}) as typeof sessionManager.getBranch;

		try {
			// Two real failures arm the streak one below the trip count.
			sessionManager.getBranch = throwStructural;
			await s._runAutoCompaction("threshold", false);
			await s._runAutoCompaction("threshold", false);
			expect(s._consecutiveCompactionFailures).toBe(COMPACTION_FAILURE_TRIP_COUNT - 1);

			// A rate-limited attempt in between leaves the streak untouched
			// (neither incremented - which would trip here - nor reset).
			sessionManager.getBranch = throwTransient;
			await s._runAutoCompaction("threshold", false);
			expect(s._consecutiveCompactionFailures).toBe(COMPACTION_FAILURE_TRIP_COUNT - 1);
			expect(s._autoCompactDisabledThisSession).toBe(false);

			// The next real failure completes the streak and trips the breaker.
			sessionManager.getBranch = throwStructural;
			await s._runAutoCompaction("threshold", false);
			expect(s._consecutiveCompactionFailures).toBe(COMPACTION_FAILURE_TRIP_COUNT);
			expect(s._autoCompactDisabledThisSession).toBe(true);
			expect(
				events.some(
					(e) =>
						e.type === "compaction_end" &&
						(e as { errorMessage?: string }).errorMessage?.includes("circuit breaker"),
				),
			).toBe(true);
		} finally {
			sessionManager.getBranch = originalGetBranch;
		}
	});

	it("a rate-limited attempt after compaction_start emits a distinct transient message and keeps retrying enabled", async () => {
		const { session, sessionManager, model } = await createSession(200000);
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));

		// Enough real history that prepareCompaction returns a preparation:
		// each message is ~12k estimated tokens, so with the default
		// keepRecentTokens (20k) the cut point lands mid-history and
		// messagesToSummarize is non-empty.
		const bigText = "x".repeat(48_000);
		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage(createAssistantMessage(model.provider, model.id, bigText));
		}

		const s = session as unknown as {
			_autoCompactDisabledThisSession: boolean;
			_consecutiveCompactionFailures: number;
			_modelRuntime: { getAuth: (model: unknown) => Promise<unknown> };
			_getSummarizationRequestAuth: (model: unknown) => Promise<unknown>;
			_extensionRunner: {
				hasHandlers: (type: string) => boolean;
				emit: (event: { type?: string }) => Promise<unknown>;
			};
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
		};

		// Offline auth for both streamFn branches - neither performs any network IO.
		s._modelRuntime.getAuth = async () => ({ auth: { apiKey: "test-key" } });
		s._getSummarizationRequestAuth = async () => ({ apiKey: "test-key" });

		// Throw the rate limit from the extension seam - the first call after
		// compaction_start that avoids any real summarization/network code.
		s._extensionRunner.hasHandlers = (type) => type === "session_before_compact";
		s._extensionRunner.emit = async (event) => {
			if (event?.type === "session_before_compact") {
				throw new Error("Summarization failed: OpenAI API error (429): Too Many Requests");
			}
			return undefined;
		};

		const result = await s._runAutoCompaction("threshold", false);

		expect(result).toBe(false);
		expect(events.filter((e) => e.type === "compaction_start")).toHaveLength(1);
		const end = events.find((e) => e.type === "compaction_end");
		expect(end).toBeDefined();
		expect((end as { errorMessage?: string }).errorMessage).toContain("transient provider error");
		expect((end as { errorMessage?: string }).errorMessage).not.toContain("circuit breaker tripped");
		expect(s._consecutiveCompactionFailures).toBe(0);
		expect(s._autoCompactDisabledThisSession).toBe(false);
	});
});
