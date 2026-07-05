import { setKeybindings } from "@valkyriweb/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { clearAgentRecentRunsForTests, startAgentRecentRun } from "../src/core/agents/status.ts";
import type { AgentDefinition } from "../src/core/agents/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	AgentRunsSelectorComponent,
	shouldZoomAgentRunRow,
} from "../src/modes/interactive/components/agent-runs-selector.ts";
import { AgentsSelectorComponent } from "../src/modes/interactive/components/agents-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const agents: AgentDefinition[] = [
	{
		id: "scout",
		description: "Fast recon",
		prompt: "Scout prompt",
		source: "builtin",
		tools: ["read", "grep"],
		defaultContext: "slim",
	},
	{
		id: "worker",
		description: "Implementation",
		prompt: "Worker prompt",
		source: "user",
		tools: "*",
		defaultContext: "fork",
	},
];

describe("/agents selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		clearAgentRecentRunsForTests();
	});

	test("renders list and detail", () => {
		const selector = new AgentsSelectorComponent(
			agents,
			() => {},
			() => {},
		);
		const rendered = stripAnsi(selector.render(100).join("\n"));
		expect(rendered).toContain("Agents");
		expect(rendered).toContain("scout [builtin]");
		expect(rendered).toContain("Fast recon");
		expect(rendered).toContain("context: slim");
	});

	test("selecting inserts the highlighted agent scaffold through callback", () => {
		const onSelect = vi.fn();
		const selector = new AgentsSelectorComponent(agents, onSelect, () => {});
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith(agents[0]);
	});

	test("renders recent run selector and dispatches controls", () => {
		const run = startAgentRecentRun("single", [{ agent: "worker", task: "Sleep" }], { background: true });
		const onAction = vi.fn();
		const selector = new AgentRunsSelectorComponent(
			() => [run],
			onAction,
			() => {},
		);

		const rendered = stripAnsi(selector.render(100).join("\n"));
		expect(rendered).toContain("Agent Runs");
		expect(rendered).toContain("agent-1 bg running worker");
		expect(rendered).toContain("interrupt");

		selector.handleInput("i");
		expect(onAction).toHaveBeenCalledWith("interrupt", run);
	});

	test("shouldZoomAgentRunRow: only running background rows zoom (Slice B, row 3)", () => {
		const runningBg = startAgentRecentRun("z1", [{ agent: "worker", task: "Sleep" }], { background: true });
		expect(shouldZoomAgentRunRow(runningBg)).toBe(true);

		const runningFg = startAgentRecentRun("z2", [{ agent: "worker", task: "Sleep" }], { background: false });
		expect(shouldZoomAgentRunRow(runningFg)).toBe(false);

		const completedBg = { ...runningBg, status: "completed" as const };
		expect(shouldZoomAgentRunRow(completedBg)).toBe(false);
	});
});
