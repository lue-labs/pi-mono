import { visibleWidth } from "@lue-labs/pi-tui";

const RESET = "\x1b[0m";
const INVERSE = "\x1b[7m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

type HastNode = {
	type: string;
	value?: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
};

type PierreDiffsModule = {
	DiffHunksRenderer: new (
		options?: Record<string, unknown>,
	) => {
		asyncRender(diff: unknown): Promise<{
			unifiedContentAST?: HastNode[];
			unifiedGutterAST?: HastNode[] | { children?: HastNode[] };
		}>;
	};
	processPatch: (patch: string, cacheKeyPrefix?: string, throwOnError?: boolean) => { files: unknown[] };
};

function ansiColor(hex: string): string {
	const match = hex.match(/^#?([0-9a-f]{6})$/i);
	if (!match) return "";
	const value = match[1];
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function styleToAnsi(style: unknown): string {
	if (typeof style !== "string") return "";
	const color = style.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-f]{6})/i)?.[1];
	return color ? ansiColor(color) : "";
}

function textFromNode(node: HastNode, inheritedAnsi = "", inverse = false): string {
	if (node.type === "text") {
		const value = node.value ?? "";
		if (!value) return "";
		return `${inheritedAnsi}${inverse ? INVERSE : ""}${value}${RESET}`;
	}
	const props = node.properties ?? {};
	const nextAnsi = styleToAnsi(props.style) || inheritedAnsi;
	const nextInverse = inverse || Object.hasOwn(props, "data-diff-span");
	return (node.children ?? []).map((child) => textFromNode(child, nextAnsi, nextInverse)).join("");
}

function plainTextFromNode(node: HastNode): string {
	if (node.type === "text") return node.value ?? "";
	return (node.children ?? []).map(plainTextFromNode).join("");
}

function markerForLineType(lineType: unknown): { marker: string; ansi: string } {
	switch (lineType) {
		case "change-deletion":
			return { marker: "-", ansi: RED };
		case "change-addition":
			return { marker: "+", ansi: GREEN };
		default:
			return { marker: " ", ansi: DIM };
	}
}

function truncateAnsiLine(line: string, width: number): string {
	if (width <= 0 || visibleWidth(line) <= width) return line;
	let out = "";
	let visible = 0;
	let i = 0;
	while (i < line.length && visible < width - 1) {
		if (line[i] === "\x1b") {
			const end = line.indexOf("m", i);
			if (end === -1) break;
			out += line.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		out += line[i];
		visible++;
		i++;
	}
	return `${out}…${RESET}`;
}

export interface PierrePatchRenderOptions {
	theme?: "dark" | "light";
}

export async function renderPierrePatchToAnsi(
	patch: string,
	width: number,
	options: PierrePatchRenderOptions = {},
): Promise<string[]> {
	const pierre = (await import("@pierre/diffs")) as PierreDiffsModule;
	const parsed = pierre.processPatch(patch, "pi-tui", true);
	const file = parsed.files[0];
	if (!file) return [];
	const renderer = new pierre.DiffHunksRenderer({
		diffStyle: "unified",
		disableFileHeader: true,
		disableLineNumbers: false,
		theme: options.theme === "light" ? "github-light" : "github-dark",
		lineDiffType: "word-alt",
	});
	const result = await renderer.asyncRender(file);
	const content = result.unifiedContentAST ?? [];
	const gutter = Array.isArray(result.unifiedGutterAST)
		? result.unifiedGutterAST
		: (result.unifiedGutterAST?.children ?? []);
	return content.map((lineNode, index) => {
		const lineType = lineNode.properties?.["data-line-type"];
		const { marker, ansi } = markerForLineType(lineType);
		const lineNumber = plainTextFromNode(gutter[index] ?? { type: "text", value: "" }).trim();
		const prefix = `${ansi}${marker}${lineNumber.padStart(3, " ")} ${RESET}`;
		return truncateAnsiLine(`${prefix}${textFromNode(lineNode)}`, width);
	});
}

export function isPierreDiffRendererEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_TUI_DIFF_RENDERER === "pierre" || env.PI_DIFF_RENDERER === "pierre";
}
