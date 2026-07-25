import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

describe("SessionManager session-unit recovery", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	function createFileBackedSession(): { dir: string; session: SessionManager; file: string } {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-unit-recovery-"));
		dirs.push(dir);
		const session = SessionManager.create(dir, dir);
		return { dir, session, file: session.getSessionFile()! };
	}

	it("ignores tentative, incomplete, and native-companion evidence during projection and navigation", async () => {
		const { dir, session, file } = createFileBackedSession();
		const committed = await session.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "custom", customType: "valid", data: { committed: true } },
		});
		const timestamp = new Date().toISOString();
		appendFileSync(
			file,
			[
				JSON.stringify({ type: "session_unit_prepare", unitId: "tentative", primaryEntryId: "tentative-primary" }),
				JSON.stringify({
					type: "session_unit_commit",
					unitId: "native-companion-unit",
					primaryEntryId: "native-primary",
					entries: [
						{
							id: "native-primary",
							entry: {
								type: "user_handoff",
								id: "native-primary",
								parentId: committed.primaryEntryId,
								timestamp,
								content: "primary",
							},
						},
						{
							id: "smuggled-summary",
							entry: {
								type: "branch_summary",
								id: "smuggled-summary",
								parentId: "native-primary",
								timestamp,
								fromId: committed.primaryEntryId,
								summary: "must be rejected",
							},
						},
					],
					finalLeafId: "smuggled-summary",
				}),
				JSON.stringify({
					type: "session_unit_commit",
					unitId: "truncated-unit",
					primaryEntryId: "missing-primary",
					entries: [],
					finalLeafId: "missing-primary",
				}),
			].join("\n") + "\n",
		);

		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntries()).toEqual([
			expect.objectContaining({ id: committed.primaryEntryId, type: "custom", customType: "valid" }),
		]);
		expect(reopened.getEntry("tentative-primary")).toBeUndefined();
		expect(reopened.getEntry("native-primary")).toBeUndefined();
		expect(reopened.getEntry("smuggled-summary")).toBeUndefined();
		expect(reopened.getEntry("missing-primary")).toBeUndefined();
		expect(() => reopened.branch("tentative-primary")).toThrow("Entry tentative-primary not found");
		expect(() => reopened.branch("native-primary")).toThrow("Entry native-primary not found");
		expect(reopened.getLeafId()).toBe(committed.primaryEntryId);
	});

	it("rejects a compaction suffix that exists off the committed target branch", async () => {
		const { dir, session, file } = createFileBackedSession();
		const root = await session.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "custom", customType: "root" },
		});
		const rootId = root.primaryEntryId;
		const offBranchId = session.appendCustomEntry("off-branch");
		session.branch(rootId);
		const targetId = session.appendCustomEntry("target");
		const invalidCompactionId = "off-branch-compaction";
		appendFileSync(
			file,
			`${JSON.stringify({
				type: "session_unit_commit",
				unitId: "off-branch-unit",
				primaryEntryId: invalidCompactionId,
				entries: [
					{
						id: invalidCompactionId,
						entry: {
							type: "compaction",
							id: invalidCompactionId,
							parentId: targetId,
							timestamp: new Date().toISOString(),
							summary: "invalid off-branch suffix",
							retainedSuffix: { kind: "from-entry", firstEntryId: offBranchId },
							tokensBefore: 100,
						},
					},
				],
				finalLeafId: invalidCompactionId,
			})}\n`,
		);

		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntry(invalidCompactionId)).toBeUndefined();
		expect(reopened.getLeafId()).toBe(targetId);
		expect(reopened.getBranch().map((entry) => entry.id)).toEqual([rootId, targetId]);
	});

	it("rejects a standalone compaction suffix that points off its parent branch", async () => {
		const { dir, session, file } = createFileBackedSession();
		const root = await session.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "custom", customType: "root" },
		});
		const offBranchId = session.appendCustomEntry("off-branch");
		session.branch(root.primaryEntryId);
		const targetId = session.appendCustomEntry("target");
		const invalidCompactionId = "standalone-off-branch-compaction";
		appendFileSync(
			file,
			`${JSON.stringify({
				type: "compaction",
				id: invalidCompactionId,
				parentId: targetId,
				timestamp: new Date().toISOString(),
				summary: "must be rejected",
				firstKeptEntryId: offBranchId,
				retainedSuffix: { kind: "from-entry", firstEntryId: offBranchId },
				tokensBefore: 100,
			})}\n`,
		);

		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntry(invalidCompactionId)).toBeUndefined();
		expect(reopened.getLeafId()).toBe(targetId);
		expect(reopened.getBranch().map((entry) => entry.id)).toEqual([root.primaryEntryId, targetId]);

		const reopenedPruned = SessionManager.open(file, dir, undefined, { residentPrune: true });
		expect(reopenedPruned.getEntry(invalidCompactionId)).toBeUndefined();
		expect(reopenedPruned.getLeafId()).toBe(targetId);
	});

	it("rejects a standalone compaction whose parent and retained boundary are both missing", async () => {
		const { dir, session, file } = createFileBackedSession();
		const target = await session.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "custom", customType: "target" },
		});
		const invalidCompactionId = "missing-parent-compaction";
		appendFileSync(
			file,
			`${JSON.stringify({
				type: "compaction",
				id: invalidCompactionId,
				parentId: "missing-parent",
				timestamp: new Date().toISOString(),
				summary: "must be rejected",
				firstKeptEntryId: "missing-parent",
				retainedSuffix: { kind: "from-entry", firstEntryId: "missing-parent" },
				tokensBefore: 100,
			})}\n`,
		);

		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntry(invalidCompactionId)).toBeUndefined();
		expect(reopened.getLeafId()).toBe(target.primaryEntryId);
	});

	it("rejects a malformed current compaction suffix even when its legacy boundary is valid", async () => {
		const { dir, session, file } = createFileBackedSession();
		const target = await session.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "custom", customType: "target" },
		});
		const targetId = target.primaryEntryId;
		const invalidCompactionId = "malformed-suffix-compaction";
		appendFileSync(
			file,
			`${JSON.stringify({
				type: "session_unit_commit",
				unitId: "malformed-suffix-unit",
				primaryEntryId: invalidCompactionId,
				entries: [
					{
						id: invalidCompactionId,
						entry: {
							type: "compaction",
							id: invalidCompactionId,
							parentId: targetId,
							timestamp: new Date().toISOString(),
							summary: "must be rejected",
							firstKeptEntryId: targetId,
							retainedSuffix: { kind: "bogus" },
							tokensBefore: 100,
						},
					},
				],
				finalLeafId: invalidCompactionId,
			})}\n`,
		);

		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntry(invalidCompactionId)).toBeUndefined();
		expect(reopened.getLeafId()).toBe(targetId);
	});

	it("rejects duplicate unit and scheduled-action identities during recovery", async () => {
		const { dir, session, file } = createFileBackedSession();
		const committed = await session.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "original" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});
		const timestamp = new Date().toISOString();
		const duplicateUnitPrimary = "duplicate-unit-primary";
		const duplicateActionPrimary = "duplicate-action-primary";
		appendFileSync(
			file,
			[
				JSON.stringify({
					type: "session_unit_commit",
					unitId: committed.unitId,
					primaryEntryId: duplicateUnitPrimary,
					entries: [
						{
							id: duplicateUnitPrimary,
							entry: {
								type: "user_handoff",
								id: duplicateUnitPrimary,
								parentId: committed.primaryEntryId,
								timestamp,
								content: "duplicate unit",
							},
						},
					],
					finalLeafId: duplicateUnitPrimary,
				}),
				JSON.stringify({
					type: "session_unit_commit",
					unitId: "unique-unit-with-duplicate-action",
					primaryEntryId: duplicateActionPrimary,
					entries: [
						{
							id: duplicateActionPrimary,
							entry: {
								type: "user_handoff",
								id: duplicateActionPrimary,
								parentId: committed.primaryEntryId,
								timestamp,
								content: "duplicate action",
							},
						},
					],
					finalLeafId: duplicateActionPrimary,
					scheduledAction: {
						actionId: committed.scheduledActionId,
						kind: "run_turn",
						entryId: duplicateActionPrimary,
					},
				}),
			].join("\n") + "\n",
		);

		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntry(duplicateUnitPrimary)).toBeUndefined();
		expect(reopened.getEntry(duplicateActionPrimary)).toBeUndefined();
		expect(reopened.getScheduledActions()).toEqual([
			expect.objectContaining({
				actionId: committed.scheduledActionId,
				entryId: committed.primaryEntryId,
				state: "scheduled",
			}),
		]);
	});

	it("recovers action receipts only through scheduled to started to completed", async () => {
		const { dir, session, file } = createFileBackedSession();
		const committed = await session.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "continue" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});
		const actionId = committed.scheduledActionId!;

		appendFileSync(
			file,
			`${JSON.stringify({ type: "session_unit_dispatch", actionId, state: "completed" })}\n` +
				`${JSON.stringify({ type: "session_unit_dispatch", actionId: "unknown", state: "started" })}\n`,
		);
		const stillScheduled = SessionManager.open(file, dir);
		expect(stillScheduled.getActionState(actionId)).toBe("scheduled");

		appendFileSync(
			file,
			`${JSON.stringify({ type: "session_unit_dispatch", actionId, state: "started" })}\n` +
				`${JSON.stringify({ type: "session_unit_dispatch", actionId, state: "started" })}\n` +
				`${JSON.stringify({ type: "session_unit_dispatch", actionId, state: "completed" })}\n` +
				`${JSON.stringify({ type: "session_unit_dispatch", actionId, state: "started" })}\n`,
		);
		const completed = SessionManager.open(file, dir);
		expect(completed.getActionState(actionId)).toBe("completed");
		expect(completed.getScheduledActions()).toEqual([]);
		expect(completed.markActionStarted(actionId)).toBe(false);
	});
});
