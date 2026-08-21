import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Terminal, Text, type TUI, TuiMainScreen, visibleWidth } from "@lue-labs/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { computeEditsDiff, type Edit } from "../src/core/tools/edit-diff.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	get fullClearCount(): number {
		return this.writes.filter((write) => write.includes("\x1b[2J\x1b[H\x1b[3J")).length;
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

// Strip ANSI escape sequences. Word-level diff highlighting (added by
// utils/color-diff.ts) splits the changed word from its surrounding text with
// background-color escapes, so the visible substring "line N changed" never
// appears literally in the raw render. Assertions need the visible text.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

async function waitForRenderedText(
	getRender: () => string,
	expectedText: string,
	onRetry?: () => void,
	timeoutMs = 2000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastRender = "";
	while (Date.now() < deadline) {
		onRetry?.();
		await waitForRender();
		lastRender = getRender();
		if (lastRender.includes(expectedText)) {
			return lastRender;
		}
	}
	throw new Error(`Timed out waiting for render to include "${expectedText}". Last render:\n${lastRender}`);
}

async function waitForRawRenderText(
	getRender: () => string,
	expectedText: string,
	onRetry?: () => void,
	timeoutMs = 2000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastRender = "";
	while (Date.now() < deadline) {
		onRetry?.();
		await waitForRender();
		lastRender = getRender();
		if (lastRender.includes(expectedText)) {
			return lastRender;
		}
	}
	throw new Error(`Timed out waiting for raw render to include "${expectedText}". Last render:\n${lastRender}`);
}

function createLargeEdits(lines: string[]): Edit[] {
	const targets = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950];
	return targets.map((lineNumber) => ({
		oldText: `${lines[lineNumber - 1]}\n${lines[lineNumber]}\n${lines[lineNumber + 1]}`,
		newText: `${lines[lineNumber - 1]}\n${lines[lineNumber]} changed\n${lines[lineNumber + 1]}`,
	}));
}

describe("edit tool TUI rendering", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("renders the large diff in the call preview and does not full-redraw when the result settles", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-redraw-"));
		tempDirs.push(dir);
		const filePath = join(dir, "large-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		const edits = createLargeEdits(lines);
		const diff = await computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const root = new Container();
		for (let i = 0; i < 200; i++) {
			root.addChild(new Text(`history ${i}`, 0, 0));
		}

		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-1",
			{ path: filePath, edits },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		root.addChild(component);
		tui.addChild(root);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		component.setExpanded(true);
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const callOnlyRender = await waitForRenderedText(
			() => stripAnsi(component.render(80).join("\n")),
			"line 50 changed",
			() => tui.requestRender(true),
		);
		expect(callOnlyRender).toContain("edit");
		expect(callOnlyRender).toContain("line 950 changed");

		const redrawsBeforeResult = tui.fullRedraws;
		const clearsBeforeResult = terminal.fullClearCount;
		component.updateResult(
			{
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
				details: diff,
				isError: false,
			},
			false,
		);
		tui.requestRender();
		await waitForRender();

		expect(tui.fullRedraws).toBe(redrawsBeforeResult);
		expect(terminal.fullClearCount).toBe(clearsBeforeResult);

		const settledRender = stripAnsi(component.render(80).join("\n"));
		expect(settledRender).toContain("line 50 changed");
		expect(settledRender).toContain("line 950 changed");
		expect(settledRender).not.toContain("Successfully replaced");
	});

	it("reconstructs the boxed preview from a settled result without argsComplete", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-replay-"));
		tempDirs.push(dir);
		const filePath = join(dir, "replay-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		const edits = createLargeEdits(lines).slice(0, 2);
		const diff = await computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}
		await rm(filePath, { force: true });

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-replay",
			{ path: filePath, edits },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.setExpanded(true);
		component.updateResult(
			{
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
				details: diff,
				isError: false,
			},
			false,
		);
		await waitForRender();
		await waitForRender();

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("line 50 changed");
		expect(rendered).toContain("line 150 changed");
	});

	it("renders rich diff styling while edit arguments are still streaming", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-streaming-diff-"));
		tempDirs.push(dir);
		const filePath = join(dir, "streaming-edit.ts");
		await writeFile(filePath, "const value = 'before';\nconsole.log(value);\n", "utf8");

		const terminal = new FakeTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-streaming-diff",
			{ path: filePath, edits: [{ oldText: "const value = 'before';", newText: "const value = 'after';" }] },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();
		component.setExpanded(true);

		const rendered = await waitForRenderedText(
			() => stripAnsi(component.render(80).join("\n")),
			"const value = 'after';",
			() => tui.requestRender(true),
		);
		expect(rendered).toContain("const value = 'before';");
		expect(rendered).toContain("const value = 'after';");
		expect(rendered).not.toContain("Successfully replaced");
	});

	it("keeps a long literal \\t edit compact until explicitly expanded", () => {
		const terminal = new FakeTerminal();
		const tui = new TuiMainScreen(terminal);
		const longValue = String.raw`const\t${"transport".repeat(16)} = "before";`;
		const replacement = String.raw`const\t${"transport".repeat(16)} = "after";`;
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-compact-tab",
			{ path: "src/transport.ts", edits: [{ oldText: longValue, newText: replacement }] },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					diff: `-1 ${longValue}\n+1 ${replacement}`,
					hunks: [
						{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${longValue}`, `+${replacement}`] },
					],
				},
				isError: false,
			},
			false,
		);

		const compact = stripAnsi(component.render(80).join("\n"));
		expect(compact).toContain("src/transport.ts");
		expect(compact).toContain("+1 -1");
		expect(compact).not.toContain(replacement);

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain(String.raw`const\ttransport`);
		expect(expanded).toContain("after");
	});

	it("counts proposed changes per replacement instead of diffing unrelated blocks together", () => {
		const tui = new TuiMainScreen(new FakeTerminal());
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-independent-summary",
			{
				path: "src/swap.ts",
				edits: [
					{ oldText: "alpha", newText: "beta" },
					{ oldText: "beta", newText: "alpha" },
				],
			},
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("+2 -2");
	});

	it("uses the error background when execution fails after a successful preview", () => {
		const tui = new TuiMainScreen(new FakeTerminal());
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-error-after-preview",
			{ path: "src/transport.ts", edits: [{ oldText: "before", newText: "after" }] },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
				details: {
					diff: "-before\n+after",
					firstChangedLine: 1,
					hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-before", "+after"] }],
				},
				isError: false,
			},
			false,
		);
		component.updateResult(
			{ content: [{ type: "text", text: "Edit failed" }], details: undefined, isError: true },
			false,
		);

		const errorBackgroundPrefix = theme.bg("toolErrorBg", "X").split("X", 1)[0];
		expect(component.render(80).join("\n")).toContain(errorBackgroundPrefix);
	});

	it("uses Pierre for the legacy no-hunks diff renderer when enabled", async () => {
		const previousRenderer = process.env.PI_TUI_DIFF_RENDERER;
		process.env.PI_TUI_DIFF_RENDERER = "pierre";
		try {
			const dir = await mkdtemp(join(tmpdir(), "pi-edit-pierre-legacy-"));
			tempDirs.push(dir);
			const filePath = join(dir, "legacy-edit.ts");
			const patch = `--- a/${filePath}
+++ b/${filePath}
@@ -1,2 +1,2 @@
-const value = 'before';
+const value = 'after';
 console.log(value);
`;

			const terminal = new FakeTerminal();
			const tui = new TuiMainScreen(terminal);
			const component = new ToolExecutionComponent(
				"edit",
				"tool-call-pierre-legacy",
				{ path: filePath, edits: [{ oldText: "before", newText: "after" }] },
				{},
				createEditToolDefinition(process.cwd()),
				tui,
				process.cwd(),
			);
			tui.addChild(component);
			tui.start();
			component.setExpanded(true);
			component.updateResult(
				{
					content: [{ type: "text", text: "done" }],
					details: { diff: "-1 const value = 'before';\n+1 const value = 'after';", patch, hunks: [] },
					isError: false,
				},
				false,
			);

			const rendered = await waitForRawRenderText(
				() => component.render(120).join("\n"),
				"+  1",
				() => tui.requestRender(true),
			);
			expect(stripAnsi(rendered)).toContain("+  1 const value = 'after';");
		} finally {
			if (previousRenderer === undefined) {
				delete process.env.PI_TUI_DIFF_RENDERER;
			} else {
				process.env.PI_TUI_DIFF_RENDERER = previousRenderer;
			}
		}
	});

	it("shows only a proposed summary before execution validates the edits", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-preflight-"));
		tempDirs.push(dir);
		const filePath = join(dir, "missing-edit.txt");
		await writeFile(filePath, "line 0\nline 1\n", "utf8");

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-2",
			{ path: filePath, edits: [{ oldText: "does not exist", newText: "replacement" }] },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("+1 -1");
		expect(rendered).not.toContain("Could not find");
	});

	it("wraps the final error text from failed edit execution", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-final-error-"));
		tempDirs.push(dir);
		const filePath = join(dir, "missing-edit.txt");
		await writeFile(filePath, "line 0\nline 1\n", "utf8");

		const terminal = new FakeTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-final-error",
			{ path: filePath, edits: [{ oldText: "", newText: "replacement" }] },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();

		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "Could not find edits[10] in /Users/luke/Projects/personal/babysitter/babysit. The oldText must match exactly including all whitespace and newlines. Re-read the current file and retry with the smallest unique oldText block copied exactly from the file (usually 1-3 lines). If copying from Read output, omit line numbers, tabs/colons, and separators. edits[10]: oldText not present in current file (1 line(s), 90 chars).",
					},
				],
				isError: true,
			},
			false,
		);

		const width = 60;
		const renderedLines = component.render(width);
		expect(renderedLines.some((line) => stripAnsi(line).includes("Could not find edits[10]"))).toBe(true);
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("wraps duplicate-match final edit errors from native-tool-overrides", async () => {
		const terminal = new FakeTerminal();
		const tui = new TuiMainScreen(terminal);
		const longPath =
			"/Users/luke/Projects/work/paperclip-lane-subscription-budgets/server/src/__tests__/costs-service.test.ts";
		const errorText = `Found 3 occurrences of edits[3] in ${longPath}. Each oldText must be unique. Please provide more context to make it unique. If you intend to replace every occurrence in this file, retry with replaceAll: true.`;
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-duplicate-final-error",
			{ path: longPath, edits: [{ oldText: "repeated", newText: "replacement" }] },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.updateResult(
			{
				content: [{ type: "text", text: errorText }],
				isError: true,
			},
			false,
		);
		await waitForRender();

		const width = 80;
		const renderedLines = component.render(width);
		expect(stripAnsi(renderedLines.join("\n"))).toContain("Found 3 occurrences of edits[3]");
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
