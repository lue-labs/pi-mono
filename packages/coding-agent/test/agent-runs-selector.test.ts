import { beforeAll, describe, expect, test } from "vitest";
import type { AgentRecentRun } from "../src/core/agents/status.ts";
import type { AgentRunDetails } from "../src/core/agents/types.ts";
import {
	formatAgentRunDetailView,
	formatAgentRunRow,
	getAgentRunResumePrompt,
	normalizeAgentRunResumePrompt,
	shouldZoomAgentRunRow,
} from "../src/modes/interactive/components/agent-runs-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme(undefined, false);
});

function child(
	agent: string,
	status: AgentRunDetails["status"],
	toolNames: string[] = [],
	overrides: Partial<AgentRunDetails> = {},
): AgentRunDetails {
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
		...overrides,
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
		persistent: false,
		...overrides,
	};
}

describe("agent runs selector formatting", () => {
	// B2: nested runs are marked in the compact list row.
	test("row shows a nesting marker for depth > 0", () => {
		expect(formatAgentRunRow(run({ depth: 2, agents: ["worker"] }), false)).toContain("\u21b3L2");
		expect(formatAgentRunRow(run({ depth: 0 }), false)).not.toContain("\u21b3L");
	});

	test("row inlines the pending question text for a needs-attention run", () => {
		const blocked = run({ needsAttention: true, attentionMessage: "Should I proceed?" });
		expect(formatAgentRunRow(blocked, false)).toContain("needs attention: Should I proceed?");
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

	test("row and detail show child model and thinking", () => {
		const childRun = child("scout", "running", [], {
			model: { provider: "clawrouter", id: "gpt-5.5" },
			thinking: "medium",
		});
		const current = run({ runs: [childRun] });

		expect(formatAgentRunRow(current, false)).toContain("clawrouter/gpt-5.5 · thinking medium");
		expect(formatAgentRunDetailView(current)).toContain("scout (running) · clawrouter/gpt-5.5 · thinking medium");
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

	// Persistent single background forks park at status "interrupted" but must
	// still read as "idle" in the row text, not "interrupted" — real interrupts,
	// including persistent ones, remain needs-input.
	test("row and detail show idle, not interrupted/running, for a parked persistent run", () => {
		const parked = run({
			execution: "background",
			status: "interrupted",
			persistent: true,
			parked: true,
			resumable: true,
		});
		expect(formatAgentRunRow(parked, false)).toContain("idle");
		expect(formatAgentRunRow(parked, false)).not.toContain("interrupted");
		const detail = formatAgentRunDetailView(parked);
		expect(detail).toContain("idle");
		expect(detail).not.toContain("interrupted");
		expect(detail).not.toContain("idle running");
	});

	test("row still shows interrupted for a real interruption of a persistent run", () => {
		const blocked = run({
			execution: "background",
			status: "interrupted",
			persistent: true,
			parked: false,
			resumable: true,
		});
		expect(formatAgentRunRow(blocked, false)).toContain("interrupted");
		expect(formatAgentRunRow(blocked, false)).not.toContain("idle");
	});

	describe("shouldZoomAgentRunRow", () => {
		test("zooms into a running background run", () => {
			expect(shouldZoomAgentRunRow(run({ execution: "background", status: "running" }))).toBe(true);
		});

		test("does not zoom into a running foreground run", () => {
			expect(shouldZoomAgentRunRow(run({ execution: "foreground", status: "running" }))).toBe(false);
		});

		test("zooms into a parked persistent run that has a resumable session", () => {
			const parked = run({
				execution: "background",
				status: "interrupted",
				persistent: true,
				parked: true,
				sessionRefs: [{ agent: "explore", sessionPath: "/tmp/child.jsonl" }],
			});
			expect(shouldZoomAgentRunRow(parked)).toBe(true);
		});

		test("does not zoom into a parked persistent run with no session to reconnect", () => {
			const parked = run({
				execution: "background",
				status: "interrupted",
				persistent: true,
				parked: true,
				sessionRefs: [],
			});
			expect(shouldZoomAgentRunRow(parked)).toBe(false);
		});

		test("does not zoom into an ordinary (non-persistent) interrupted run", () => {
			const blocked = run({
				execution: "background",
				status: "interrupted",
				persistent: false,
				sessionRefs: [{ agent: "explore", sessionPath: "/tmp/child.jsonl" }],
			});
			expect(shouldZoomAgentRunRow(blocked)).toBe(false);
		});
	});

	test("resume action asks for an optional steering message", () => {
		const prompt = getAgentRunResumePrompt(run({ id: "agent-7" }));
		expect(prompt.title).toContain("agent-7");
		expect(prompt.placeholder).toContain("Steering message");
		expect(normalizeAgentRunResumePrompt("  continue with tests  ")).toBe("continue with tests");
		expect(normalizeAgentRunResumePrompt("  ")).toBeUndefined();
	});
});
