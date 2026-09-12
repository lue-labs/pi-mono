import type { AgentTool } from "@lue-labs/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@lue-labs/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
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

	it("keeps UI-only status out of provider requests and appends visible wakes as the final message", async () => {
		const requests: Array<{ systemPrompt?: string; tools?: unknown[]; messages: unknown[] }> = [];
		const serializeRequest = (context: unknown) =>
			JSON.parse(JSON.stringify(context, (_key, value) => (typeof value === "function" ? undefined : value)));
		const harness = await createHarness({
			systemPrompt: "stable system prefix",
			extensionFactories: [],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				requests.push(serializeRequest(context));
				return fauxAssistantMessage("baseline");
			},
			(context) => {
				requests.push(serializeRequest(context));
				return fauxAssistantMessage("output handled");
			},
			(context) => {
				requests.push(serializeRequest(context));
				return fauxAssistantMessage("exit handled");
			},
			(context) => {
				requests.push(serializeRequest(context));
				return fauxAssistantMessage("routine handled");
			},
		]);

		await harness.session.prompt("start");
		await harness.session.sendCustomMessage({
			customType: "monitor-status",
			content: "mon_volatile status running wake 1/20 log /tmp/volatile.log",
			display: true,
			modelVisible: false,
		});
		await harness.session.sendCustomMessage(
			{
				customType: "monitor-event",
				content: "mon_output status running wake 2/20 output changed",
				display: true,
				modelVisible: true,
			},
			{ triggerTurn: true },
		);
		await harness.session.sendCustomMessage(
			{
				customType: "monitor-event",
				content: "mon_exit status exited wake 3/20 output changed",
				display: true,
				modelVisible: true,
			},
			{ triggerTurn: true },
		);
		await harness.session.sendCustomMessage(
			{
				customType: "routine-checkpoint",
				content: "routine_id=checkpoint-1 status=due firedAt=volatile",
				display: true,
				modelVisible: true,
			},
			{ triggerTurn: true },
		);

		expect(requests).toHaveLength(4);
		const staticPrefix = (request: (typeof requests)[number]) =>
			JSON.stringify({ systemPrompt: request.systemPrompt, tools: request.tools });
		expect(staticPrefix(requests[1])).toBe(staticPrefix(requests[2]));
		expect(staticPrefix(requests[2])).toBe(staticPrefix(requests[3]));
		const outputTail = requests[1].messages.at(-1);
		const exitTail = requests[2].messages.at(-1);
		const routineTail = requests[3].messages.at(-1);
		expect(JSON.stringify(outputTail)).toContain("mon_output status running wake 2/20 output changed");
		expect(JSON.stringify(exitTail)).toContain("mon_exit status exited wake 3/20 output changed");
		expect(JSON.stringify(routineTail)).toContain("routine_id=checkpoint-1 status=due firedAt=volatile");
		expect(JSON.stringify(requests[1].messages)).not.toContain("mon_volatile status running wake 1/20");
		expect(JSON.stringify(requests[2].messages)).not.toContain("mon_volatile status running wake 1/20");
		expect(JSON.stringify(requests[3].messages)).not.toContain("mon_volatile status running wake 1/20");

		const statusEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "monitor-status");
		if (!statusEntry || statusEntry.type !== "custom_message")
			throw new Error("missing persisted monitor status entry");
		expect(statusEntry.modelVisible).toBe(false);
		const rebuiltProviderMessages = convertToLlm(harness.sessionManager.buildSessionContext().messages);
		expect(JSON.stringify(rebuiltProviderMessages)).not.toContain("mon_volatile status running wake 1/20");
	});
});
