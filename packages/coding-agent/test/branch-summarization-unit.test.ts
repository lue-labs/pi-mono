import type { AssistantMessage, Model } from "@lue-labs/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

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

const model: Model<"anthropic-messages"> = {
	id: "summary-model",
	name: "Summary Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const summaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "summary-model",
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

const entries: SessionEntry[] = [
	{
		type: "message",
		id: "message-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "Summarize this branch.", timestamp: Date.now() },
	},
];

describe("generateBranchSummary", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(summaryResponse);
	});

	it("returns a complete branch summary", async () => {
		const result = await generateBranchSummary(entries, {
			model,
			apiKey: "test-key",
			signal: new AbortController().signal,
		});

		expect(result.error).toBeUndefined();
		expect(result.summary).toContain("## Goal\nTest summary");
	});

	it("rejects a length-limited branch summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...summaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});

		const result = await generateBranchSummary(entries, {
			model,
			apiKey: "test-key",
			signal: new AbortController().signal,
		});

		expect(result.summary).toBeUndefined();
		expect(result.error).toContain("generation hit the token cap");
	});
});
