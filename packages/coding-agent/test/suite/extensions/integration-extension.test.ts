import type { Context } from "@lue-labs/pi-ai";
import { fauxAssistantMessage } from "@lue-labs/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentRecentRunsForTests } from "../../../src/core/agents/status.ts";
import type { AgentHandle, ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("forkAgent + transcript.append integration", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		clearAgentRecentRunsForTests();
	});

	it("runs both APIs from a single extension in one user turn without regressions", async () => {
		const captured: { handle?: AgentHandle; transcriptCalled: boolean } = {
			transcriptCalled: false,
		};
		const seenContexts: Context[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("before_agent_start", async (_event, ctx) => {
						const fork = await ctx.forkAgent({
							prompt: "child task",
							description: "integration",
						});
						captured.handle = fork.handle;
						ctx.transcript.append({
							kind: "memory_saved",
							verb: "Saved",
							paths: ["one.md"],
						});
						captured.transcriptCalled = true;
					});
				},
			],
		});
		harnesses.push(harness);

		// Patch agent tool services for forkAgent (see fork-agent.test.ts).
		const internal = harness.session as unknown as {
			_agentToolServices?: {
				cwd: string;
				agentDir: string;
				authStorage: typeof harness.authStorage;
				settingsManager: typeof harness.settingsManager;
				modelRegistry: typeof harness.session.modelRegistry;
				modelRuntime: typeof harness.session.modelRuntime;
			};
		};
		internal._agentToolServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			modelRuntime: harness.session.modelRuntime,
		};

		harness.setResponses([
			(context: Context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("p");
			},
			(context: Context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("c");
			},
		]);

		await harness.session.prompt("kick off");
		await captured.handle?.wait();
		// Allow the async transcript append to land in session.messages
		await new Promise((resolve) => setTimeout(resolve, 10));

		// forkAgent observable: handle resolved, status terminal
		expect(captured.handle).toBeDefined();
		const details = await captured.handle!.wait();
		expect(details.status).toBe("completed");

		// transcript.append observable: custom message in session
		expect(captured.transcriptCalled).toBe(true);
		const customMessages = harness.session.messages.filter(
			(m): m is Extract<typeof m, { role: "custom" }> => m.role === "custom",
		);
		const memorySaved = customMessages.find((m) => m.customType === "memory_saved");
		expect(memorySaved).toBeDefined();
		expect(memorySaved?.details).toEqual({ verb: "Saved", paths: ["one.md"] });

		// No regression: assistant text from parent still present
		const assistantMessages = harness.session.messages.filter((m) => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThan(0);
		// Both parent and child consumed the queue
		expect(seenContexts.length).toBe(2);
	});
});
