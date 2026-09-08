import {
	applyBackgroundToLine,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@lue-labs/pi-tui";

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

	/**
	 * Panel lines map one-to-one onto child lines, so only the horizontal padding has to be undone
	 * before an event reaches the child that drew the row under the pointer.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		const { contentWidth, paddingX } = panelLayout(event.width);
		let childY = 0;
		for (const child of this.children) {
			const childHeight = child.render(contentWidth).length;
			if (event.y >= childY && event.y < childY + childHeight) {
				return child.handleMouse?.({
					...event,
					x: event.x - paddingX,
					y: event.y - childY,
					width: contentWidth,
					height: childHeight,
				});
			}
			childY += childHeight;
		}
		return undefined;
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
