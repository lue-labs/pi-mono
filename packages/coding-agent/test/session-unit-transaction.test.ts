import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager, type SessionUnitPostCommit, type SessionUnitPrimary } from "../src/core/session-manager.ts";

describe("SessionManager.commitSessionUnit", () => {
	it("preassigns the primary id before serializing ordered custom companions", async () => {
		const session = SessionManager.inMemory();
		const targetId = session.appendCustomEntry("target");
		let companionSaw: { unitId: string; primaryEntryId: string } | undefined;

		const committed = await session.commitSessionUnit({
			targetLeafId: targetId,
			primary: { kind: "branch_summary", fromId: targetId, summary: "summary" },
			buildCompanions: (ids) => {
				companionSaw = ids;
				return [
					{ kind: "custom", customType: "state", data: { primaryEntryId: ids.primaryEntryId } },
					{ kind: "custom", customType: "state", data: { unitId: ids.unitId } },
				];
			},
		});

		expect(companionSaw?.primaryEntryId).toBe(committed.primaryEntryId);
		expect(committed.entryIds).toHaveLength(3);
		const [primaryId, firstCompanionId, secondCompanionId] = committed.entryIds;
		expect(session.getEntry(primaryId!)).toMatchObject({ parentId: targetId, type: "branch_summary" });
		expect(session.getEntry(firstCompanionId!)).toMatchObject({
			parentId: primaryId,
			data: { primaryEntryId: primaryId },
		});
		expect(session.getEntry(secondCompanionId!)).toMatchObject({
			parentId: firstCompanionId,
			data: { unitId: companionSaw?.unitId },
		});
		expect(session.getLeafId()).toBe(secondCompanionId);
	});

	it.each([NaN, Infinity, -Infinity])(
		"rejects non-finite compaction tokensBefore before persistence (%s)",
		async (tokensBefore) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-session-unit-nonfinite-"));
			const session = SessionManager.create(dir, dir);
			const targetId = session.appendCustomEntry("target");
			const file = session.getSessionFile()!;
			const fileExistedBefore = existsSync(file);
			const fileBefore = fileExistedBefore ? readFileSync(file, "utf8") : undefined;
			const entriesBefore = session.getEntries();

			await expect(
				session.commitSessionUnit({
					targetLeafId: targetId,
					primary: {
						kind: "compaction",
						summary: "must not persist",
						retainedSuffix: { kind: "none" },
						tokensBefore,
					},
				}),
			).rejects.toThrow("valid durable session-tree record");
			expect(session.getEntries()).toEqual(entriesBefore);
			expect(session.getLeafId()).toBe(targetId);
			expect(existsSync(file)).toBe(fileExistedBefore);
			if (fileBefore !== undefined) expect(readFileSync(file, "utf8")).toBe(fileBefore);
		},
	);

	it("rejects native companion kinds before persistence", async () => {
		const session = SessionManager.inMemory();
		const targetId = session.appendCustomEntry("target");
		const entriesBefore = session.getEntries();

		await expect(
			session.commitSessionUnit({
				targetLeafId: targetId,
				primary: { kind: "branch_summary", fromId: targetId, summary: "summary" },
				buildCompanions: (() => [
					{ kind: "branch_summary", fromId: targetId, summary: "smuggled native companion" },
				]) as never,
			}),
		).rejects.toThrow("Session unit companions must be custom entries");
		expect(session.getEntries()).toEqual(entriesBefore);
		expect(session.getLeafId()).toBe(targetId);
	});

	it.each<{
		name: string;
		primary: (targetId: string) => SessionUnitPrimary;
		postCommit: SessionUnitPostCommit;
	}>([
		{
			name: "custom state",
			primary: () => ({ kind: "custom", customType: "state", data: { next: true } }),
			postCommit: { kind: "run_turn", entry: "primary" },
		},
		{
			name: "branch summary",
			primary: (targetId) => ({ kind: "branch_summary", fromId: targetId, summary: "close" }),
			postCommit: { kind: "run_turn", entry: "primary" },
		},
		{
			name: "user handoff",
			primary: () => ({ kind: "user_handoff", content: "rewind" }),
			postCommit: { kind: "run_turn", entry: "primary" },
		},
		{
			name: "compaction",
			primary: () => ({
				kind: "compaction",
				summary: "compact",
				retainedSuffix: { kind: "none" },
				tokensBefore: 10,
			}),
			postCommit: { kind: "overflow_retry", entry: "primary" },
		},
	])(
		"keeps the old projection and schedules nothing when $name persistence fails",
		async ({ primary, postCommit }) => {
			const session = SessionManager.inMemory();
			const targetId = session.appendCustomEntry("target");
			const entriesBefore = session.getEntries();
			session.setSessionUnitPersistFailureForTesting(true);

			await expect(
				session.commitSessionUnit({
					targetLeafId: targetId,
					primary: primary(targetId),
					postCommit,
				}),
			).rejects.toThrow("Injected session-unit persistence failure");
			expect(session.getEntries()).toEqual(entriesBefore);
			expect(session.getLeafId()).toBe(targetId);
			expect(session.getScheduledActions()).toEqual([]);
		},
	);

	it("recovers only committed units and durable action receipts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-unit-"));
		const session = SessionManager.create(dir, dir);
		const committed = await session.commitSessionUnit({
			targetLeafId: null,
			primary: { kind: "user_handoff", content: "continue" },
			postCommit: { kind: "run_turn", entry: "primary" },
		});
		const file = session.getSessionFile();
		expect(file).toBeDefined();
		expect(session.getScheduledActions()).toEqual([
			expect.objectContaining({ actionId: committed.scheduledActionId, state: "scheduled" }),
		]);
		expect(session.markActionStarted(committed.scheduledActionId!)).toBe(true);
		expect(session.markActionStarted(committed.scheduledActionId!)).toBe(false);

		const reopened = SessionManager.open(file!, dir);
		expect(reopened.getEntry(committed.primaryEntryId)).toMatchObject({ type: "user_handoff", content: "continue" });
		expect(reopened.getLeafId()).toBe(committed.primaryEntryId);
		expect(reopened.getActionState(committed.scheduledActionId!)).toBe("started");
		expect(reopened.getScheduledActions()).toEqual([]);
		expect(reopened.markActionStarted(committed.scheduledActionId!)).toBe(false);
		expect(reopened.markActionCompleted(committed.scheduledActionId!)).toBe(true);

		const afterCompleted = SessionManager.open(file!, dir);
		expect(afterCompleted.getActionState(committed.scheduledActionId!)).toBe("completed");
		expect(afterCompleted.getScheduledActions()).toEqual([]);

		const records = readFileSync(file!, "utf8");
		const incomplete = `${JSON.stringify({ type: "session_unit_prepare", unitId: "tentative" })}\n`;
		const incompleteCommit = `${JSON.stringify({
			type: "session_unit_commit",
			unitId: "incomplete",
			primaryEntryId: "malformed",
			entries: [
				{
					id: "malformed",
					entry: { type: "message", id: "malformed", parentId: null, timestamp: new Date().toISOString() },
				},
			],
			finalLeafId: "malformed",
		})}\n`;
		const unknown = `${JSON.stringify({ type: "future_session_record", id: "ignored" })}\n`;
		writeFileSync(file!, `${records}${incomplete}${incompleteCommit}${unknown}`);
		const afterTentative = SessionManager.open(file!, dir);
		expect(afterTentative.getEntry("tentative")).toBeUndefined();
		expect(afterTentative.getEntry("malformed")).toBeUndefined();
		expect(afterTentative.getEntries()).toHaveLength(1);
	});
});
