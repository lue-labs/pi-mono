import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Component that records how often it is rendered and what input it receives. */
class FocusProbe implements Component {
	renderCount = 0;
	readonly inputs: string[] = [];

	render(): string[] {
		this.renderCount++;
		return ["probe"];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

describe("TUI focus reporting (DEC mode 1004)", () => {
	it("consumes focus-in/out events and still forwards user input", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const probe = new FocusProbe();
		tui.addChild(probe);
		tui.setFocus(probe);

		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[O"); // focus-out
		terminal.sendInput("\x1b[I"); // focus-in
		assert.deepStrictEqual(probe.inputs, [], "focus events must not reach the component");

		terminal.sendInput("q");
		assert.deepStrictEqual(probe.inputs, ["q"], "ordinary input is still forwarded");

		tui.stop();
	});

	it("defers renders while unfocused and flushes once on focus-in", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const probe = new FocusProbe();
		tui.addChild(probe);
		tui.setFocus(probe);

		tui.start();
		await terminal.waitForRender();
		const baseline = probe.renderCount;

		// Lose focus, then request renders (as the spinner would each tick).
		terminal.sendInput("\x1b[O");
		tui.requestRender();
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(probe.renderCount, baseline, "no repaint while the terminal is unfocused");

		// Regaining focus flushes the deferred render exactly once.
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.strictEqual(probe.renderCount, baseline + 1, "one catch-up render on focus-in");

		tui.stop();
	});
});
