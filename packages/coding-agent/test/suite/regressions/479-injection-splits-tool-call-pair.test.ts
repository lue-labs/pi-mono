// Regression: pi-mono#479 (mirror of #406). A custom message injected while a
// tool call is in flight was persisted between the assistant toolCall entry and
// its toolResult. Anthropic rejects that history with
//   "unexpected `tool_use_id` found in `tool_result` blocks"
// and the malformed order is durable, so every later request — including
// /reload and a bare `continue` — replays it and the session is dead.
//
// Two seams are pinned here:
//  1. delivery: an injection arriving mid-tool-call is queued, never appended
//     between the pair;
//  2. interrupt: aborting a turn with a tool call in flight still records a
//     toolResult for that call before anything else lands.

import type { AgentMessage, AgentTool } from "@lue-labs/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@lue-labs/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const wake = {
	customType: "harbor-captain-wake",
	content: "[harbor-captain-wake] attention",
	display: false as const,
};

/** Every toolCall id that is not settled by the immediately following message. */
function nonAdjacentToolCalls(messages: AgentMessage[]): string[] {
	const broken: string[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		const ids = message.content.filter((b) => b.type === "toolCall").map((b) => b.id);
		if (ids.length === 0) continue;
		const settled = new Set<string>();
		for (let j = i + 1; j < messages.length && messages[j]!.role === "toolResult"; j++) {
			settled.add((messages[j] as { toolCallId: string }).toolCallId);
		}
		broken.push(...ids.filter((id) => !settled.has(id)));
	}
	return broken;
}

function gatedTool(): { tool: AgentTool; release: () => void; started: Promise<void> } {
	let release: (() => void) | undefined;
	let markStarted: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			markStarted?.();
			await gate;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	return { tool, release: () => release?.(), started };
}

describe("custom message injected during an in-flight tool call (#479)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("never lands between the toolCall and its toolResult", async () => {
		const { tool, release, started } = gatedTool();
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn complete"),
		]);

		const promptPromise = harness.session.prompt("start");
		await started;

		// The harbor captain wake: a notification, explicitly not a turn trigger.
		// This is the exact call that killed two consecutive captain sessions.
		await harness.session.sendCustomMessage(wake, { triggerTurn: false });
		release();
		await promptPromise;

		const messages = harness.session.messages;
		expect(nonAdjacentToolCalls(messages)).toEqual([]);

		// The wake is still delivered, just after the pair it used to split.
		const wakeIndex = messages.findIndex(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === "harbor-captain-wake",
		);
		expect(wakeIndex).toBeGreaterThan(-1);
		const resultIndex = messages.findIndex((m) => m.role === "toolResult");
		expect(resultIndex).toBeGreaterThan(-1);
		expect(wakeIndex).toBeGreaterThan(resultIndex);

		// And the durable transcript matches the resident view: the session file is
		// what a resumed or forked session replays.
		const entries = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "message" || e.type === "custom_message");
		const durableWake = entries.findIndex((e) => e.type === "custom_message");
		const durableResult = entries.findIndex((e) => e.type === "message" && e.message.role === "toolResult");
		expect(durableResult).toBeGreaterThan(-1);
		expect(durableWake).toBeGreaterThan(durableResult);
	});

	it("stays queued when the run flags are clear but a tool call is unsettled", async () => {
		// The window the isStreaming/isProcessing checks miss: a recorded history
		// whose last assistant turn still has an open tool call (aborted run, resumed
		// session). Appending here writes the split straight into the durable file.
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_open", name: "bash", arguments: {} }],
			timestamp: Date.now(),
		} as unknown as AgentMessage);

		await harness.session.sendCustomMessage(wake, { triggerTurn: false });

		const last = harness.session.messages.at(-1);
		expect(last?.role).not.toBe("custom");
		expect(harness.sessionManager.getEntries().some((e) => e.type === "custom_message")).toBe(false);
	});

	it("settles an in-flight tool call when the user aborts the turn", async () => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		// An abort-aware tool, like the real bash tool: it rejects on the signal.
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait until aborted",
			parameters: Type.Object({}),
			execute: async (_id: string, _args: unknown, signal?: AbortSignal) => {
				markStarted?.();
				await new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")));
				});
				return { content: [{ type: "text", text: "unreachable" }], details: {} };
			},
		} as unknown as AgentTool;
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after abort"),
		]);

		const promptPromise = harness.session.prompt("start");
		await started;
		harness.session.abort();
		await promptPromise.catch(() => undefined);

		// Interrupting must not leave an unsettled toolCall behind: the next
		// request would carry a tool_use with no adjacent tool_result.
		expect(nonAdjacentToolCalls(harness.session.messages)).toEqual([]);
	});
});
