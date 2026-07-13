import { describe, expect, it } from "vitest";
import { buildAgentCourseCorrectionPrompt, buildChildTaskPrompt } from "../../src/core/agents/context.ts";
import type { AgentTaskConfig } from "../../src/core/agents/types.ts";

const baseTask: AgentTaskConfig = {
	agent: "worker",
	task: "do the thing",
	context: "default",
};

describe("buildChildTaskPrompt", () => {
	it("frames the task as an Agent tool call and returns the result to the calling agent", () => {
		const prompt = buildChildTaskPrompt(baseTask);
		expect(prompt).toContain("<system-reminder>");
		expect(prompt).toContain("calling agent");
		expect(prompt).toContain("## Task from the calling agent");
		expect(prompt).toContain("do the thing");
		expect(prompt).toContain("</system-reminder>");
		expect(prompt).not.toMatch(/\b(child agent|subagent|parent agent|invoker)\b/i);
	});

	it("states when the Agent tool is unavailable despite an inherited schema", () => {
		const prompt = buildChildTaskPrompt(baseTask);
		expect(prompt).toMatch(/`agent` tool is not available/i);
		expect(prompt).toMatch(/schema.*appear/i);
		expect(prompt).toMatch(/calling agent.*follow-up/i);
	});

	it("states the remaining depth when nested Agent calls are available", () => {
		const prompt = buildChildTaskPrompt(baseTask, { canDelegate: true, remaining: 2 });
		expect(prompt).toMatch(/`agent` tool is available/i);
		expect(prompt).toContain("2 more nested level(s)");
		expect(prompt).not.toMatch(/`agent` tool is not available/i);
		expect(prompt).not.toMatch(/\b(child agent|subagent|parent agent|invoker)\b/i);
	});

	it("includes selected role guidance before the calling agent's task", () => {
		const prompt = buildChildTaskPrompt(baseTask, undefined, {
			agent: "reviewer",
			prompt: "Review evidence and end with VERDICT: PASS|FAIL|PARTIAL",
		});
		expect(prompt).toContain("## Selected Agent role: reviewer");
		expect(prompt).toContain("VERDICT: PASS|FAIL|PARTIAL");
		expect(prompt.indexOf("## Selected Agent role: reviewer")).toBeLessThan(
			prompt.indexOf("## Task from the calling agent"),
		);
	});

	it("includes extraContext after the task body as context from the calling agent", () => {
		const prompt = buildChildTaskPrompt({ ...baseTask, extraContext: "be careful with X" });
		expect(prompt).toContain("## Context from the calling agent");
		expect(prompt).toContain("be careful with X");
		expect(prompt.indexOf("do the thing")).toBeLessThan(prompt.indexOf("## Context from the calling agent"));
	});

	it("wraps course corrections with refreshed capability state", () => {
		const prompt = buildAgentCourseCorrectionPrompt("continue with the new constraint", {
			canDelegate: true,
			remaining: 3,
		});
		expect(prompt).toContain("## Course correction from the calling agent");
		expect(prompt).toContain("3 more nested level(s)");
		expect(prompt).toContain("continue with the new constraint");
		expect(prompt).not.toMatch(/\b(child agent|subagent|parent agent|invoker)\b/i);
	});

	it("produces stable bytes across calls with the same input (cache-friendliness)", () => {
		const a = buildChildTaskPrompt(baseTask);
		const b = buildChildTaskPrompt(baseTask);
		expect(a).toBe(b);
	});
});
