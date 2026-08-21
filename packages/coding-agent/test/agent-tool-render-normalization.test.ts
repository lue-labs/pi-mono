import { describe, expect, test } from "vitest";
import { normalizeAgentToolMode, normalizeAgentToolModeForRender } from "../src/core/tools/agent.ts";

describe("normalizeAgentToolModeForRender", () => {
	test("valid single call resolves aliases and reports valid state", () => {
		const result = normalizeAgentToolModeForRender({ subagent_type: "scout", prompt: "find files" });
		expect(result).toEqual({
			mode: "single",
			background: false,
			state: "valid",
			tasks: [{ agent: "scout", task: "find files" }],
		});
	});

	test("legacy agent/task fields alone resolve to the modern shape", () => {
		const result = normalizeAgentToolModeForRender({ agent: "legacy", task: "legacy-task" });
		expect(result.state).toBe("valid");
		expect(result.tasks[0]).toEqual({ agent: "legacy", task: "legacy-task" });
	});

	test("matching legacy and modern aliases are valid (no conflict)", () => {
		const result = normalizeAgentToolModeForRender({
			agent: "scout",
			subagent_type: "scout",
			task: "go",
			prompt: "go",
		});
		expect(result.state).toBe("valid");
		expect(result.tasks[0]).toEqual({ agent: "scout", task: "go" });
	});

	test("parallel tasks array is valid when every entry is complete", () => {
		const result = normalizeAgentToolModeForRender({
			tasks: [
				{ subagent_type: "a", prompt: "one", description: "first" },
				{ agent: "b", task: "two" },
			],
		});
		expect(result.mode).toBe("parallel");
		expect(result.state).toBe("valid");
		expect(result.tasks).toEqual([
			{ agent: "a", task: "one", description: "first" },
			{ agent: "b", task: "two" },
		]);
	});

	test("chain mode is recognized", () => {
		const result = normalizeAgentToolModeForRender({ chain: [{ agent: "a", task: "one" }] });
		expect(result.mode).toBe("chain");
		expect(result.state).toBe("valid");
	});

	test("background alias is surfaced", () => {
		expect(normalizeAgentToolModeForRender({ agent: "a", task: "b", background: true }).background).toBe(true);
		expect(normalizeAgentToolModeForRender({ agent: "a", task: "b", run_in_background: true }).background).toBe(true);
	});

	test("stringified task array is parsed for display", () => {
		const result = normalizeAgentToolModeForRender({ tasks: '[{"agent":"a","task":"one"}]' });
		expect(result.mode).toBe("parallel");
		expect(result.state).toBe("valid");
		expect(result.tasks).toEqual([{ agent: "a", task: "one" }]);
	});

	test("single object dropped from its array wrapper is coerced", () => {
		const result = normalizeAgentToolModeForRender({ tasks: { agent: "a", task: "one" } });
		expect(result.mode).toBe("parallel");
		expect(result.tasks).toEqual([{ agent: "a", task: "one" }]);
	});

	describe("partial (still-streaming) inputs", () => {
		test("empty object is partial single", () => {
			expect(normalizeAgentToolModeForRender({})).toEqual({
				mode: "single",
				tasks: [{}],
				background: false,
				state: "partial",
			});
		});

		test("agent without task is partial but still renders the name", () => {
			const result = normalizeAgentToolModeForRender({ subagent_type: "scout" });
			expect(result.state).toBe("partial");
			expect(result.tasks).toEqual([{ agent: "scout" }]);
		});

		test("null/undefined inputs are partial", () => {
			expect(normalizeAgentToolModeForRender(null).state).toBe("partial");
			expect(normalizeAgentToolModeForRender(undefined).state).toBe("partial");
		});

		test("task entry missing required fields is partial", () => {
			const result = normalizeAgentToolModeForRender({ tasks: [{ description: "pending" }] });
			expect(result.state).toBe("partial");
			expect(result.tasks).toEqual([{ description: "pending" }]);
		});
	});

	describe("invalid (malformed complete) inputs", () => {
		test("unparseable stringified tasks is invalid", () => {
			const result = normalizeAgentToolModeForRender({ tasks: "not json" });
			expect(result.state).toBe("invalid");
		});

		test("conflicting aliases are invalid", () => {
			const result = normalizeAgentToolModeForRender({ agent: "a", subagent_type: "b", task: "t" });
			expect(result.state).toBe("invalid");
		});

		test("more than one execution mode is invalid", () => {
			const result = normalizeAgentToolModeForRender({
				agent: "a",
				task: "t",
				tasks: [{ agent: "b", task: "u" }],
			});
			expect(result.state).toBe("invalid");
		});

		test("non-object primitive input is invalid", () => {
			expect(normalizeAgentToolModeForRender("scout").state).toBe("invalid");
			expect(normalizeAgentToolModeForRender(42).state).toBe("invalid");
		});
	});

	describe("parity with normalizeAgentToolMode for valid completed inputs", () => {
		const validInputs = [
			{ subagent_type: "scout", prompt: "find files" },
			{ agent: "legacy", task: "legacy-task" },
			{
				tasks: [
					{ agent: "a", task: "one" },
					{ subagent_type: "b", prompt: "two" },
				],
			},
			{ chain: [{ agent: "a", task: "one" }] },
		];
		for (const input of validInputs) {
			test(`matches execution mode for ${JSON.stringify(input)}`, () => {
				const render = normalizeAgentToolModeForRender(input);
				const execution = normalizeAgentToolMode(input);
				expect(render.state).toBe("valid");
				expect(render.mode).toBe(execution.mode);
				expect(render.tasks.map((t) => [t.agent, t.task])).toEqual(execution.tasks.map((t) => [t.agent, t.task]));
			});
		}

		test("inputs the render seam marks invalid are rejected by execution", () => {
			const invalidInputs: unknown[] = [
				{ tasks: "not json" },
				{ agent: "a", subagent_type: "b", task: "t" },
				{ agent: "a", task: "t", tasks: [{ agent: "b", task: "u" }] },
			];
			for (const input of invalidInputs) {
				expect(normalizeAgentToolModeForRender(input).state).toBe("invalid");
				expect(() => normalizeAgentToolMode(input as never)).toThrow();
			}
		});
	});
});
