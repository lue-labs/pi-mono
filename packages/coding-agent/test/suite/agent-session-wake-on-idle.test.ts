// Ported from my-pi extensions/idle-wake/test.mjs when notification wakes moved
// into core (sendCustomMessage wakeOnIdle option). Scenarios: idle notification
// drives one continuation turn without adding a synthetic prompt; busy delivery
// never schedules a wake; same-window notifications debounce into one wake;
// non-flagged custom messages don't wake; a turn starting inside the debounce
// window cancels the pending wake.

import type { AgentTool } from "@valkyriweb/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@valkyriweb/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const DEBOUNCE_MS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const completion = (customType: string) => ({
	customType,
	content: `<task_notification>${customType}</task_notification>`,
	display: false as const,
});

function idleWakeMessages(harness: Harness) {
	return harness.session.messages.filter(
		(m) => m.role === "custom" && (m as { customType?: string }).customType === "idle-wake",
	);
}

describe("AgentSession wakeOnIdle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("idle completion with wakeOnIdle drives exactly one continuation turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("read the notification")]);

		await harness.session.sendCustomMessage(completion("bash_completion"), {
			deliverAs: "followUp",
			wakeOnIdle: true,
		});
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);

		await sleep(DEBOUNCE_MS + 150);
		await harness.session.agent.waitForIdle();

		expect(idleWakeMessages(harness)).toHaveLength(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("sendNotification queues the notification and wakes when idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled notification")]);

		await harness.session.sendNotification(completion("bash_completion"));

		await sleep(DEBOUNCE_MS + 150);
		await harness.session.agent.waitForIdle();

		expect(idleWakeMessages(harness)).toHaveLength(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("debounces same-window completions into one wake", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one wake for two jobs")]);

		await harness.session.sendCustomMessage(completion("bash_completion"), {
			deliverAs: "followUp",
			wakeOnIdle: true,
		});
		await harness.session.sendCustomMessage(completion("agent_completion"), {
			deliverAs: "followUp",
			wakeOnIdle: true,
		});

		await sleep(DEBOUNCE_MS + 150);
		await harness.session.agent.waitForIdle();
		// Past the window: no second wake pending.
		await sleep(DEBOUNCE_MS + 150);

		expect(idleWakeMessages(harness)).toHaveLength(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("does not wake when the message lands while the agent is busy", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await gate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn complete"),
		]);

		const promptPromise = harness.session.prompt("start");
		await new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		// Busy: routes to the followUp queue, drains into the active run.
		await harness.session.sendCustomMessage(completion("bash_completion"), {
			deliverAs: "followUp",
			wakeOnIdle: true,
		});
		release?.();
		await promptPromise;
		await sleep(DEBOUNCE_MS + 150);

		expect(idleWakeMessages(harness)).toHaveLength(0);
	});

	it("does not wake for custom messages without wakeOnIdle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.sendCustomMessage(completion("memory_saved"), { deliverAs: "followUp" });
		await sleep(DEBOUNCE_MS + 150);

		expect(idleWakeMessages(harness)).toHaveLength(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
	});

	it("re-arms instead of dropping the wake when compaction is in flight at fire time", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("wake survived compaction")]);

		const session = harness.session as unknown as {
			_compactionAbortController?: AbortController;
		};

		// Schedule the wake while idle (arms the debounce timer), THEN start
		// compaction inside the window so the timer trips the transient-busy guard
		// at fire time. A fire-once timer would drop the wake here, leaving the
		// notification unhandled in history forever.
		await harness.session.sendCustomMessage(completion("bash_completion"), {
			deliverAs: "followUp",
			wakeOnIdle: true,
		});
		session._compactionAbortController = new AbortController();
		expect(harness.session.isCompacting).toBe(true);

		// First debounce window elapses while still compacting: must re-arm, not wake.
		await sleep(DEBOUNCE_MS + 150);
		expect(idleWakeMessages(harness)).toHaveLength(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);

		// Compaction settles; the re-armed timer must now drive the wake.
		session._compactionAbortController = undefined;
		expect(harness.session.isCompacting).toBe(false);
		await sleep(DEBOUNCE_MS + 150);
		await harness.session.agent.waitForIdle();

		expect(idleWakeMessages(harness)).toHaveLength(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("cancels the pending wake when a turn starts inside the debounce window", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("user turn reads the notification")]);

		await harness.session.sendCustomMessage(completion("bash_completion"), {
			deliverAs: "followUp",
			wakeOnIdle: true,
		});
		// User prompt arrives before the debounce fires; the notification is in
		// context for this turn, so the wake must be cancelled — even though the
		// turn completes before the window elapses.
		await harness.session.prompt("hello");
		await sleep(DEBOUNCE_MS + 150);

		expect(idleWakeMessages(harness)).toHaveLength(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});
});
