import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@valkyriweb/pi-ai";
import { fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CommittedSessionUnit, SessionManager, type SessionUnitDraft } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type CommitSessionUnit = (draft: SessionUnitDraft) => Promise<CommittedSessionUnit>;

type SessionActionDrainInternals = {
	_requestSessionActionDrain(): void;
	_overflowRecoveryAttempted: boolean;
};

describe("AgentSession durable session-unit scheduling", () => {
	const harnesses: Harness[] = [];
	const sessionDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (sessionDirs.length > 0) rmSync(sessionDirs.pop()!, { recursive: true, force: true });
	});

	async function createBoundHarness(): Promise<{ harness: Harness; commit: CommitSessionUnit }> {
		let commit: CommitSessionUnit | undefined;
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					commit = (draft) => pi.commitSessionUnit(draft);
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		if (!commit) throw new Error("Extension transaction API was not bound");
		return { harness, commit };
	}

	async function createPersistedOverflowRetry(): Promise<{
		sessionDir: string;
		sessionFile: string;
		actionId: string;
	}> {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-overflow-action-recovery-"));
		sessionDirs.push(sessionDir);
		const manager = SessionManager.create(sessionDir, sessionDir);
		const committed = await manager.commitSessionUnit({
			targetLeafId: null,
			primary: {
				kind: "compaction",
				summary: "overflow recovery summary",
				retainedSuffix: { kind: "none" },
				tokensBefore: 100_000,
			},
			postCommit: { kind: "overflow_retry", entry: "primary" },
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile || !committed.scheduledActionId) throw new Error("Expected persisted overflow retry");
		return { sessionDir, sessionFile, actionId: committed.scheduledActionId };
	}

	it("dispatches one newly committed run-turn action and closes its receipt", async () => {
		const { harness, commit } = await createBoundHarness();
		harness.setResponses([fauxAssistantMessage("continued once")]);

		const committed = await commit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "continue from the handoff" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});

		await vi.waitFor(() => {
			expect(harness.sessionManager.getActionState(committed.scheduledActionId!)).toBe("completed");
		});
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });

		(harness.session as unknown as SessionActionDrainInternals)._requestSessionActionDrain();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("materializes one recovered scheduled action after extension binding", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-session-action-recovery-"));
		sessionDirs.push(sessionDir);
		const original = SessionManager.create(sessionDir, sessionDir);
		const committed = await original.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "recover and continue" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});
		const reopened = SessionManager.open(original.getSessionFile()!, sessionDir);
		const harness = await createHarness({
			sessionManager: reopened,
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("recovered once")]);
		expect(harness.faux.state.callCount).toBe(0);

		await harness.session.bindExtensions({});
		expect(reopened.getActionState(committed.scheduledActionId!)).toBe("completed");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("keeps durable scheduled actions owned by the source when creating a branched session", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-session-action-branch-"));
		sessionDirs.push(sessionDir);
		const manager = SessionManager.create(sessionDir, sessionDir);
		manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() - 1000 });
		const targetLeafId = manager.appendMessage(fauxAssistantMessage("seeded source"));
		const committed = await manager.commitSessionUnit({
			targetLeafId,
			primary: { kind: "user_handoff", content: "source-owned action" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});
		const sourceFile = manager.getSessionFile();
		const actionId = committed.scheduledActionId;
		if (!sourceFile || !actionId) throw new Error("Expected a persisted scheduled action");

		const branchedFile = manager.createBranchedSession(committed.primaryEntryId);
		if (!branchedFile) throw new Error("Expected a persisted branched session");

		expect(manager.getSessionFile()).toBe(branchedFile);
		expect(manager.getActionState(actionId)).toBeUndefined();
		expect(manager.getScheduledActions()).toEqual([]);
		expect(SessionManager.open(branchedFile, sessionDir).getScheduledActions()).toEqual([]);
		expect(SessionManager.open(sourceFile, sessionDir).getScheduledActions()).toEqual([
			expect.objectContaining({ actionId, state: "scheduled" }),
		]);

		const inMemory = SessionManager.inMemory();
		const memoryCommit = await inMemory.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "memory action" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});
		expect(inMemory.createBranchedSession(memoryCommit.primaryEntryId)).toBeUndefined();
		expect(inMemory.getScheduledActions()).toEqual([]);
	});

	it("recovers and dispatches a scheduled overflow retry after reopen", async () => {
		const created = await createPersistedOverflowRetry();
		const reopened = SessionManager.open(created.sessionFile, created.sessionDir);
		const harness = await createHarness({
			sessionManager: reopened,
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		let overflowBudgetDuringProviderCall = false;
		harness.setResponses([
			() => {
				overflowBudgetDuringProviderCall = (harness.session as unknown as SessionActionDrainInternals)
					._overflowRecoveryAttempted;
				return fauxAssistantMessage("recovered overflow after reopen");
			},
		]);

		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(harness.faux.state.callCount).toBe(0);
		expect(reopened.getActionState(created.actionId)).toBe("scheduled");
		await harness.session.bindExtensions({});
		expect(reopened.getActionState(created.actionId)).toBe("completed");

		expect(overflowBudgetDuringProviderCall).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it.each(["started", "completed"] as const)("does not replay a recovered %s overflow retry", async (state) => {
		const created = await createPersistedOverflowRetry();
		const writer = SessionManager.open(created.sessionFile, created.sessionDir);
		expect(writer.markActionStarted(created.actionId)).toBe(true);
		if (state === "completed") expect(writer.markActionCompleted(created.actionId)).toBe(true);

		const reopened = SessionManager.open(created.sessionFile, created.sessionDir);
		const harness = await createHarness({
			sessionManager: reopened,
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		await harness.session.bindExtensions({});
		await new Promise<void>((resolve) => setTimeout(resolve, 30));

		expect(reopened.getActionState(created.actionId)).toBe(state);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not spin or call the provider when the started receipt cannot persist", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const committed = await harness.sessionManager.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "wait for durable started" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});
		harness.sessionManager.setSessionUnitPersistFailureForTesting(true);
		harness.setResponses([fauxAssistantMessage("runs after persistence recovers")]);
		let dispatchErrors = 0;

		await harness.session.bindExtensions({
			onError: (error) => {
				if (error.event === "session_unit_dispatch") dispatchErrors++;
			},
		});
		await vi.waitFor(() => expect(dispatchErrors).toBe(1));
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(dispatchErrors).toBe(1);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getActionState(committed.scheduledActionId!)).toBe("scheduled");

		harness.sessionManager.setSessionUnitPersistFailureForTesting(false);
		(harness.session as unknown as SessionActionDrainInternals)._requestSessionActionDrain();
		await vi.waitFor(() => {
			expect(harness.sessionManager.getActionState(committed.scheduledActionId!)).toBe("completed");
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("never dispatches an action already marked started before extension binding", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const committed = await harness.sessionManager.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "already attempted" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});
		expect(harness.sessionManager.markActionStarted(committed.scheduledActionId!)).toBe(true);

		await harness.session.bindExtensions({});
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		expect(harness.sessionManager.getActionState(committed.scheduledActionId!)).toBe("started");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("does not auto-retry a transient provider failure after started", async () => {
		let commit: CommitSessionUnit | undefined;
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					commit = (draft) => pi.commitSessionUnit(draft);
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		if (!commit) throw new Error("Extension transaction API was not bound");
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("must remain unused"),
		]);

		const committed = await commit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "attempt transient provider once" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});
		await vi.waitFor(() => {
			expect(harness.sessionManager.getActionState(committed.scheduledActionId!)).toBe("completed");
		});

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("writes started before a provider failure and does not submit the action again", async () => {
		const { harness, commit } = await createBoundHarness();
		let actionId: string | undefined;
		let stateDuringProviderCall: string | undefined;
		harness.setResponses([
			() => {
				stateDuringProviderCall = actionId ? harness.sessionManager.getActionState(actionId) : undefined;
				throw new Error("provider exploded after dispatch");
			},
		]);

		const committed = await commit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "attempt once" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});
		actionId = committed.scheduledActionId;

		await vi.waitFor(() => {
			expect(harness.sessionManager.getActionState(committed.scheduledActionId!)).toBe("completed");
			expect(harness.faux.state.callCount).toBe(1);
		});
		expect(stateDuringProviderCall).toBe("started");

		(harness.session as unknown as SessionActionDrainInternals)._requestSessionActionDrain();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("removes the terminal overflow error only from retry input", async () => {
		const { harness, commit } = await createBoundHarness();
		const userId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "large prompt" }],
			timestamp: Date.now(),
		});
		const errorId = harness.sessionManager.appendMessage(
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
		);
		let providerContext: Context | undefined;
		let overflowBudgetDuringProviderCall = false;
		harness.setResponses([
			(context) => {
				providerContext = context;
				overflowBudgetDuringProviderCall = (harness.session as unknown as SessionActionDrainInternals)
					._overflowRecoveryAttempted;
				return fauxAssistantMessage("recovered after compaction");
			},
		]);

		const committed = await commit({
			targetLeafId: errorId,
			primary: {
				kind: "compaction",
				summary: "compacted",
				retainedSuffix: { kind: "from-entry", firstEntryId: userId },
				tokensBefore: 100,
			},
			postCommit: { kind: "overflow_retry", entry: "primary" },
		});

		await vi.waitFor(() => {
			expect(harness.sessionManager.getActionState(committed.scheduledActionId!)).toBe("completed");
		});
		expect(harness.sessionManager.getEntry(errorId)).toMatchObject({
			type: "message",
			message: { role: "assistant", stopReason: "error" },
		});
		expect(
			providerContext?.messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(overflowBudgetDuringProviderCall).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
	});
});
