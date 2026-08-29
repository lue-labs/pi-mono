/**
 * Regression: `BeforeAgentStartEvent` must carry the prompt's `source` so
 * extension hooks can distinguish user-driven turns from machine-driven ones
 * (child-agent delegations, extension steers, RPC traffic).
 *
 * Original bug: agent-tool children re-entered dream-memory's persistent-memory
 * inject + active-recall pipeline because `before_agent_start` had no source
 * field, even though the corresponding `input` event already did. Under
 * fan-out this saturated the rerank sidecar and the child timed out.
 *
 * The fix: `AgentSession.prompt({ source })` now plumbs source all the way
 * into `BeforeAgentStartEvent.source`, mirroring `InputEvent.source`. The
 * built-in `agent` tool calls `session.prompt(..., { source: "child-agent" })`
 * for every in-process delegated run, and `ctx.forkAgent` rides the same path.
 *
 * Memory-side handlers (dream-memory) then skip on `event.source === "child-agent"`
 * (and `"extension"`) in both their `input` and `before_agent_start` hooks.
 * Replaces the legacy `PI_MEMORY_SUBAGENT=1` env contract for in-process runs.
 */
import type { Context } from "@lue-labs/pi-ai";
import { fauxAssistantMessage } from "@lue-labs/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../../../src/core/agents/executor.ts";
import type { BeforeAgentStartEvent, ExtensionAPI, InputSource } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression: before_agent_start carries prompt source", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("plumbs PromptOptions.source into BeforeAgentStartEvent.source", async () => {
		const seen: Array<InputSource | undefined> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
						seen.push(event.source);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("a"),
			() => fauxAssistantMessage("b"),
			() => fauxAssistantMessage("c"),
			() => fauxAssistantMessage("d"),
		]);

		await harness.session.prompt("from-human"); // default → "interactive"
		await harness.session.prompt("from-extension", { source: "extension" });
		await harness.session.prompt("from-rpc", { source: "rpc" });
		await harness.session.prompt("from-child", { source: "child-agent" });

		expect(seen).toEqual(["interactive", "extension", "rpc", "child-agent"]);
	});

	it('agent tool tags every in-process child run with source: "child-agent"', async () => {
		// Wrap the child session's `prompt` via onChildSessionStart (fires
		// after construction, before driveChildSession awaits prompt). Proves
		// the executor passes `source: "child-agent"` end-to-end. The
		// underlying emitBeforeAgentStart call already has its own coverage
		// in the first case.
		const seen: Array<InputSource | undefined> = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([(_context: Context) => fauxAssistantMessage("child done")]);

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "general", task: "noop" }] },
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: ["read"],
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel(),
				parentThinkingLevel: "off",
				onChildSessionStart: (childSession) => {
					const sessionAny = childSession as unknown as {
						prompt: (text: string, options?: { source?: InputSource }) => Promise<void>;
					};
					const originalPrompt = sessionAny.prompt.bind(childSession);
					sessionAny.prompt = (text, options) => {
						seen.push(options?.source);
						return originalPrompt(text, options);
					};
				},
			},
		);

		expect(details.status).toBe("completed");
		expect(seen).toEqual(["child-agent"]);
	});
});
