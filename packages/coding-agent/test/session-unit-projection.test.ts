import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

describe("SessionManager session-unit projection boundary", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	it("runs companion construction and projection validation before persistence", async () => {
		const session = SessionManager.inMemory();
		const targetId = session.appendCustomEntry("target");
		const before = session.getEntries();
		let builderRan = false;

		await expect(
			session.commitSessionUnit({
				targetLeafId: targetId,
				primary: { kind: "user_handoff", content: "continue" },
				buildCompanions: () => {
					builderRan = true;
					throw new Error("companion serialization failed");
				},
			}),
		).rejects.toThrow("companion serialization failed");

		expect(builderRan).toBe(true);
		expect(session.getEntries()).toEqual(before);
		expect(session.getLeafId()).toBe(targetId);
		expect(session.getScheduledActions()).toEqual([]);
	});

	it("treats a durable commit as canonical after a simulated crash before projection swap", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-unit-projection-"));
		dirs.push(dir);
		const session = SessionManager.create(dir, dir);
		session.setSessionUnitCrashAfterPersistForTesting(true);

		await expect(
			session.commitSessionUnit({
				targetLeafId: null,
				primary: { kind: "user_handoff", content: "durable handoff" },
				buildCompanions: ({ primaryEntryId }) => [
					{ kind: "custom", customType: "state", data: { primaryEntryId } },
				],
				postCommit: { kind: "run_turn", entry: "primary" },
			}),
		).rejects.toThrow("Injected fatal session-unit crash after durable commit");

		// The test process is standing in for the pre-swap process image. It must
		// not expose a half-projected unit; restart owns recovery from this point.
		expect(session.getEntries()).toEqual([]);
		expect(session.getLeafId()).toBeNull();
		expect(session.getScheduledActions()).toEqual([]);

		const reopened = SessionManager.open(session.getSessionFile()!, dir);
		const entries = reopened.getEntries();
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ type: "user_handoff", content: "durable handoff", parentId: null });
		expect(entries[1]).toMatchObject({
			type: "custom",
			parentId: entries[0]!.id,
			data: { primaryEntryId: entries[0]!.id },
		});
		expect(reopened.getLeafId()).toBe(entries[1]!.id);
		expect(reopened.getScheduledActions()).toEqual([
			expect.objectContaining({ kind: "run_turn", entryId: entries[0]!.id, state: "scheduled" }),
		]);
	});
});
