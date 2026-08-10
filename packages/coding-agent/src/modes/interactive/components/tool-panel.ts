import { applyBackgroundToLine, type Component, truncateToWidth } from "@valkyriweb/pi-tui";

const TOOL_PANEL_PADDING_X = 2;

type RenderCache = {
	width: number;
	backgroundSample: string;
	childLines: string[];
	lines: string[];
};

function panelLayout(width: number): { contentWidth: number; paddingX: number } {
	const paddingX = Math.min(TOOL_PANEL_PADDING_X, Math.max(0, Math.floor((width - 1) / 2)));
	return { contentWidth: Math.max(1, width - paddingX * 2), paddingX };
}

export class ToolPanel implements Component {
	private children: Component[] = [];
	private cache?: RenderCache;
	private background: (text: string) => string;

	constructor(background: (text: string) => string) {
		this.background = background;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.cache = undefined;
	}

	clear(): void {
		this.children = [];
		this.cache = undefined;
	}

	setBackground(background: (text: string) => string): void {
		this.background = background;
	}

	invalidate(): void {
		this.cache = undefined;
		for (const child of this.children) child.invalidate?.();
	}

	render(width: number): string[] {
		const { contentWidth, paddingX } = panelLayout(width);
		const childLines = this.children.flatMap((child) => child.render(contentWidth));
		const backgroundSample = this.background("test");
		if (
			this.cache?.width === width &&
			this.cache.backgroundSample === backgroundSample &&
			this.cache.childLines.length === childLines.length &&
			this.cache.childLines.every((line, index) => line === childLines[index])
		) {
			return this.cache.lines;
		}

		const sidePadding = " ".repeat(paddingX);
		const lines = childLines.map((line) => {
			const content = truncateToWidth(line, contentWidth, "");
			return applyBackgroundToLine(`${sidePadding}${content}`, width, this.background);
		});
		this.cache = { width, backgroundSample, childLines, lines };
		return lines;
	}
}
