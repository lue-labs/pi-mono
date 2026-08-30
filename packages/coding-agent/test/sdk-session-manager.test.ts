import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { pickModel } from "./helpers/models.ts";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = pickModel("anthropic");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = pickModel("anthropic");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = pickModel("anthropic");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "Bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});

	it("records an explicit model change when an existing session is reopened with a different model", async () => {
		const firstModel = pickModel("anthropic");
		const nextModel = pickModel("openai-codex");
		expect(firstModel).toBeTruthy();
		expect(nextModel).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const first = await createAgentSession({ cwd, agentDir, model: firstModel!, sessionManager });
		first.session.sessionManager.appendMessage({
			role: "assistant",
			provider: firstModel!.provider,
			model: firstModel!.id,
			content: [{ type: "text", text: "seed" }],
			api: firstModel!.api,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		first.session.dispose();

		const resumed = await createAgentSession({ cwd, agentDir, model: nextModel!, sessionManager });
		const modelChanges = resumed.session.sessionManager.getBranch().filter((entry) => entry.type === "model_change");

		expect(modelChanges).toHaveLength(2);
		expect(modelChanges.at(-1)).toMatchObject({
			type: "model_change",
			provider: nextModel!.provider,
			modelId: nextModel!.id,
		});

		resumed.session.dispose();
	});

	it("does not duplicate the model entry when an existing session is reopened with the same explicit model", async () => {
		const model = pickModel("anthropic");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const first = await createAgentSession({ cwd, agentDir, model: model!, sessionManager });
		first.session.sessionManager.appendMessage({
			role: "assistant",
			provider: model!.provider,
			model: model!.id,
			content: [{ type: "text", text: "seed" }],
			api: model!.api,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		first.session.dispose();

		const resumed = await createAgentSession({ cwd, agentDir, model: model!, sessionManager });
		const modelChanges = resumed.session.sessionManager.getBranch().filter((entry) => entry.type === "model_change");

		expect(modelChanges).toHaveLength(1);

		resumed.session.dispose();
	});

	it("exposes current session state to the built-in bash tool", async () => {
		const model = pickModel("anthropic");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			thinkingLevel: "high",
		});
		expect(session.sessionFile).toBeTruthy();
		expect(session.systemPrompt).toContain(
			"You can inspect PI_* environment variables for current model and session details.",
		);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "Bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", {
			command: `printf '%s\\n' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"`,
		});
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(output.trim().split("\n")).toEqual([
			session.sessionId,
			session.sessionFile,
			model!.provider,
			model!.id,
			session.thinkingLevel,
		]);

		session.dispose();
	});
});
