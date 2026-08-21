import { fauxAssistantMessage } from "@lue-labs/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("ctx.transcript.append", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("appends a memory_saved custom message to the session", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("before_agent_start", async (_event, ctx) => {
						ctx.transcript.append({
							kind: "memory_saved",
							verb: "Saved",
							paths: ["alpha.md", "beta.md"],
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("trigger");

		// Wait one microtask for the async sendCustomMessage to land.
		await new Promise((resolve) => setTimeout(resolve, 10));

		const customMessages = harness.session.messages.filter(
			(m): m is Extract<typeof m, { role: "custom" }> => m.role === "custom",
		);
		const memorySaved = customMessages.find((m) => m.customType === "memory_saved");
		expect(memorySaved).toBeDefined();
		expect(memorySaved?.display).toBe(true);
		expect(memorySaved?.details).toEqual({ verb: "Saved", paths: ["alpha.md", "beta.md"] });
		expect(typeof memorySaved?.content === "string" ? memorySaved.content : "").toContain("Saved 2 memories");
		expect(typeof memorySaved?.content === "string" ? memorySaved.content : "").toContain("alpha.md");
	});

	it("pluralises memory/memories based on path count and accepts the Improved verb", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("before_agent_start", async (_event, ctx) => {
						ctx.transcript.append({
							kind: "memory_saved",
							verb: "Improved",
							paths: ["solo.md"],
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("trigger");
		await new Promise((resolve) => setTimeout(resolve, 10));

		const customMessages = harness.session.messages.filter(
			(m): m is Extract<typeof m, { role: "custom" }> => m.role === "custom",
		);
		const memorySaved = customMessages.find((m) => m.customType === "memory_saved");
		expect(memorySaved?.details).toEqual({ verb: "Improved", paths: ["solo.md"] });
		expect(typeof memorySaved?.content === "string" ? memorySaved.content : "").toContain("Improved 1 memory");
		// Not pluralised
		expect(typeof memorySaved?.content === "string" ? memorySaved.content : "").not.toContain("memories");
	});
});
