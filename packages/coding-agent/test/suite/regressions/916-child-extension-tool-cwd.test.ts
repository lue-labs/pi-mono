import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentTool } from "../../../src/core/agents/executor.ts";
import { waitForAgentRecentRun } from "../../../src/core/agents/status.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * my-pi#916 root cause #2: a routed child session's extension-registered
 * tools (my-pi's native-tool-overrides Bash/Read/Edit/... capitalized
 * overrides) can observe the wrong cwd because they read `process.cwd()`
 * at extension-activation time instead of the per-call ExtensionContext.
 *
 * This test proves the fork-side plumbing that feeds that context: a child
 * session must build its own ExtensionRunner bound to its own (routed) cwd,
 * and an extension tool's 5th `execute` argument (`ExtensionContext`) must
 * reflect that child cwd, not the parent's.
 */
function extractToolResultText(context: Context): string | undefined {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i] as { role: string; content?: unknown };
		if (message.role !== "toolResult") continue;
		const content = (message as { content?: Array<{ type: string; text?: string }> }).content;
		const text = content?.find((part) => part.type === "text")?.text;
		if (typeof text === "string") return text;
	}
	return undefined;
}

function createProbeExtensionFile(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "index.js");
	const source = [
		"module.exports = async (api) => {",
		"  api.registerTool({",
		'    name: "CwdProbe",',
		'    label: "Cwd Probe",',
		'    description: "Returns ctx.cwd seen by this extension tool execution.",',
		"    parameters: { type: \"object\", properties: {} },",
		"    execute: async (_id, _params, _signal, _onUpdate, ctx) => {",
		"      return { content: [{ type: \"text\", text: ctx.cwd }], isError: false };",
		"    },",
		"  });",
		"};",
		"",
	].join("\n");
	writeFileSync(path, source);
	return path;
}

describe("regression #916: child session extension-tool ctx.cwd", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeChildCwd(): string {
		const dir = join(tmpdir(), `pi-916-child-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	it("sync dispatch: extension tool observes the routed child cwd, not the parent's", async () => {
		const extDir = join(tmpdir(), `pi-916-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(extDir);
		const extPath = createProbeExtensionFile(extDir);

		const harness = await createHarness({ settings: { extensions: [extPath] } });
		harnesses.push(harness);

		const childCwd = makeChildCwd();
		const seenChildContexts: Context[] = [];
		const observedCwds: string[] = [];

		harness.setResponses([
			(context) => {
				seenChildContexts.push(context);
				return fauxAssistantMessage([fauxToolCall("CwdProbe", {}, { id: "call-1" })]);
			},
			(context) => {
				const text = extractToolResultText(context);
				if (typeof text === "string") observedCwds.push(text);
				return fauxAssistantMessage("child complete");
			},
		]);

		const details = await executeAgentTool(
			{ mode: "single", tasks: [{ agent: "general", task: "Call CwdProbe and report", cwd: childCwd }] },
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: ["read", "bash", "edit", "write", "agent", "CwdProbe"],
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel(),
				parentThinkingLevel: "off",
			},
		);

		expect(details.status).toBe("completed");
		expect(seenChildContexts[0]?.tools?.map((tool) => tool.name)).toContain("CwdProbe");
		// Evidence: on unmodified pre-seam code this observes harness.tempDir
		// (the parent cwd) instead of childCwd — record whichever it is.
		expect(observedCwds).toEqual([childCwd]);
		expect(observedCwds[0]).not.toBe(harness.tempDir);
	});

	it("background dispatch: extension tool observes the routed child cwd, not the parent's", async () => {
		const extDir = join(tmpdir(), `pi-916-ext-bg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(extDir);
		const extPath = createProbeExtensionFile(extDir);

		const harness = await createHarness({ settings: { extensions: [extPath] } });
		harnesses.push(harness);

		const childCwd = makeChildCwd();
		const observedCwds: string[] = [];

		harness.setResponses([
			() => fauxAssistantMessage([fauxToolCall("CwdProbe", {}, { id: "call-1" })]),
			(context) => {
				const text = extractToolResultText(context);
				if (typeof text === "string") observedCwds.push(text);
				return fauxAssistantMessage("child complete");
			},
		]);

		const details = await executeAgentTool(
			{
				mode: "single",
				tasks: [{ agent: "general", task: "Call CwdProbe and report", cwd: childCwd }],
				background: true,
			},
			{
				parentServices: {
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
				},
				parentActiveTools: ["read", "bash", "edit", "write", "agent", "CwdProbe"],
				parentSessionManager: harness.sessionManager,
				parentModel: harness.getModel(),
				parentThinkingLevel: "off",
			},
		);

		expect(details.background).toBe(true);
		const finalRun = await waitForAgentRecentRun(details.runId!);
		expect(finalRun.status).toBe("completed");
		expect(observedCwds).toEqual([childCwd]);
		expect(observedCwds[0]).not.toBe(harness.tempDir);
	});
});
