import { fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionEntry, CustomEntry } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type CompactionInternals = {
	_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean>;
	_overflowRecoveryAttempted: boolean;
};

function seedCompactableSession(harness: Harness, label = "seed"): void {
	harness.settingsManager.applyOverrides({
		compaction: { keepRecentTokens: 1, residentPrune: false },
	});
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: `${label} user ${"x".repeat(16_000)}` }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage(
		fauxAssistantMessage(`${label} assistant ${"x".repeat(16_000)}`, {
			timestamp: now - 500,
		}),
	);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction transactions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("uses the exact second committed id when duplicate summary text is reused", async () => {
		const observedCompactionIds: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, residentPrune: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "identical summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("session_compact", async (event) => {
						observedCompactionIds.push(event.compactionEntry.id);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness, "first");
		await harness.session.compact();
		seedCompactableSession(harness, "second");
		await harness.session.compact();

		const compactions = harness.sessionManager
			.getEntries()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(compactions.map((entry) => entry.summary)).toEqual(["identical summary", "identical summary"]);
		expect(compactions[0]!.id).not.toBe(compactions[1]!.id);
		expect(observedCompactionIds).toEqual([compactions[0]!.id, compactions[1]!.id]);
	});

	it("commits an explicit zero suffix and extension companion in one manual unit", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, residentPrune: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "full summary",
							retainedSuffix: { kind: "none" },
							tokensBefore: event.preparation.tokensBefore,
						},
						buildCompanions: ({ primaryEntryId }) => [
							{ kind: "custom", customType: "state", data: { compactionEntryId: primaryEntryId } },
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const result = await harness.session.compact();
		const entries = harness.sessionManager.getEntries();
		const compaction = entries.find((entry): entry is CompactionEntry => entry.type === "compaction")!;
		const companion = entries.find((entry): entry is CustomEntry => entry.type === "custom")!;

		expect(result.firstKeptEntryId).toBeUndefined();
		expect(result.retainedSuffix).toEqual({ kind: "none" });
		expect(compaction.retainedSuffix).toEqual({ kind: "none" });
		expect(companion.parentId).toBe(compaction.id);
		expect(companion.data).toEqual({ compactionEntryId: compaction.id });
		expect(harness.sessionManager.getLeafId()).toBe(companion.id);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["compactionSummary"]);
	});

	it.each(["none-with-legacy", "mismatched-from-entry", "null-current"] as const)(
		"rejects conflicting extension compaction suffix fields: %s",
		async (conflict) => {
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1, residentPrune: false } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => ({
							compaction:
								conflict === "none-with-legacy"
									? {
											summary: "conflicting summary",
											firstKeptEntryId: event.preparation.firstKeptEntryId,
											retainedSuffix: { kind: "none" },
											tokensBefore: event.preparation.tokensBefore,
										}
									: conflict === "null-current"
										? {
												summary: "malformed summary",
												firstKeptEntryId: event.preparation.firstKeptEntryId,
												retainedSuffix: null as never,
												tokensBefore: event.preparation.tokensBefore,
											}
										: {
												summary: "conflicting summary",
												firstKeptEntryId: `${event.preparation.firstKeptEntryId}-other`,
												retainedSuffix: {
													kind: "from-entry",
													firstEntryId: event.preparation.firstKeptEntryId,
												},
												tokensBefore: event.preparation.tokensBefore,
											},
						}));
					},
				],
			});
			harnesses.push(harness);
			seedCompactableSession(harness);
			const entriesBefore = harness.sessionManager.getEntries();
			const leafBefore = harness.sessionManager.getLeafId();

			await expect(harness.session.compact()).rejects.toThrow(
				conflict === "null-current" ? "invalid retained suffix" : "conflicting retained suffix fields",
			);

			expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
			expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
			expect(harness.sessionManager.getScheduledActions()).toEqual([]);
		},
	);

	it.each([
		{ reason: "manual" as const, willRetry: false },
		{ reason: "threshold" as const, willRetry: false },
		{ reason: "overflow" as const, willRetry: true },
	])("preserves the old projection when $reason companion construction fails", async ({ reason, willRetry }) => {
		let compactEvents = 0;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, residentPrune: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: `${reason} summary`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
						buildCompanions: () => {
							throw new Error(`${reason} companion failed`);
						},
					}));
					pi.on("session_compact", async () => {
						compactEvents++;
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const entriesBefore = harness.sessionManager.getEntries();
		const leafBefore = harness.sessionManager.getLeafId();
		const messagesBefore = harness.session.messages;

		if (reason === "manual") {
			await expect(harness.session.compact()).rejects.toThrow("manual companion failed");
		} else {
			await expect(
				(harness.session as unknown as CompactionInternals)._runAutoCompaction(reason, willRetry),
			).resolves.toBe(false);
		}

		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.session.messages).toEqual(messagesBefore);
		expect(harness.sessionManager.getScheduledActions()).toEqual([]);
		expect((harness.session as unknown as CompactionInternals)._overflowRecoveryAttempted).toBe(false);
		expect(compactEvents).toBe(0);
		const endEvent = harness.eventsOfType("compaction_end").at(-1);
		expect(endEvent).toMatchObject({ reason, aborted: false, willRetry: false });
	});

	it("durably schedules one overflow retry against the committed primary id", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, residentPrune: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
						buildCompanions: ({ primaryEntryId }) => [
							{ kind: "custom", customType: "state", data: { compactionEntryId: primaryEntryId } },
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await expect(
			(harness.session as unknown as CompactionInternals)._runAutoCompaction("overflow", true),
		).resolves.toBe(false);

		const entries = harness.sessionManager.getEntries();
		const compaction = entries.find((entry): entry is CompactionEntry => entry.type === "compaction")!;
		const companion = entries.find((entry): entry is CustomEntry => entry.type === "custom")!;
		const actions = harness.sessionManager.getScheduledActions();
		expect(companion.data).toEqual({ compactionEntryId: compaction.id });
		expect(actions).toEqual([
			expect.objectContaining({ kind: "overflow_retry", entryId: compaction.id, state: "scheduled" }),
		]);
		expect((harness.session as unknown as CompactionInternals)._overflowRecoveryAttempted).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
