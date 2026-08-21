import { fauxAssistantMessage, fauxToolCall } from "@lue-labs/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionStartEvent } from "../../../src/core/extensions/types.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * End-to-end proof of the StructuredOutput return mechanism (CC 2.1.153 1:1) on
 * a REAL AgentSession driven by a faux model. This is the runtime half that the
 * pi-workflow mock test can't reach:
 *   forkMetadata (delivered to the child's session_start) → the extension's own
 *   handler registers a single schema-agnostic StructuredOutput tool → a model
 *   tool-call routes to its execute and the result is captured.
 *
 * In production the child loads this extension from disk (parent cwd); here we
 * inject the same `sessionStartEvent` the executor builds from
 * `task.forkMetadata`, and let the faux model emit the tool call.
 */
describe("forkMetadata → session_start StructuredOutput tool (real session)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const META_KEY = "piWorkflowStructuredOutputCallId";

	function structuredOutputExtension(captured: { value?: unknown; registered: boolean }) {
		return (pi: ExtensionAPI) => {
			pi.on("session_start", (event) => {
				const callId = (event as SessionStartEvent).forkMetadata?.[META_KEY];
				if (typeof callId !== "string") return;
				captured.registered = true;
				pi.registerTool({
					name: "StructuredOutput",
					label: "StructuredOutput",
					description: "Return your final structured answer to the workflow script. Call exactly once.",
					parameters: Type.Object({ result: Type.Unknown() }),
					execute: async (_id, params) => {
						captured.value = (params as { result: unknown }).result;
						return { content: [{ type: "text", text: "Structured answer recorded." }], details: {} };
					},
				});
			});
		};
	}

	it("registers StructuredOutput from its forkMetadata and a model tool-call reaches execute", async () => {
		const captured: { value?: unknown; registered: boolean } = { registered: false };
		const harness = await createHarness({
			extensionFactories: [structuredOutputExtension(captured)],
		});
		harnesses.push(harness);
		// The harness builds the runner but the full boot flow's bindExtensions —
		// the thing that emits the startup session_start — isn't run here, so emit
		// the same event the executor builds from task.forkMetadata directly.
		await harness.session.extensionRunner.emit({
			type: "session_start",
			reason: "startup",
			forkMetadata: { [META_KEY]: "call-xyz" },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("StructuredOutput", { result: { answer: 42 } })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("answer the question");

		expect(captured.registered).toBe(true);
		expect(captured.value).toEqual({ answer: 42 });
	});

	it("does not register StructuredOutput without matching forkMetadata (no cross-session leak)", async () => {
		const captured: { value?: unknown; registered: boolean } = { registered: false };
		const harness = await createHarness({
			extensionFactories: [structuredOutputExtension(captured)],
		});
		harnesses.push(harness);
		// A normal (non-workflow) session: session_start with no forkMetadata.
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
		harness.setResponses([fauxAssistantMessage("plain text answer")]);

		await harness.session.prompt("hi");

		expect(captured.registered).toBe(false);
		expect(captured.value).toBeUndefined();
	});
});
