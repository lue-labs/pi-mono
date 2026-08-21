/**
 * Syntax-highlighted, background-colored diff renderer.
 *
 * Adapted from Claude Code's native-ts/color-diff/index.ts (MIT licence).
 * Key changes vs the original:
 *  - stringWidth  → visibleWidth from @lue-labs/pi-tui
 *  - logError     → console.error (one-shot guard kept)
 *  - Removed React/ink imports (pure ANSI string output only)
 */

import { basename, extname } from "node:path";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@lue-labs/pi-tui";
import { diffArrays } from "diff";
import hljs from "highlight.js/lib/index.js";

// ---------------------------------------------------------------------------
// Types (match the `diff` library's StructuredPatchHunk)
// ---------------------------------------------------------------------------

export type Hunk = {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
};

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

type Color = { r: number; g: number; b: number; a: number };
type Style = { foreground: Color; background: Color };
type Block = [Style, string];
type ColorMode = "truecolor" | "color256" | "ansi";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";

function rgb(r: number, g: number, b: number): Color {
	return { r, g, b, a: 255 };
}
function ansiIdx(index: number): Color {
	return { r: index, g: 0, b: 0, a: 0 };
}
const DEFAULT_BG: Color = { r: 0, g: 0, b: 0, a: 1 };

function detectColorMode(theme: string): ColorMode {
	if (theme.includes("ansi")) return "ansi";
	const ct = process.env.COLORTERM ?? "";
	return ct === "truecolor" || ct === "24bit" ? "truecolor" : "color256";
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
function ansi256FromRgb(r: number, g: number, b: number): number {
	const q = (c: number) => (c < 48 ? 0 : c < 115 ? 1 : c < 155 ? 2 : c < 195 ? 3 : c < 235 ? 4 : 5);
	const qr = q(r);
	const qg = q(g);
	const qb = q(b);
	const cubeIdx = 16 + 36 * qr + 6 * qg + qb;
	const grey = Math.round((r + g + b) / 3);
	if (grey < 5) return 16;
	if (grey > 244 && qr === qg && qg === qb) return cubeIdx;
	const greyLevel = Math.max(0, Math.min(23, Math.round((grey - 8) / 10)));
	const greyIdx = 232 + greyLevel;
	const greyRgb = 8 + greyLevel * 10;
	const cr = CUBE_LEVELS[qr]!;
	const cg = CUBE_LEVELS[qg]!;
	const cb = CUBE_LEVELS[qb]!;
	const dCube = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
	const dGrey = (r - greyRgb) ** 2 + (g - greyRgb) ** 2 + (b - greyRgb) ** 2;
	return dGrey < dCube ? greyIdx : cubeIdx;
}

function colorToEscape(c: Color, fg: boolean, mode: ColorMode): string {
	if (c.a === 0) {
		const idx = c.r;
		if (idx < 8) return `\x1b[${(fg ? 30 : 40) + idx}m`;
		if (idx < 16) return `\x1b[${(fg ? 90 : 100) + (idx - 8)}m`;
		return `\x1b[${fg ? 38 : 48};5;${idx}m`;
	}
	if (c.a === 1) return fg ? "\x1b[39m" : "\x1b[49m";
	const codeType = fg ? 38 : 48;
	if (mode === "truecolor") return `\x1b[${codeType};2;${c.r};${c.g};${c.b}m`;
	return `\x1b[${codeType};5;${ansi256FromRgb(c.r, c.g, c.b)}m`;
}

function asTerminalEscaped(blocks: readonly Block[], mode: ColorMode, skipBackground: boolean, dim: boolean): string {
	let out = dim ? RESET + DIM : RESET;
	for (const [style, text] of blocks) {
		out += colorToEscape(style.foreground, true, mode);
		if (!skipBackground) out += colorToEscape(style.background, false, mode);
		out += text;
	}
	return out + RESET;
}

// ---------------------------------------------------------------------------
// Theme palettes
// ---------------------------------------------------------------------------

type Marker = "+" | "-" | " ";

type Theme = {
	addLine: Color;
	addWord: Color;
	addDecoration: Color;
	deleteLine: Color;
	deleteWord: Color;
	deleteDecoration: Color;
	foreground: Color;
	background: Color;
	scopes: Record<string, Color>;
};

// One Dark Pro — matches VS Code / Codex dark theme
const ONE_DARK_PRO_SCOPES: Record<string, Color> = {
	keyword: rgb(198, 120, 221), // #c678dd purple
	_storage: rgb(198, 120, 221),
	built_in: rgb(86, 182, 194), // #56b6c2 cyan
	type: rgb(229, 192, 123), // #e5c07b amber
	literal: rgb(209, 154, 102), // #d19a66 orange
	number: rgb(209, 154, 102),
	string: rgb(152, 195, 121), // #98c379 green
	title: rgb(97, 175, 239), // #61afef blue
	"title.function": rgb(97, 175, 239),
	"title.class": rgb(229, 192, 123), // amber
	"title.class.inherited": rgb(229, 192, 123),
	params: rgb(171, 178, 191), // #abb2bf default
	comment: rgb(92, 99, 112), // #5c6370 gray
	meta: rgb(92, 99, 112),
	attr: rgb(97, 175, 239), // blue for JSX attrs
	attribute: rgb(209, 154, 102), // orange
	variable: rgb(224, 108, 117), // #e06c75 red
	"variable.language": rgb(198, 120, 221), // purple — this/self
	property: rgb(224, 108, 117), // #e06c75 red
	operator: rgb(86, 182, 194), // cyan
	punctuation: rgb(171, 178, 191), // default
	symbol: rgb(209, 154, 102), // orange
	regexp: rgb(152, 195, 121), // green
	subst: rgb(171, 178, 191), // default
};

// Legacy Monokai Extended kept for reference (no longer used for dark)
const GITHUB_SCOPES: Record<string, Color> = {
	keyword: rgb(167, 29, 93),
	_storage: rgb(167, 29, 93),
	built_in: rgb(0, 134, 179),
	type: rgb(0, 134, 179),
	literal: rgb(0, 134, 179),
	number: rgb(0, 134, 179),
	string: rgb(24, 54, 145),
	title: rgb(121, 93, 163),
	"title.function": rgb(121, 93, 163),
	"title.class": rgb(0, 0, 0),
	"title.class.inherited": rgb(0, 0, 0),
	params: rgb(0, 134, 179),
	comment: rgb(150, 152, 150),
	meta: rgb(150, 152, 150),
	attr: rgb(0, 134, 179),
	attribute: rgb(0, 134, 179),
	variable: rgb(0, 134, 179),
	"variable.language": rgb(0, 134, 179),
	property: rgb(0, 134, 179),
	operator: rgb(167, 29, 93),
	punctuation: rgb(51, 51, 51),
	symbol: rgb(0, 134, 179),
	regexp: rgb(24, 54, 145),
	subst: rgb(51, 51, 51),
};

const STORAGE_KEYWORDS = new Set([
	"const",
	"let",
	"var",
	"function",
	"class",
	"type",
	"interface",
	"enum",
	"namespace",
	"module",
	"def",
	"fn",
	"func",
	"struct",
	"trait",
	"impl",
]);

const ANSI_SCOPES: Record<string, Color> = {
	keyword: ansiIdx(13),
	_storage: ansiIdx(14),
	built_in: ansiIdx(14),
	type: ansiIdx(14),
	literal: ansiIdx(12),
	number: ansiIdx(12),
	string: ansiIdx(10),
	title: ansiIdx(11),
	"title.function": ansiIdx(11),
	comment: ansiIdx(8),
	meta: ansiIdx(8),
};

function buildTheme(themeName: string, mode: ColorMode): Theme {
	const isDark = themeName.includes("dark");
	const isAnsi = themeName.includes("ansi");
	const tc = mode === "truecolor";

	if (isAnsi) {
		return {
			addLine: DEFAULT_BG,
			addWord: DEFAULT_BG,
			addDecoration: ansiIdx(10),
			deleteLine: DEFAULT_BG,
			deleteWord: DEFAULT_BG,
			deleteDecoration: ansiIdx(9),
			foreground: ansiIdx(7),
			background: DEFAULT_BG,
			scopes: ANSI_SCOPES,
		};
	}
	if (isDark) {
		return {
			addLine: tc ? rgb(20, 65, 35) : ansiIdx(22), // #14411f — visible dark green
			addWord: tc ? rgb(40, 110, 58) : ansiIdx(28), // #286e3a — brighter word highlight
			addDecoration: rgb(97, 214, 97), // #61d661 bright + marker
			deleteLine: tc ? rgb(88, 18, 22) : ansiIdx(88), // #581216 — visible dark red
			deleteWord: tc ? rgb(130, 32, 38) : ansiIdx(88), // #822026 — brighter word highlight
			deleteDecoration: rgb(220, 90, 100), // #dc5a64 bright - marker
			foreground: rgb(171, 178, 191), // #abb2bf One Dark Pro default
			background: DEFAULT_BG,
			scopes: ONE_DARK_PRO_SCOPES,
		};
	}
	// light
	return {
		addLine: rgb(220, 255, 220),
		addWord: rgb(178, 255, 178),
		addDecoration: rgb(36, 138, 61),
		deleteLine: rgb(255, 220, 220),
		deleteWord: rgb(255, 199, 199),
		deleteDecoration: rgb(207, 34, 46),
		foreground: rgb(51, 51, 51),
		background: DEFAULT_BG,
		scopes: GITHUB_SCOPES,
	};
}

function defaultStyle(theme: Theme): Style {
	return { foreground: theme.foreground, background: theme.background };
}
function lineBackground(marker: Marker, theme: Theme): Color {
	if (marker === "+") return theme.addLine;
	if (marker === "-") return theme.deleteLine;
	return theme.background;
}
function wordBackground(marker: Marker, theme: Theme): Color {
	if (marker === "+") return theme.addWord;
	if (marker === "-") return theme.deleteWord;
	return theme.background;
}
function decorationColor(marker: Marker, theme: Theme): Color {
	if (marker === "+") return theme.addDecoration;
	if (marker === "-") return theme.deleteDecoration;
	return theme.foreground;
}

// ---------------------------------------------------------------------------
// Syntax highlighting via highlight.js
// ---------------------------------------------------------------------------

type HljsNode = { scope?: string; kind?: string; children: (HljsNode | string)[] };

const FILENAME_LANGS: Record<string, string> = {
	Dockerfile: "dockerfile",
	Makefile: "makefile",
	Rakefile: "ruby",
	Gemfile: "ruby",
	CMakeLists: "cmake",
};

function detectLanguage(filePath: string, firstLine: string | null): string | null {
	const base = basename(filePath);
	const ext = extname(filePath).slice(1);
	const stem = base.split(".")[0] ?? "";
	const byName = FILENAME_LANGS[base] ?? FILENAME_LANGS[stem];
	if (byName && hljs.getLanguage(byName)) return byName;
	if (ext && hljs.getLanguage(ext)) return ext;
	if (firstLine) {
		const line = firstLine.startsWith("\ufeff") ? firstLine.slice(1) : firstLine;
		if (line.startsWith("#!")) {
			if (line.includes("bash") || line.includes("/sh")) return "bash";
			if (line.includes("python")) return "python";
			if (line.includes("node")) return "javascript";
			if (line.includes("ruby")) return "ruby";
		}
		if (line.startsWith("<?php")) return "php";
		if (line.startsWith("<?xml")) return "xml";
	}
	return null;
}

function scopeColor(scope: string | undefined, text: string, theme: Theme): Color {
	if (!scope) return theme.foreground;
	if (scope === "keyword" && STORAGE_KEYWORDS.has(text.trim())) {
		return theme.scopes._storage ?? theme.foreground;
	}
	return theme.scopes[scope] ?? theme.scopes[scope.split(".")[0]!] ?? theme.foreground;
}

function flattenHljs(node: HljsNode | string, theme: Theme, parentScope: string | undefined, out: Block[]): void {
	if (typeof node === "string") {
		out.push([{ foreground: scopeColor(parentScope, node, theme), background: theme.background }, node]);
		return;
	}
	const scope = node.scope ?? node.kind ?? parentScope;
	for (const child of node.children) flattenHljs(child, theme, scope, out);
}

function hasRootNode(emitter: unknown): emitter is { rootNode: HljsNode } {
	return (
		typeof emitter === "object" &&
		emitter !== null &&
		"rootNode" in emitter &&
		typeof (emitter as Record<string, unknown>).rootNode === "object" &&
		(emitter as Record<string, unknown>).rootNode !== null &&
		"children" in ((emitter as Record<string, unknown>).rootNode as object)
	);
}

let loggedMissingEmitterRootNode = false;

function highlightLine(state: { lang: string | null }, line: string, theme: Theme): Block[] {
	const code = `${line}\n`;
	if (!state.lang) return [[defaultStyle(theme), code]];
	let result: ReturnType<typeof hljs.highlight>;
	try {
		result = hljs.highlight(code, { language: state.lang, ignoreIllegals: true });
	} catch {
		return [[defaultStyle(theme), code]];
	}
	// emitter is an internal hljs property not exposed in its type definitions
	const emitter = (result as unknown as { emitter?: unknown }).emitter;
	if (!hasRootNode(emitter)) {
		if (!loggedMissingEmitterRootNode) {
			loggedMissingEmitterRootNode = true;
			console.error("color-diff: hljs emitter has no rootNode, so syntax highlighting is disabled.");
		}
		return [[defaultStyle(theme), code]];
	}
	const blocks: Block[] = [];
	flattenHljs(emitter.rootNode, theme, undefined, blocks);
	return blocks;
}

// ---------------------------------------------------------------------------
// Word diff
// ---------------------------------------------------------------------------

type Range = { start: number; end: number };
const CHANGE_THRESHOLD = 0.4;

function tokenize(text: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (/[\p{L}\p{N}_]/u.test(ch)) {
			let j = i + 1;
			while (j < text.length && /[\p{L}\p{N}_]/u.test(text[j]!)) j++;
			tokens.push(text.slice(i, j));
			i = j;
		} else if (/\s/.test(ch)) {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j]!)) j++;
			tokens.push(text.slice(i, j));
			i = j;
		} else {
			const cp = text.codePointAt(i)!;
			const len = cp > 0xffff ? 2 : 1;
			tokens.push(text.slice(i, i + len));
			i += len;
		}
	}
	return tokens;
}

function findAdjacentPairs(markers: Marker[]): [number, number][] {
	const pairs: [number, number][] = [];
	let i = 0;
	while (i < markers.length) {
		if (markers[i] === "-") {
			const delStart = i;
			let delEnd = i;
			while (delEnd < markers.length && markers[delEnd] === "-") delEnd++;
			let addEnd = delEnd;
			while (addEnd < markers.length && markers[addEnd] === "+") addEnd++;
			const n = Math.min(delEnd - delStart, addEnd - delEnd);
			for (let k = 0; k < n; k++) pairs.push([delStart + k, delEnd + k]);
			i = addEnd;
		} else {
			i++;
		}
	}
	return pairs;
}

function wordDiffStrings(oldStr: string, newStr: string): [Range[], Range[]] {
	const oldTokens = tokenize(oldStr);
	const newTokens = tokenize(newStr);
	const ops = diffArrays(oldTokens, newTokens);
	const totalLen = oldStr.length + newStr.length;
	let changedLen = 0;
	const oldRanges: Range[] = [];
	const newRanges: Range[] = [];
	let oldOff = 0;
	let newOff = 0;
	for (const op of ops) {
		const len = op.value.reduce((s, t) => s + t.length, 0);
		if (op.removed) {
			changedLen += len;
			oldRanges.push({ start: oldOff, end: oldOff + len });
			oldOff += len;
		} else if (op.added) {
			changedLen += len;
			newRanges.push({ start: newOff, end: newOff + len });
			newOff += len;
		} else {
			oldOff += len;
			newOff += len;
		}
	}
	if (totalLen > 0 && changedLen / totalLen > CHANGE_THRESHOLD) return [[], []];
	return [oldRanges, newRanges];
}

// ---------------------------------------------------------------------------
// Line transform pipeline
// ---------------------------------------------------------------------------

type Highlight = { marker: Marker | null; lineNumber: number; lines: Block[][] };

function removeNewlines(h: Highlight): void {
	h.lines = h.lines.map((line) =>
		line.flatMap(([style, text]) =>
			text
				.split("\n")
				.filter((p) => p.length > 0)
				.map((p): Block => [style, p]),
		),
	);
}

function wrapText(h: Highlight, width: number, theme: Theme): void {
	const newLines: Block[][] = [];
	for (const line of h.lines) {
		const queue: Block[] = line.slice();
		let cur: Block[] = [];
		let curW = 0;
		while (queue.length > 0) {
			const [style, text] = queue.shift()!;
			const tw = visibleWidth(text);
			if (curW + tw <= width) {
				cur.push([style, text]);
				curW += tw;
			} else {
				const remaining = width - curW;
				let bytePos = 0;
				let accW = 0;
				for (const ch of text) {
					const cw = visibleWidth(ch);
					if (accW + cw > remaining) break;
					accW += cw;
					bytePos += ch.length;
				}
				if (bytePos === 0) {
					if (curW === 0) {
						const firstCp = text.codePointAt(0)!;
						bytePos = firstCp > 0xffff ? 2 : 1;
					} else {
						newLines.push(cur);
						queue.unshift([style, text]);
						cur = [];
						curW = 0;
						continue;
					}
				}
				cur.push([style, text.slice(0, bytePos)]);
				newLines.push(cur);
				queue.unshift([style, text.slice(bytePos)]);
				cur = [];
				curW = 0;
			}
		}
		newLines.push(cur);
	}
	h.lines = newLines;
	// Pad changed lines so background extends to edge
	if (h.marker && h.marker !== " ") {
		const bg = lineBackground(h.marker, theme);
		const padStyle: Style = { foreground: theme.foreground, background: bg };
		for (const line of h.lines) {
			const curW = line.reduce((s, [, t]) => s + visibleWidth(t), 0);
			if (curW < width) line.push([padStyle, " ".repeat(width - curW)]);
		}
	}
}

function addLineNumber(h: Highlight, theme: Theme, maxDigits: number, fullDim: boolean): void {
	const changedStyle: Style = {
		foreground: h.marker ? decorationColor(h.marker, theme) : theme.foreground,
		background: h.marker ? lineBackground(h.marker, theme) : theme.background,
	};
	const neutralStyle: Style = { foreground: theme.foreground, background: theme.background };
	const shouldDim = h.marker === null || h.marker === " ";
	for (let i = 0; i < h.lines.length; i++) {
		const prefix = i === 0 ? ` ${String(h.lineNumber).padStart(maxDigits)} ` : " ".repeat(maxDigits + 2);
		const wrapped = (shouldDim || i > 0) && !fullDim ? `${DIM}${prefix}${UNDIM}` : prefix;
		h.lines[i]!.unshift([i === 0 ? changedStyle : neutralStyle, wrapped]);
	}
}

function addMarker(h: Highlight, theme: Theme): void {
	if (!h.marker) return;
	const changedStyle: Style = {
		foreground: decorationColor(h.marker, theme),
		background: lineBackground(h.marker, theme),
	};
	const neutralStyle: Style = { foreground: theme.foreground, background: theme.background };
	for (let i = 0; i < h.lines.length; i++) {
		h.lines[i]!.unshift([i === 0 ? changedStyle : neutralStyle, i === 0 ? h.marker : " "]);
	}
}

function dimContent(h: Highlight): void {
	for (const line of h.lines) {
		if (line.length > 0) {
			line[0]![1] = DIM + line[0]![1];
			const last = line.length - 1;
			line[last]![1] = line[last]![1] + UNDIM;
		}
	}
}

function applyBackground(h: Highlight, theme: Theme, ranges: Range[]): void {
	if (!h.marker) return;
	const lineBg = lineBackground(h.marker, theme);
	const wordBg = wordBackground(h.marker, theme);
	let rangeIdx = 0;
	let byteOff = 0;
	for (let li = 0; li < h.lines.length; li++) {
		const newLine: Block[] = [];
		for (const [style, text] of h.lines[li]!) {
			const textStart = byteOff;
			const textEnd = byteOff + text.length;
			while (rangeIdx < ranges.length && ranges[rangeIdx]!.end <= textStart) rangeIdx++;
			if (rangeIdx >= ranges.length) {
				newLine.push([{ ...style, background: lineBg }, text]);
				byteOff = textEnd;
				continue;
			}
			let remaining = text;
			let pos = textStart;
			while (remaining.length > 0 && rangeIdx < ranges.length) {
				const r = ranges[rangeIdx]!;
				const inRange = pos >= r.start && pos < r.end;
				let next: number;
				if (inRange) next = Math.min(r.end, textEnd);
				else if (r.start > pos && r.start < textEnd) next = r.start;
				else next = textEnd;
				const segLen = next - pos;
				const seg = remaining.slice(0, segLen);
				newLine.push([{ ...style, background: inRange ? wordBg : lineBg }, seg]);
				remaining = remaining.slice(segLen);
				pos = next;
				if (pos >= r.end) rangeIdx++;
			}
			if (remaining.length > 0) newLine.push([{ ...style, background: lineBg }, remaining]);
			byteOff = textEnd;
		}
		h.lines[li] = newLine;
	}
}

function fitRenderedLineToWidth(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [line];
	return wrapTextWithAnsi(line, width).map((wrapped) =>
		visibleWidth(wrapped) <= width ? wrapped : truncateToWidth(wrapped, width, "", false),
	);
}

function intoLines(h: Highlight, dim: boolean, skipBg: boolean, mode: ColorMode, width: number): string[] {
	return h.lines.flatMap((line) => fitRenderedLineToWidth(asTerminalEscaped(line, mode, skipBg, dim), width));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function maxLineNumber(hunk: Hunk): number {
	return Math.max(Math.max(0, hunk.oldStart + hunk.oldLines - 1), Math.max(0, hunk.newStart + hunk.newLines - 1));
}

function parseMarker(s: string): Marker {
	return s === "+" || s === "-" ? s : " ";
}

/**
 * Render a single diff hunk with syntax highlighting and background colors.
 * Returns an array of ANSI-colored lines ready for display.
 *
 * @param hunk      - A StructuredPatchHunk from the `diff` library
 * @param firstLine - First line of the file (for shebang detection); null if unknown
 * @param filePath  - File path (for language detection via extension)
 * @param fileContent - Full original file content (for syntax context); null if unknown
 * @param themeName - "dark" → Monokai Extended palette; anything else → GitHub palette
 * @param width     - Terminal column width to wrap/pad to
 * @param dim       - Render in dimmed mode (used for rejected changes)
 */
export function renderHunk(
	hunk: Hunk,
	firstLine: string | null,
	filePath: string,
	_fileContent: string | null,
	themeName: string,
	width: number,
	dim: boolean,
): string[] {
	const mode = detectColorMode(themeName);
	const theme = buildTheme(themeName, mode);
	const lang = detectLanguage(filePath, firstLine);
	const hlState = { lang };

	let oldLine = hunk.oldStart;
	let newLine = hunk.newStart;

	type Entry = { lineNumber: number; marker: Marker; code: string };
	const entries: Entry[] = hunk.lines.map((rawLine) => {
		const marker = parseMarker(rawLine.slice(0, 1));
		const code = rawLine.slice(1);
		let lineNumber: number;
		if (marker === "+") {
			lineNumber = newLine++;
		} else if (marker === "-") {
			lineNumber = oldLine++;
		} else {
			lineNumber = newLine;
			oldLine++;
			newLine++;
		}
		return { lineNumber, marker, code };
	});

	const maxRenderedLineNumber = entries.reduce((max, entry) => Math.max(max, entry.lineNumber), maxLineNumber(hunk));
	const maxDigits = String(maxRenderedLineNumber).length;
	const effectiveWidth = Math.max(1, width - maxDigits - 2 - 1);

	const ranges: Range[][] = entries.map(() => []);
	if (!dim) {
		const markers = entries.map((e) => e.marker);
		for (const [delIdx, addIdx] of findAdjacentPairs(markers)) {
			const [delR, addR] = wordDiffStrings(entries[delIdx]!.code, entries[addIdx]!.code);
			ranges[delIdx] = delR;
			ranges[addIdx] = addR;
		}
	}

	const out: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const { lineNumber, marker, code } = entries[i]!;
		const tokens: Block[] = marker === "-" ? [[defaultStyle(theme), code]] : highlightLine(hlState, code, theme);
		const h: Highlight = { marker, lineNumber, lines: [tokens] };
		removeNewlines(h);
		applyBackground(h, theme, ranges[i]!);
		wrapText(h, effectiveWidth, theme);
		if (mode === "ansi" && marker === "-") dimContent(h);
		addMarker(h, theme);
		addLineNumber(h, theme, maxDigits, dim);
		out.push(...intoLines(h, dim, false, mode, width));
	}
	return out;
}

/**
 * Render all hunks for a file diff.
 * Returns flat array of ANSI-colored lines (hunks separated by empty line).
 */
export function renderHunks(
	hunks: Hunk[],
	firstLine: string | null,
	filePath: string,
	fileContent: string | null,
	themeName: string,
	width: number,
	dim = false,
): string[] {
	const out: string[] = [];
	for (let i = 0; i < hunks.length; i++) {
		if (i > 0) out.push(""); // blank line between hunks
		out.push(...renderHunk(hunks[i]!, firstLine, filePath, fileContent, themeName, width, dim));
	}
	return out;
}
