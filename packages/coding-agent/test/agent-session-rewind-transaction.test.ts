import { fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	BranchSummaryEntry,
	CommittedSessionUnit,
	CustomEntry,
	SessionUnitDraft,
	UserHandoffEntry,
} from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type CommitSessionUnit = (draft: SessionUnitDraft) => Promise<CommittedSessionUnit>;
type SessionActionDrainInternals = { _requestSessionActionDrain(): void };

function seedNavigationBranch(harness: Harness): { targetId: string; oldLeafId: string } {
	const now = Date.now();
	const targetId = harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "target user message" }],
		timestamp: now - 2000,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage("old answer", { timestamp: now - 1000 }));
	const oldLeafId = harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "strict descendant" }],
		timestamp: now - 500,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return { targetId, oldLeafId };
}

describe("AgentSession rewind and handoff transactions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("publishes an exact-target branch summary and opaque companion as one unit", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => ({
						summary: { summary: "branch handoff", details: { source: "extension" } },
						buildCompanions: ({ primaryEntryId }) => [
							{ kind: "custom", customType: "state", data: { summaryEntryId: primaryEntryId } },
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		const { targetId, oldLeafId } = seedNavigationBranch(harness);

		const result = await harness.session.navigateTree(targetId, { summarize: true, position: "at" });
		const entries = harness.sessionManager.getEntries();
		const summary = entries.find((entry): entry is BranchSummaryEntry => entry.type === "branch_summary")!;
		const companion = entries.find((entry): entry is CustomEntry => entry.type === "custom")!;

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("target user message");
		expect(result.summaryEntry?.id).toBe(summary.id);
		expect(summary).toMatchObject({
			parentId: targetId,
			fromId: targetId,
			summary: "branch handoff",
			fromHook: true,
		});
		expect(companion).toMatchObject({
			parentId: summary.id,
			data: { summaryEntryId: summary.id },
		});
		expect(harness.sessionManager.getEntry(oldLeafId)).toMatchObject({ type: "message" });
		expect(harness.sessionManager.getLeafId()).toBe(companion.id);
		expect(harness.sessionManager.getScheduledActions()).toEqual([]);
		expect(harness.eventsOfType("entry_appended").map((event) => event.entry.id)).toEqual([summary.id, companion.id]);
	});

	it("keeps the old branch visible when a branch-summary companion fails", async () => {
		let treeEvents = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => ({
						summary: { summary: "must not publish" },
						buildCompanions: () => {
							throw new Error("tree companion failed");
						},
					}));
					pi.on("session_tree", async () => {
						treeEvents++;
					});
				},
			],
		});
		harnesses.push(harness);
		const { targetId, oldLeafId } = seedNavigationBranch(harness);
		const entriesBefore = harness.sessionManager.getEntries();
		const messagesBefore = harness.session.messages;

		await expect(harness.session.navigateTree(targetId, { summarize: true, position: "at" })).rejects.toThrow(
			"tree companion failed",
		);

		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.sessionManager.getLeafId()).toBe(oldLeafId);
		expect(harness.session.messages).toEqual(messagesBefore);
		expect(treeEvents).toBe(0);
		expect(harness.eventsOfType("entry_appended")).toEqual([]);
	});

	it("commits one exact handoff id and never replays its post-started turn", async () => {
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
		if (!commit) throw new Error("transaction API unavailable");
		harness.setResponses([
			() => {
				throw new Error("provider failed after started");
			},
		]);

		const committed = await commit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "durable rewind handoff" },
			buildCompanions: ({ primaryEntryId }) => [
				{ kind: "custom", customType: "state", data: { handoffEntryId: primaryEntryId } },
			],
			postCommit: { kind: "run_turn", entry: "primary" },
		});

		await vi.waitFor(() => {
			expect(harness.sessionManager.getActionState(committed.scheduledActionId!)).toBe("completed");
		});
		const handoff = harness.sessionManager.getEntry(committed.primaryEntryId) as UserHandoffEntry;
		const companion = harness.sessionManager
			.getEntries()
			.find((entry): entry is CustomEntry => entry.type === "custom")!;
		expect(handoff).toMatchObject({ type: "user_handoff", content: "durable rewind handoff" });
		expect(companion).toMatchObject({
			parentId: handoff.id,
			data: { handoffEntryId: handoff.id },
		});
		expect(harness.faux.state.callCount).toBe(1);

		(harness.session as unknown as SessionActionDrainInternals)._requestSessionActionDrain();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("schedules no handoff turn when durable publication fails", async () => {
		let commit: CommitSessionUnit | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					commit = (draft) => pi.commitSessionUnit(draft);
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		if (!commit) throw new Error("transaction API unavailable");
		harness.sessionManager.setSessionUnitPersistFailureForTesting(true);

		await expect(
			commit({
				targetLeafId: null,
				primary: { kind: "user_handoff", content: "must not publish" },
				postCommit: { kind: "run_turn", entry: "primary" },
			}),
		).rejects.toThrow("Injected session-unit persistence failure");
		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.sessionManager.getScheduledActions()).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
