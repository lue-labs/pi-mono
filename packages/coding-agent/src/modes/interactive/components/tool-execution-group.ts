import { Container, Text } from "@lue-labs/pi-tui";
import { theme } from "../theme/theme.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

/**
 * Presentation-only container for local tool calls emitted by one assistant
 * message. Children retain their tool-call IDs; the group owns only ordering,
 * expansion, and the parallel-status header.
 */
export class ToolExecutionGroupComponent extends Container {
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly header = new Text("", 0, 0);
	private order: string[] = [];
	private expanded = false;

	addTool(component: ToolExecutionComponent): void {
		if (this.tools.has(component.getToolCallId())) return;
		this.tools.set(component.getToolCallId(), component);
		component.setExpanded(this.expanded);
		this.rebuild();
	}

	setSourceOrder(toolCallIds: readonly string[]): void {
		this.order = [...toolCallIds];
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.tools.values()) {
			tool.setExpanded(expanded);
		}
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools.values()) tool.setShowImages(show);
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools.values()) tool.setImageWidthCells(width);
	}

	dispose(): void {
		for (const tool of this.tools.values()) tool.dispose();
		this.tools.clear();
		this.order = [];
		this.clear();
	}

	private getOrderedTools(): ToolExecutionComponent[] {
		const orderedTools = this.order
			.map((toolCallId) => this.tools.get(toolCallId))
			.filter((tool): tool is ToolExecutionComponent => tool !== undefined);
		for (const tool of this.tools.values()) {
			if (!orderedTools.includes(tool)) orderedTools.push(tool);
		}
		return orderedTools;
	}

	private updateHeader(orderedTools: readonly ToolExecutionComponent[]): void {
		if (orderedTools.length <= 1) return;
		const counts = { queued: 0, running: 0, completed: 0, error: 0 };
		for (const tool of orderedTools) counts[tool.getExecutionState()]++;
		const summary = [
			counts.queued > 0 ? `${counts.queued} queued` : undefined,
			counts.running > 0 ? `${counts.running} running` : undefined,
			counts.completed > 0 ? `${counts.completed} done` : undefined,
			counts.error > 0 ? `${counts.error} failed` : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join(" · ");
		this.header.setText(theme.fg("muted", `Parallel · ${orderedTools.length} tools · ${summary}`));
	}

	private rebuild(): void {
		this.clear();
		const orderedTools = this.getOrderedTools();
		const visibleTools = orderedTools.filter((tool) => tool.isVisible());
		this.updateHeader(visibleTools);
		if (visibleTools.length > 1) this.addChild(this.header);
		for (const tool of orderedTools) this.addChild(tool);
	}

	override render(width: number): string[] {
		this.rebuild();
		return super.render(width);
	}

	override invalidate(): void {
		this.rebuild();
		super.invalidate();
	}
}
