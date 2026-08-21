import { Container, getKeybindings, Spacer, Text } from "@lue-labs/pi-tui";
import type { AgentDefinition } from "../../../core/agents/types.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export class AgentsSelectorComponent extends Container {
	private readonly agents: AgentDefinition[];
	private readonly onSelect: (agent: AgentDefinition) => void;
	private readonly onCancel: () => void;
	private selectedIndex = 0;
	private readonly listContainer = new Container();
	private readonly detailText = new Text("", 1, 0);

	constructor(agents: AgentDefinition[], onSelect: (agent: AgentDefinition) => void, onCancel: () => void) {
		super();
		this.agents = agents;
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Agents")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.detailText);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "insert scaffold") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.update();
	}

	private selectedAgent(): AgentDefinition | undefined {
		return this.agents[this.selectedIndex];
	}

	private update(): void {
		this.listContainer.clear();
		if (this.agents.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No agents found"), 1, 0));
			this.detailText.setText("");
			return;
		}
		for (let index = 0; index < this.agents.length; index++) {
			const agent = this.agents[index];
			const source = theme.fg("muted", ` [${agent.source}]`);
			const row =
				index === this.selectedIndex
					? `${theme.fg("accent", "→ ")}${theme.fg("accent", agent.id)}${source}`
					: `  ${theme.fg("text", agent.id)}${source}`;
			this.listContainer.addChild(new Text(row, 1, 0));
		}
		const selected = this.selectedAgent();
		this.detailText.setText(
			selected
				? `${theme.fg("accent", selected.id)}: ${selected.description}\ncontext: ${selected.defaultContext ?? "default"}  tools: ${Array.isArray(selected.tools) ? selected.tools.join(", ") : (selected.tools ?? "*")}`
				: "",
		);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.update();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.agents.length - 1, this.selectedIndex + 1);
			this.update();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.selectedAgent();
			if (selected) this.onSelect(selected);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}
}
