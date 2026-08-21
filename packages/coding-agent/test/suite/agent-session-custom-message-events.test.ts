import type { AgentTool } from "@lue-labs/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@lue-labs/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession custom-message events", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("emits a dedicated extension event for idle custom messages", async () => {
		const customMessages: Array<{ customType: string; details: unknown }> = [];
		const lifecycleEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("custom_message", (event) => {
						customMessages.push({
							customType: event.message.customType,
							details: event.message.details,
						});
					});
					pi.on("message_start", (event) => {
						if (event.message.role === "custom") lifecycleEvents.push("start");
					});
					pi.on("message_end", (event) => {
						if (event.message.role === "custom") lifecycleEvents.push("end");
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.sendCustomMessage({
			customType: "agent_completion",
			content: "run completed",
			display: false,
			details: { runId: "agent-1", status: "completed" },
		});

		expect(customMessages).toEqual([
			{
				customType: "agent_completion",
				details: { runId: "agent-1", status: "completed" },
			},
		]);
		// Idle custom messages are not agent-loop message lifecycle events.
		expect(lifecycleEvents).toEqual([]);
		expect(harness.eventsOfType("message_start")).toHaveLength(1);
		expect(harness.eventsOfType("message_end")).toHaveLength(1);

		const entries = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "agent_completion");
		expect(entries).toHaveLength(1);
	});

	it("emits the dedicated event exactly once when a custom message is queued during a run", async () => {
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
		const customTypes: string[] = [];
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					pi.on("custom_message", (event) => {
						customTypes.push(event.message.customType);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
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

		await harness.session.sendCustomMessage(
			{
				customType: "agent_completion",
				content: "run completed",
				display: false,
				details: { runId: "agent-2", status: "completed" },
			},
			{ deliverAs: "followUp" },
		);
		expect(customTypes).toEqual(["agent_completion"]);

		release?.();
		await promptPromise;
		expect(customTypes).toEqual(["agent_completion"]);
	});

	it("emits the dedicated event when triggerTurn accepts the message, before the run settles", async () => {
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
		let markEventSeen: (() => void) | undefined;
		const eventSeen = new Promise<void>((resolve) => {
			markEventSeen = resolve;
		});
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					pi.on("custom_message", (event) => {
						if (event.message.customType === "goal-continuation") markEventSeen?.();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		let sendSettled = false;
		const sendPromise = harness.session
			.sendCustomMessage(
				{ customType: "goal-continuation", content: "continue", display: false },
				{ triggerTurn: true },
			)
			.then(() => {
				sendSettled = true;
			});

		await eventSeen;
		expect(sendSettled).toBe(false);
		await toolStarted;
		expect(sendSettled).toBe(false);

		release?.();
		await sendPromise;
		expect(sendSettled).toBe(true);
	});
});
