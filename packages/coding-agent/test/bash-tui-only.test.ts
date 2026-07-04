import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";

function getText(result: any): string {
	return result.content?.[0]?.text ?? "";
}

const ctx: any = {};

describe("bash tui_only", () => {
	it("streams output to the TUI via onUpdate but returns only a summary to context", async () => {
		const bash = createBashToolDefinition(process.cwd());
		const updates: string[] = [];

		const result = await bash.execute(
			"t1",
			{ command: "for i in 1 2 3; do echo line-$i; done", tui_only: true },
			undefined,
			(update: any) => {
				const text = update.content?.[0]?.text;
				if (text) updates.push(text);
			},
			ctx,
		);

		const text = getText(result);
		// Context payload is a summary, not the raw lines.
		expect(text).toMatch(/^\[tui_only\]/);
		expect(text).toContain("exited 0");
		expect(text).toContain("3 lines");
		expect(text).not.toContain("line-1");
		expect(text).not.toContain("line-3");

		// TUI updates carried the actual output.
		const streamed = updates.join("\n");
		expect(streamed).toContain("line-1");
		expect(streamed).toContain("line-3");
	});

	it("throws on non-zero exit with a tui_only summary, not the raw output", async () => {
		const bash = createBashToolDefinition(process.cwd());

		await expect(
			bash.execute("t1", { command: "echo secret-stdout; exit 7", tui_only: true }, undefined, undefined, ctx),
		).rejects.toThrow(/\[tui_only\].*exited 7/);
	});

	it("preserves semantic exit codes (e.g. test condition false) as success under tui_only", async () => {
		const bash = createBashToolDefinition(process.cwd());

		const result = await bash.execute(
			"t1",
			{ command: "test -f /nonexistent-tui-only-check", tui_only: true },
			undefined,
			undefined,
			ctx,
		);

		expect(getText(result)).toMatch(/\[tui_only\].*exited 1/);
	});

	it("rejects the combination of tui_only and run_in_background", async () => {
		const bash = createBashToolDefinition(process.cwd());

		const result = await bash.execute(
			"t1",
			{ command: "echo hi", tui_only: true, run_in_background: true },
			undefined,
			undefined,
			ctx,
		);

		expect(getText(result)).toContain("incompatible");
	});

	it("includes a saved log path when output exceeds the truncation limit", async () => {
		const bash = createBashToolDefinition(process.cwd());
		// DEFAULT_MAX_LINES = 2000; push well past that so the accumulator persists.
		const result = await bash.execute(
			"t1",
			{
				command: `node -e "for(let i=0;i<3000;i++)console.log('L'+i)"`,
				tui_only: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text = getText(result);
		expect(text).toMatch(/\[tui_only\]/);
		expect(text).toContain("Saved:");
		expect(text).toContain("3000 lines");
	});
});
