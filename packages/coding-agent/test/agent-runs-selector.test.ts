import { beforeAll, describe, expect, test } from "vitest";
import type { AgentRecentRun } from "../src/core/agents/status.ts";
import type { AgentRunDetails } from "../src/core/agents/types.ts";
import {
	formatAgentRunDetailView,
	formatAgentRunRow,
} from "../src/modes/interactive/components/agent-runs-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme(undefined, false);
});

function child(agent: string, status: AgentRunDetails["status"], toolNames: string[] = []): AgentRunDetails {
	return {
		agent,
		source: "builtin",
		task: "t",
		status,
		context: {
			mode: "default",
			includeTranscript: false,
			includeProjectContext: true,
			includeSkills: true,
			includeAppendSystemPrompt: true,
		},
		effectiveTools: ["read"],
		deniedTools: [],
		durationMs: 1,
		toolCallCount: toolNames.length,
		messageCount: 1,
		recentToolCalls: toolNames.map((name, index) => ({
			name,
			argsPreview: `arg-${index}`,
			startedAt: 1,
			endedAt: 2,
			resultPreview: `${name} result ${index}`,
		})),
		recentOutputSnippets: [],
		loadedSkills: [],
		invokedSkills: { count: 0, names: [] },
	};
}

function run(overrides: Partial<AgentRecentRun> = {}): AgentRecentRun {
	return {
		id: "agent-1",
		depth: 0,
		mode: "single",
		execution: "foreground",
		status: "running",
		agents: ["scout"],
		tasks: ["t"],
		startedAt: "now",
		updatedAt: "now",
		outputPaths: [],
		sessionRefs: [],
		runs: [],
		resumable: false,
		needsAttention: false,
		...overrides,
	};
}

describe("agent runs selector formatting", () => {
	// B2: nested runs are marked in the compact list row.
	test("row shows a nesting marker for depth > 0", () => {
		expect(formatAgentRunRow(run({ depth: 2, agents: ["worker"] }), false)).toContain("\u21b3L2");
		expect(formatAgentRunRow(run({ depth: 0 }), false)).not.toContain("\u21b3L");
	});

	// B4: fan-out done/total appears once a run has more than one requested task.
	test("row shows fan-out done/total across child runs", () => {
		const fanned = run({
			mode: "parallel",
			tasks: ["a", "b", "c"],
			runs: [child("a", "completed"), child("b", "completed"), child("c", "running")],
		});
		expect(formatAgentRunRow(fanned, false)).toContain("[2/3]");
		// A single-task run has no fan-out indicator (regex avoids matching ANSI "[").
		expect(formatAgentRunRow(run({ tasks: ["t"], runs: [child("a", "running")] }), false)).not.toMatch(
			/\[\d+\/\d+\]/,
		);
	});

	// B4 regression: the denominator is the requested task count, not observed
	// child details. A parallel run with 3 requested tasks but only 1 child started
	// (others still queued past the concurrency limit) must read [1/3], never [1/1].
	test("fan-out total counts requested tasks, not just started children", () => {
		const queued = run({
			mode: "parallel",
			tasks: ["a", "b", "c"],
			runs: [child("a", "completed")],
		});
		expect(formatAgentRunRow(queued, false)).toContain("[1/3]");
	});

	// B2 + C1: the detail view names the parent and inlines each child's tool
	// calls *with their results* (CC 2.1.178), not just tool names.
	test("detail shows nesting, parent, and an inline tool-result transcript", () => {
		const detail = formatAgentRunDetailView(
			run({
				id: "agent-7",
				depth: 3,
				parentRunId: "agent-2",
				runs: [child("scout", "running", ["read", "grep"])],
			}),
		);
		expect(detail).toContain("nested: depth 3 (parent agent-2)");
		expect(detail).toContain("read");
		expect(detail).toContain("\u2192 read result 0");
		expect(detail).toContain("grep");
	});

	test("empty selection renders a placeholder", () => {
		expect(formatAgentRunDetailView(undefined)).toContain("No native agent runs yet");
	});
});
