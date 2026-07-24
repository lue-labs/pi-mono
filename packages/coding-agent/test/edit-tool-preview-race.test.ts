import type { TUI } from "@valkyriweb/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("Edit preview I/O isolation", () => {
	beforeAll(() => initTheme("dark"));

	it("never reads the file from rendering outside the mutation queue", async () => {
		const readFile = vi.fn(async () => Buffer.from("const transport = 'before';\n"));
		const component = new ToolExecutionComponent(
			"edit",
			"preview-io-isolation",
			{
				path: "transport.ts",
				edits: [{ oldText: "const transport = 'before';", newText: "const transport = 'after';" }],
			},
			{},
			createEditToolDefinition(process.cwd(), {
				operations: {
					access: async () => {},
					readFile,
					writeFile: async () => {},
				},
			}),
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);

		component.markExecutionStarted();
		component.setArgsComplete();
		component.render(80);
		await Promise.resolve();
		expect(readFile).not.toHaveBeenCalled();

		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in transport.ts." }],
				details: {
					diff: "-const transport = 'before';\n+const transport = 'after';",
					patch: "",
					firstChangedLine: 1,
					hunks: [
						{
							oldStart: 1,
							oldLines: 1,
							newStart: 1,
							newLines: 1,
							lines: ["-const transport = 'before';", "+const transport = 'after';"],
						},
					],
				},
				isError: false,
			},
			false,
		);

		component.setExpanded(true);
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("const transport = 'after';");
		expect(rendered).not.toContain("not found");
		expect(readFile).not.toHaveBeenCalled();
	});
});
