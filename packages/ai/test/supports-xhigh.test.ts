import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { allOf, isReasoning, pickModel, supportsThinkingLevel } from "./helpers/models.ts";

// These tests validate getSupportedThinkingLevels against capability classes pulled
// from the live registry rather than pinned model ids, so a renamed/dropped model
// in models.generated.ts cannot break the suite (fork issues #30, #33).

describe("getSupportedThinkingLevels", () => {
	it("includes xhigh for an Anthropic model that opts into xhigh", () => {
		const model = pickModel("anthropic", supportsThinkingLevel("xhigh"));
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
	});

	it("includes xhigh for an OpenAI Codex model that opts into xhigh", () => {
		const model = pickModel("openai-codex", supportsThinkingLevel("xhigh"));
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
	});

	it("includes xhigh for an OpenRouter model that opts into xhigh", () => {
		const model = pickModel("openrouter", supportsThinkingLevel("xhigh"));
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
	});

	it("excludes xhigh for a reasoning model that does not opt into xhigh", () => {
		const model = pickModel(
			"anthropic",
			allOf(isReasoning, (candidate) => !getSupportedThinkingLevels(candidate).includes("xhigh")),
		);
		expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
	});

	it("includes xhigh but not off for Anthropic Claude Fable 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-fable-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).not.toContain("off");
	});

	it("does not include xhigh for Claude Sonnet 4.5", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("returns only off for a non-reasoning model", () => {
		const model = pickModel("openai", (candidate) => !candidate.reasoning);
		expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
	});

	it("includes xhigh but not off for Bedrock Claude Fable 5", () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).not.toContain("off");
	});
});
