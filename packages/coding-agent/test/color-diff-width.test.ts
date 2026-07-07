import { visibleWidth } from "@valkyriweb/pi-tui";
import { describe, expect, it } from "vitest";
import { renderHunk } from "../src/utils/color-diff.ts";

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
