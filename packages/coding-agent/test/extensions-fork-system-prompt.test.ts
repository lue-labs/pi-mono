import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORK_INHERITED_SYSTEM_PROMPT } from "../src/core/agents/types.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions, ForkAgentOptions } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("fork-inherited system-prompt transforms", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-system-prompt-"));
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createModelRegistry(AuthStorage.inMemory(), tempDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers and applies a transform without changing the input prompt", async () => {
		const extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		fs.writeFileSync(
			path.join(extensionsDir, "strip-parent-only.ts"),
			`export default function (pi) {
				pi.registerForkSystemPromptTransform((prompt) => prompt.replace("<parent-only>\\n", ""));
			}`,
		);

		const result = await discoverAndLoadExtensions([extensionsDir], tempDir, tempDir);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		const runner = new ExtensionRunner(
			result.extensions,
			result.deferredExtensions,
			result.runtime,
			result.eventBus,
			tempDir,
			sessionManager,
			modelRegistry,
		);

		const parentPrompt = "base\n<parent-only>\nchild-safe\n";
		expect(runner.applyForkSystemPromptTransforms(parentPrompt)).toBe("base\nchild-safe\n");
		expect(parentPrompt).toBe("base\n<parent-only>\nchild-safe\n");
	});

	it("preserves the prompt when no extension registers a transform", async () => {
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = new ExtensionRunner(
			result.extensions,
			result.deferredExtensions,
			result.runtime,
			result.eventBus,
			tempDir,
			sessionManager,
			modelRegistry,
		);

		const parentPrompt = "stable parent prompt";
		expect(runner.applyForkSystemPromptTransforms(parentPrompt)).toBe(parentPrompt);
	});

	it("marks the runner-supplied fork prompt as inherited rather than explicit", async () => {
		const extensionsDir = path.join(tempDir, "runner-extension");
		fs.mkdirSync(extensionsDir);
		fs.writeFileSync(
			path.join(extensionsDir, "capture.ts"),
			`export default function (pi) {
				pi.on("before_agent_start", async (_event, ctx) => {
					await ctx.forkAgent({ prompt: "capture" });
				});
			}`,
		);

		const result = await discoverAndLoadExtensions([extensionsDir], tempDir, tempDir);
		const runner = new ExtensionRunner(
			result.extensions,
			result.deferredExtensions,
			result.runtime,
			result.eventBus,
			tempDir,
			sessionManager,
			modelRegistry,
		);
		let captured: Record<PropertyKey, unknown> | undefined;
		runner.bindCore(
			{} as ExtensionActions,
			{
				forkAgent: async (options: ForkAgentOptions) => {
					captured = options as unknown as Record<PropertyKey, unknown>;
					return {} as never;
				},
			} as unknown as ExtensionContextActions,
		);

		await runner.emitBeforeAgentStart("parent task", undefined, "parent prompt", { cwd: tempDir });
		expect(captured?.systemPrompt).toBe("parent prompt");
		expect(captured?.[FORK_INHERITED_SYSTEM_PROMPT]).toBe(true);
	});
});
