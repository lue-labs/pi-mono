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
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { pickModel } from "./helpers/models.ts";
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

function createAssistantMessage(provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
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
		tempDir = join(tmpdir(), "pi-thrashing-detector-test-" + Date.now() + "-" + Math.random().toString(36).slice(2));
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
	});

	function createSession(contextWindow: number) {
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
		const modelRegistry = ModelRegistry.create(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		return { session, sessionManager, model };
	}

	it("failure circuit breaker short-circuits BEFORE the rapid-refill check runs", async () => {
		const { session } = createSession(200000);
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
		const { session, sessionManager } = createSession(200000);
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
			throw new Error("simulated compaction failure #" + callCount);
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
		const { session } = createSession(100);
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
		const { session, sessionManager, model } = createSession(200000);
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
});
