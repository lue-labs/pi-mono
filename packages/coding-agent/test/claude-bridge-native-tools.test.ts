import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@valkyriweb/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { nativeToolAliasesFactory } from "./native-tool-aliases-factory.ts";

// web_fetch/web_search are client-side extension tools (Claude Code parity in
// my-pi/extensions/native-tool-overrides). They are provider-agnostic: no
// per-provider add/strip happens in agent-session.ts anymore. Server-tool
// opt-in is per-definition via Tool.anthropicServerTool (pi-ai convertOneTool).
const webFetchSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch content from" }),
	prompt: Type.String({ description: "The prompt to run on the fetched content" }),
});
const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	allowed_domains: Type.Optional(Type.Array(Type.String())),
	blocked_domains: Type.Optional(Type.Array(Type.String())),
});

const webClientToolsFactory: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "web_fetch",
		label: "WebFetch",
		description: "Client-side WebFetch",
		parameters: webFetchSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	});
	pi.registerTool({
		name: "web_search",
		label: "WebSearch",
		description: "Client-side WebSearch",
		parameters: webSearchSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	});
};

function createModel(provider: string): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

describe("client-side web tools (provider-agnostic)", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-native-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(provider: string, activeToolNames?: string[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [nativeToolAliasesFactory, webClientToolsFactory],
		});
		await resourceLoader.reload();
		return createAgentSession({
			cwd: tempDir,
			agentDir,
			model: createModel(provider),
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			...(activeToolNames ? { activeToolNames } : {}),
		});
	}

	it("keeps web_fetch/web_search active for claude-bridge sessions", async () => {
		const { session } = await createSession("claude-bridge", ["Read", "web_fetch", "web_search"]);
		try {
			expect(session.getActiveToolNames()).toContain("web_fetch");
			expect(session.getActiveToolNames()).toContain("web_search");
			expect(
				(session.getToolDefinition("web_fetch")?.parameters as { properties?: unknown }).properties,
			).toHaveProperty("url");

			await session.reload();
			expect(session.getActiveToolNames()).toContain("web_fetch");
			expect(session.getActiveToolNames()).toContain("web_search");
		} finally {
			session.dispose();
		}
	});

	it("keeps web_fetch/web_search active for non-bridge providers (client-side tools)", async () => {
		const { session } = await createSession("anthropic", ["Read", "web_fetch", "web_search"]);
		try {
			expect(session.getActiveToolNames()).toContain("Read");
			expect(session.getActiveToolNames()).toContain("web_fetch");
			expect(session.getActiveToolNames()).toContain("web_search");
			expect(session.getToolDefinition("web_fetch")).toBeDefined();
			expect(session.getToolDefinition("web_search")).toBeDefined();
		} finally {
			session.dispose();
		}
	});
});
