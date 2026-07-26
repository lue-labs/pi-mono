import { visibleWidth } from "@valkyriweb/pi-tui";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/utils/ansi.ts";
import { renderHunk } from "../src/utils/color-diff.ts";

function ansiPrefixForVisibleWidth(line: string, width: number): string {
	let index = 0;
	let visible = 0;
	while (index < line.length && visible < width) {
		if (line[index] === "\x1b") {
			const match = line.slice(index).match(/^\x1b\[[0-9;]*m/);
			if (match) {
				index += match[0].length;
				continue;
			}
		}
		index++;
		visible++;
	}
	return line.slice(0, index);
}

describe("color diff width", () => {
	it("accounts for rendered line-number width when wrapping", () => {
		const width = 117;
		const lines = renderHunk(
			{
				oldStart: 9,
				oldLines: 1,
				newStart: 9,
				newLines: 1,
				lines: [`+${"x".repeat(113)}`, `+${"y".repeat(113)}`],
			},
			null,
			"report.md",
			null,
			"dark",
			width,
			false,
		);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("uses a blank marker for wrapped diff continuations", () => {
		const lines = renderHunk(
			{
				oldStart: 1,
				oldLines: 0,
				newStart: 1,
				newLines: 1,
				lines: [`+const\t${"transport".repeat(20)} = true;`],
			},
			null,
			"transport.ts",
			null,
			"dark",
			40,
			false,
		);
		const plain = lines.map(stripAnsi);
		expect(plain).toHaveLength(6);
		expect(plain[0]).toMatch(/\+const/);
		for (const continuation of plain.slice(1)) {
			expect(continuation).not.toMatch(/\+transport/);
		}

		const changedGutter = ansiPrefixForVisibleWidth(lines[0]!, 4);
		const continuationGutter = ansiPrefixForVisibleWidth(lines[1]!, 4);
		// Match either background encoding: the renderer emits truecolor (48;2;r;g;b)
		// or 256-color (48;5;n) depending on the terminal's detected color depth.
		const changedBackground = changedGutter.match(/\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/)?.[0];
		expect(changedBackground).toBeDefined();
		expect(continuationGutter).not.toContain(changedBackground);
	});

	it("never emits over-wide lines for status-table rows with emoji", () => {
		const width = 117;
		const row =
			"| Haiku Fable Cost Weighting | ⚠️ silent, WIP found | no reply to 2 nudges, but its work located: uncommitted model-resolver WIP sitting in the canonical pi-mono-fork tree |";
		const lines = renderHunk(
			{
				oldStart: 20,
				oldLines: 3,
				newStart: 20,
				newLines: 3,
				lines: [`+${row}`],
			},
			null,
			"morning-report-2026-07-02.md",
			null,
			"dark",
			width,
			false,
		);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
