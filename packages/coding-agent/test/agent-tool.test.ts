import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeAgentOutput } from "../src/core/agents/output.js";
import { createAgentToolDefinition, normalizeAgentToolMode } from "../src/core/tools/agent.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-tool-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent tool", () => {
	test("schema mode validation requires exactly one mode", () => {
		expect(() => normalizeAgentToolMode({ agent: "scout", task: "find files" })).not.toThrow();
		expect(() => normalizeAgentToolMode({ tasks: [{ agent: "scout", task: "a" }] })).not.toThrow();
		expect(() => normalizeAgentToolMode({ chain: [{ agent: "scout", task: "a" }] })).not.toThrow();
		expect(() => normalizeAgentToolMode({})).toThrow("exactly one mode");
		expect(() =>
			normalizeAgentToolMode({ agent: "scout", task: "a", tasks: [{ agent: "scout", task: "b" }] }),
		).toThrow("exactly one mode");
	});

	test("output/outputMode writes parent-owned file", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "reports"), { recursive: true });
		const result = await writeAgentOutput({
			cwd,
			output: "reports/scout.md",
			outputMode: "file",
			content: "final report",
		});
		expect(result.displayText).toContain("Saved child agent output");
		expect(result.rawContent).toBe("final report");
		expect(result.outputPath).toBe(join(cwd, "reports", "scout.md"));
		expect(await readFile(result.outputPath ?? "", "utf-8")).toBe("final report");
	});

	test("tool guidelines nudge parent toward concurrent tool-use blocks", () => {
		const tool = createAgentToolDefinition(process.cwd());
		expect(tool.promptGuidelines?.join("\n")).toContain("multiple agent tool-use blocks");
	});

	test("project agent confirmation cannot be bypassed by tool arguments", async () => {
		const tool = createAgentToolDefinition(process.cwd(), {
			parentServices: {} as NonNullable<Parameters<typeof createAgentToolDefinition>[1]>["parentServices"],
			getParentActiveTools: () => [],
			getParentSessionManager: () => {
				throw new Error("should not reach execution");
			},
		});
		const modelSuppliedParams = {
			agent: "scout",
			task: "find files",
			agentScope: "project",
			confirmProjectAgents: false,
		} as unknown as Parameters<typeof tool.execute>[1];
		await expect(
			tool.execute("tool-1", modelSuppliedParams, undefined, undefined, {
				hasUI: false,
			} as Parameters<typeof tool.execute>[4]),
		).rejects.toThrow("Project agents require interactive confirmation");
	});

	test("task actions create/list/get/update/delete session-scoped tasks", async () => {
		const entries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
		const sessionManager = {
			getEntries: () => entries,
			appendCustomEntry: (customType: string, data?: unknown) => {
				entries.push({ type: "custom", customType, data });
				return String(entries.length);
			},
		};
		const tool = createAgentToolDefinition(process.cwd(), {
			getParentSessionManager: () => sessionManager as never,
		});
		const ctx = { hasUI: false } as Parameters<typeof tool.execute>[4];

		await expect(
			tool.execute(
				"tool-1",
				{ action: "create", subject: "Fix auth", description: "Patch auth flow", blockedBy: ["0"] },
				undefined,
				undefined,
				ctx,
			),
		).resolves.toMatchObject({ content: [{ text: "Task #1 created successfully: Fix auth" }] });
		await expect(tool.execute("tool-2", { action: "list" }, undefined, undefined, ctx)).resolves.toMatchObject({
			content: [{ text: "#1 [pending] Fix auth [blocked by #0]" }],
		});
		await tool.execute(
			"tool-3",
			{ action: "update", taskId: "1", status: "in_progress", owner: "rusty", metadata: { branch: "feat" } },
			undefined,
			undefined,
			ctx,
		);
		const getResult = await tool.execute("tool-4", { action: "get", taskId: "1" }, undefined, undefined, ctx);
		expect(getResult.content[0]).toMatchObject({ type: "text" });
		expect((getResult.content[0] as { text: string }).text).toContain('"status": "in_progress"');
		expect((getResult.content[0] as { text: string }).text).toContain('"owner": "rusty"');
		await expect(
			tool.execute("tool-5", { action: "update", taskId: "1", status: "deleted" }, undefined, undefined, ctx),
		).resolves.toMatchObject({ content: [{ text: "Task #1 deleted: Fix auth" }] });
		await expect(tool.execute("tool-6", { action: "list" }, undefined, undefined, ctx)).resolves.toMatchObject({
			content: [{ text: "No tasks found" }],
		});
	});

	test("execute fails clearly when runtime child services are not wired", async () => {
		const tool = createAgentToolDefinition(process.cwd());
		await expect(
			tool.execute("tool-1", { agent: "scout", task: "find files" }, undefined, undefined, {
				hasUI: false,
			} as Parameters<typeof tool.execute>[4]),
		).rejects.toThrow("agent tool is unavailable");
	});
});
