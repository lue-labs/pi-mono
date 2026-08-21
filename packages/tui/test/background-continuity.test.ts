import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Box } from "../src/components/box.ts";
import { Text } from "../src/components/text.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { applyBackgroundToLine } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const PANEL_BG = { r: 40, g: 50, b: 40 };
const truecolorBg = (text: string) => `\x1b[48;2;${PANEL_BG.r};${PANEL_BG.g};${PANEL_BG.b}m${text}\x1b[49m`;
const palettedBg = (text: string) => `\x1b[48;5;236m${text}\x1b[49m`;

function rowBackgrounds(terminal: VirtualTerminal, row: number, width: number): string[] {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const backgrounds: string[] = [];
	for (let col = 0; col < width; col++) {
		const cell = line.getCell(col);
		assert.ok(cell, `Missing cell at row ${row} col ${col}`);
		backgrounds.push(cell.isBgDefault() ? "default" : `${cell.getBgColorMode()}:${cell.getBgColor()}`);
	}
	return backgrounds;
}

async function renderRow(line: string, width: number, bgFn: (text: string) => string): Promise<string[]> {
	const terminal = new VirtualTerminal(width, 6);
	const tui: TUI = new TuiMainScreen(terminal);
	const box = new Box(1, 0, bgFn);
	box.addChild(new Text(line, 0, 0));
	tui.addChild(box);
	tui.start();
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
	const backgrounds = rowBackgrounds(terminal, 0, width);
	tui.stop();
	return backgrounds;
}

describe("background continuity", () => {
	it("keeps the panel background under content that fully resets its styling", async () => {
		const width = 24;
		const backgrounds = await renderRow(`\x1b[0mdiff context line\x1b[0m`, width, truecolorBg);
		assert.deepStrictEqual(
			backgrounds.filter((bg) => bg === "default"),
			[],
		);
		assert.strictEqual(new Set(backgrounds).size, 1);
	});

	it("keeps the panel background under content that resets only its background", async () => {
		const width = 24;
		const backgrounds = await renderRow(`\x1b[38;5;40mtext\x1b[49m tail`, width, truecolorBg);
		assert.deepStrictEqual(
			backgrounds.filter((bg) => bg === "default"),
			[],
		);
	});

	it("leaves backgrounds the content sets for itself untouched", async () => {
		const width = 24;
		const backgrounds = await renderRow(`\x1b[48;2;20;65;35m+ added\x1b[49m tail`, width, truecolorBg);
		assert.ok(backgrounds.slice(1, 8).every((bg) => bg !== "default"));
		assert.notStrictEqual(backgrounds[1], backgrounds[width - 1]);
		assert.deepStrictEqual(
			backgrounds.filter((bg) => bg === "default"),
			[],
		);
	});

	it("keeps 256-color panel backgrounds continuous", async () => {
		const width = 24;
		const backgrounds = await renderRow(`\x1b[0mdiff context line\x1b[0m`, width, palettedBg);
		assert.deepStrictEqual(
			backgrounds.filter((bg) => bg === "default"),
			[],
		);
		assert.strictEqual(new Set(backgrounds).size, 1);
	});

	it("keeps narrow widths and blank content continuous", async () => {
		const backgrounds = await renderRow(`\x1b[0m`, 4, truecolorBg);
		assert.deepStrictEqual(
			backgrounds.filter((bg) => bg === "default"),
			[],
		);
	});

	it("adds nothing when the caller's bgFn does not open a background", () => {
		const identity = (text: string) => text;
		const line = `\x1b[0mdiff context line\x1b[0m`;
		assert.strictEqual(applyBackgroundToLine(line, 24, identity), `${line}       `);
	});

	it("adds nothing when the caller's bgFn only appends a suffix", () => {
		const suffixOnly = (text: string) => `${text}\x1b[49m`;
		const line = `\x1b[0mdiff context line\x1b[0m`;
		assert.strictEqual(applyBackgroundToLine(line, 24, suffixOnly), `${line}       \x1b[49m`);
	});
});
