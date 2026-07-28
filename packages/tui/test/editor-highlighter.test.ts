import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor, type EditorHighlightRange } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const MARK_OPEN = "\x1b[1;35m";
const MARK_CLOSE = "\x1b[0m";
const mark = (text: string) => `${MARK_OPEN}${text}${MARK_CLOSE}`;

function createEditor(cols = 80): Editor {
	const tui = new TUI(new VirtualTerminal(cols, 24));
	return new Editor(tui, defaultEditorTheme);
}

/** All occurrences of `token` in `text`, as highlight ranges. */
function rangesFor(text: string, token: string): EditorHighlightRange[] {
	const ranges: EditorHighlightRange[] = [];
	let from = 0;
	for (;;) {
		const at = text.indexOf(token, from);
		if (at === -1) break;
		ranges.push({ start: at, end: at + token.length, style: mark });
		from = at + token.length;
	}
	return ranges;
}

function renderText(editor: Editor, width = 80): string {
	return editor.render(width).join("\n");
}

/** setText leaves the cursor at the end; walk it back to an absolute column. */
function moveCursorTo(editor: Editor, col: number): void {
	const steps = editor.getText().length - col;
	for (let i = 0; i < steps; i++) editor.handleInput("\x1b[D");
}

describe("Editor highlighter", () => {
	it("leaves text untouched when no highlighter is installed", () => {
		const editor = createEditor();
		editor.setText("load the polish skill");
		assert.ok(!renderText(editor).includes(MARK_OPEN));
	});

	it("styles a span anywhere in the line, not just at the start", () => {
		const editor = createEditor();
		editor.setText("please run /polish on this");
		editor.setHighlighter((text) => rangesFor(text, "/polish"));

		const rendered = renderText(editor);
		assert.ok(rendered.includes(`${MARK_OPEN}/polish${MARK_CLOSE}`), "mid-line span is styled");
		assert.ok(stripVTControlCharacters(rendered).includes("please run /polish on this"), "visible text unchanged");
	});

	it("styles every occurrence, not only the first", () => {
		const editor = createEditor();
		editor.setText("first /polish then /polish again");
		editor.setHighlighter((text) => rangesFor(text, "/polish"));

		const rendered = renderText(editor);
		const count = rendered.split(`${MARK_OPEN}/polish`).length - 1;
		assert.equal(count, 2, "both spans styled");
	});

	it("styles spans across multiple logical lines", () => {
		const editor = createEditor();
		editor.setText("run /polish\nthen /polish");
		editor.setHighlighter((text) => rangesFor(text, "/polish"));

		const rendered = renderText(editor);
		assert.equal(rendered.split(`${MARK_OPEN}/polish`).length - 1, 2, "span on each line styled");
	});

	it("keeps the cursor over the same character when spans shift the string", () => {
		const editor = createEditor();
		editor.setText("/polish this");
		// Cursor sits on the "t" of "this" (index 8).
		moveCursorTo(editor, 8);
		editor.setHighlighter((text) => rangesFor(text, "/polish"));

		const rendered = renderText(editor);
		const cursorAt = rendered.indexOf("\x1b[7m");
		assert.ok(cursorAt !== -1, "cursor rendered");
		assert.ok(rendered.slice(cursorAt).startsWith("\x1b[7mt"), "cursor still covers 't', not a shifted byte");
	});

	it("leaves the grapheme under the cursor unstyled so the cursor stays visible", () => {
		const editor = createEditor();
		editor.setText("/polish");
		// Cursor inside the highlighted token, on "o" (index 2).
		moveCursorTo(editor, 2);
		editor.setHighlighter((text) => rangesFor(text, "/polish"));

		const rendered = renderText(editor);
		const cursorAt = rendered.indexOf("\x1b[7m");
		assert.ok(cursorAt !== -1, "cursor rendered");
		assert.ok(rendered.slice(cursorAt).startsWith("\x1b[7mo"), "cursor grapheme is plain, not an escape byte");
		assert.ok(rendered.includes(MARK_OPEN), "the rest of the token is still styled");
		assert.equal(stripVTControlCharacters(rendered).includes("/polish"), true, "text is not duplicated or dropped");
	});

	it("ignores inverted and overlapping ranges", () => {
		const editor = createEditor();
		editor.setText("/polish this");
		editor.setHighlighter(() => [
			{ start: 5, end: 2, style: mark },
			{ start: 0, end: 7, style: mark },
			{ start: 3, end: 6, style: mark },
		]);

		const rendered = renderText(editor);
		assert.equal(stripVTControlCharacters(rendered).includes("/polish this"), true, "text survives intact");
		assert.equal(rendered.split(MARK_OPEN).length - 1, 1, "only the one valid range applied");
	});

	it("styles a span that lands on a wrapped chunk", () => {
		const editor = createEditor(24);
		const text = "aaaa bbbb cccc dddd eeee /polish ffff";
		editor.setText(text);
		editor.setHighlighter((value) => rangesFor(value, "/polish"));

		const rendered = renderText(editor, 24);
		assert.ok(rendered.includes(`${MARK_OPEN}/polish${MARK_CLOSE}`), "wrapped-line span is styled");
	});
});
