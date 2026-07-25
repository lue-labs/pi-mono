import { fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("AgentSession tree target positioning", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		{ targetKind: "user" as const, position: undefined, expected: "before" },
		{ targetKind: "user" as const, position: "at" as const, expected: "at" },
		{ targetKind: "custom" as const, position: undefined, expected: "before" },
		{ targetKind: "custom" as const, position: "at" as const, expected: "at" },
	])("keeps $targetKind target $expected", async ({ targetKind, position, expected }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const anchorId = harness.sessionManager.appendCustomEntry("anchor");
		const targetId =
			targetKind === "user"
				? harness.sessionManager.appendMessage({
						role: "user",
						content: [{ type: "text", text: "target text" }],
						timestamp: Date.now() - 1000,
					})
				: harness.sessionManager.appendCustomMessageEntry("notice", "target text", true);
		const descendantId = harness.sessionManager.appendMessage(fauxAssistantMessage("strict descendant"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const result = await harness.session.navigateTree(targetId, { position });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("target text");
		expect(harness.sessionManager.getLeafId()).toBe(expected === "at" ? targetId : anchorId);
		expect(harness.sessionManager.getEntry(descendantId)).toMatchObject({ type: "message" });
	});
});
