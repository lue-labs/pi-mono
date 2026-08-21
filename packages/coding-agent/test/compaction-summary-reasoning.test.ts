import type { AgentMessage } from "@lue-labs/pi-agent-core";
import type { AssistantMessage, Model } from "@lue-labs/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@lue-labs/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@lue-labs/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean, maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

function getTextFromSummaryPromptCall(callIndex: number): string {
	const context = completeSimpleMock.mock.calls[callIndex][1] as { messages: Array<{ content: unknown }> };
	const lastMessage = context.messages.at(-1);
	if (!lastMessage) return "";
	const content = lastMessage.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
			.join("\n");
	}
	return "";
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(result.text).toBe("## Goal\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).resolves.toBe(
			"## Goal\nTest summary",
		);
	});

	it("uses fresh routing sessions without prompt caching", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");
		await generateSummary(messages, createModel(false), 2000, "test-key");

		const requestOptions = completeSimpleMock.mock.calls.map((call) => call[2]);
		expect(requestOptions).toHaveLength(2);
		expect(requestOptions.every((options) => options?.cacheRetention === "none")).toBe(true);

		const sessionIds = requestOptions.map((options) => options?.sessionId);
		expect(sessionIds[0]).not.toBe(sessionIds[1]);
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false, 128000), "test-key");

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 20,
			output: 20,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});

	it("uses split-turn format for cache-safe turn-prefix summaries", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [{ ...mockSummaryResponse, content: [{ type: "text", text: "early turn work" }] }],
			isSplitTurn: true,
			tokensBefore: 100000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 20000, keepRecentTokens: 20000 },
		};

		await compact(
			preparation,
			createModel(false),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				systemPrompt: "stable parent prompt",
				messages: [],
				tools: [],
			},
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		const turnPrefixPrompt = getTextFromSummaryPromptCall(1);
		expect(turnPrefixPrompt).toContain("<split-turn-prefix>");
		expect(turnPrefixPrompt).toContain("## Original Request");
		expect(turnPrefixPrompt).toContain("## Early Progress");
		expect(turnPrefixPrompt).toContain("## Context for Suffix");
		expect(turnPrefixPrompt).not.toContain("## Goal");
		expect(turnPrefixPrompt).not.toContain("## Constraints & Preferences");
		expect(turnPrefixPrompt).not.toContain("## Progress");
		expect(turnPrefixPrompt).not.toContain("## Next Steps");
	});

	it("keeps split-turn cache-safe compaction output from duplicating checkpoint headings", async () => {
		completeSimpleMock
			.mockResolvedValueOnce({
				...mockSummaryResponse,
				content: [{ type: "text", text: "## Goal\nShip compaction fix\n\n## Progress\n### Done\n- [x] Found bug" }],
			})
			.mockResolvedValueOnce({
				...mockSummaryResponse,
				content: [
					{
						type: "text",
						text: "## Original Request\nFix duplicate compaction output\n\n## Early Progress\n- Identified prompt contract\n\n## Context for Suffix\n- Suffix keeps verification work",
					},
				],
			});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [{ ...mockSummaryResponse, content: [{ type: "text", text: "early turn work" }] }],
			isSplitTurn: true,
			tokensBefore: 100000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 20000, keepRecentTokens: 20000 },
		};

		const result = await compact(
			preparation,
			createModel(false),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ systemPrompt: "stable parent prompt", messages: [], tools: [] },
		);

		expect(countOccurrences(result.summary, "## Goal")).toBe(1);
		expect(result.summary).toContain("**Turn Context (split turn):**");
		expect(countOccurrences(result.summary, "## Original Request")).toBe(1);
		expect(result.summary).toContain("## Early Progress");
		expect(result.summary).toContain("## Context for Suffix");
	});
});
