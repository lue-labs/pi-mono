import { type Context, fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { executeAgentTool } from "../../src/core/agents/executor.ts";
import { clearLiveSessionsForTests, getLiveSession } from "../../src/core/agents/live-sessions.ts";
import {
	cancelAgentRecentRun,
	clearAgentRecentRunsForTests,
	findAgentRecentRun,
	injectAgentRecentRun,
	interruptAgentRecentRun,
	resumeAgentRecentRun,
	waitForAgentRecentRun,
} from "../../src/core/agents/status.ts";
import { LocalAgentTask } from "../../src/core/tasks/local-agent-task.ts";
import { clearTaskMessagesForTests, getTaskMessages } from "../../src/core/tasks/messages.ts";
import { createHarness, type Harness } from "./harness.ts";

function executorOptions(harness: Harness, onChildSessionStart?: (session: AgentSession) => void) {
	return {
		parentServices: {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
		},
		parentActiveTools: ["read", "bash", "edit", "write", "agent"],
		parentSessionManager: harness.sessionManager,
		parentModel: harness.getModel(),
		parentThinkingLevel: "off" as const,
		onChildSessionStart,
	};
}

function deferredResponse(text: string): {
	response: (context: Context) => Promise<ReturnType<typeof fauxAssistantMessage>>;
	release: () => void;
} {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		response: async () => {
			await gate;
			return fauxAssistantMessage(text);
		},
		release,
	};
}

describe("agent member-scoped control", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		clearAgentRecentRunsForTests();
		clearLiveSessionsForTests();
		clearTaskMessagesForTests();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("steers only the selected parallel child and isolates live state", async () => {
		const first = deferredResponse("first done");
		const second = deferredResponse("second done");
		const sessions: AgentSession[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([first.response, second.response]);

		const started = await executeAgentTool(
			{
				mode: "parallel",
				background: true,
				concurrency: 2,
				tasks: [
					{ agent: "general", task: "first" },
					{ agent: "general", task: "second" },
				],
			},
			executorOptions(harness, (session) => sessions.push(session)),
		);
		const runId = started.runId!;
		await vi.waitFor(() => expect(sessions).toHaveLength(2));
		await vi.waitFor(() => expect(findAgentRecentRun(runId)?.runs).toHaveLength(2));
		const [firstMember, secondMember] = findAgentRecentRun(runId)!.runs.map((run) => run.memberId!);
		const firstSteer = vi.spyOn(sessions[0]!, "steer");
		const secondSteer = vi.spyOn(sessions[1]!, "steer");

		const result = await injectAgentRecentRun(firstMember, "inspect config.ts");

		expect(result.ok).toBe(true);
		expect(firstSteer).toHaveBeenCalledWith("inspect config.ts");
		expect(secondSteer).not.toHaveBeenCalled();
		expect(getLiveSession(firstMember)).toBe(sessions[0]);
		expect(getLiveSession(secondMember)).toBe(sessions[1]);
		expect(getLiveSession(runId)).toBeUndefined();
		expect(LocalAgentTask.snapshot(runId)?.children?.map((child) => child.controlId)).toEqual([
			firstMember,
			secondMember,
		]);
		expect(LocalAgentTask.snapshot(firstMember)?.id).toBe(firstMember);
		expect(getTaskMessages(firstMember)).toContainEqual(
			expect.objectContaining({ kind: "user_injected", text: "inspect config.ts" }),
		);
		expect(getTaskMessages(runId)).toContainEqual(
			expect.objectContaining({ kind: "user_injected", text: "inspect config.ts" }),
		);
		expect(getTaskMessages(secondMember)).not.toContainEqual(expect.objectContaining({ kind: "user_injected" }));

		first.release();
		second.release();
		await waitForAgentRecentRun(runId);
		expect(getTaskMessages(runId)).toEqual([]);
		expect(getTaskMessages(firstMember)).toEqual([]);
		expect(getTaskMessages(secondMember)).toEqual([]);
	});

	it("interrupts one parallel child without aborting its sibling", async () => {
		const first = deferredResponse("first done");
		const second = deferredResponse("second done");
		const sessions: AgentSession[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([first.response, second.response]);

		const started = await executeAgentTool(
			{
				mode: "parallel",
				background: true,
				concurrency: 2,
				tasks: [
					{ agent: "general", task: "first" },
					{ agent: "general", task: "second" },
				],
			},
			executorOptions(harness, (session) => sessions.push(session)),
		);
		const runId = started.runId!;
		await vi.waitFor(() => expect(sessions).toHaveLength(2));
		await vi.waitFor(() => expect(findAgentRecentRun(runId)?.runs).toHaveLength(2));
		const [firstMember, secondMember] = findAgentRecentRun(runId)!.runs.map((run) => run.memberId!);
		const firstAbort = vi.spyOn(sessions[0]!, "abort");
		const secondAbort = vi.spyOn(sessions[1]!, "abort");

		const interrupted = await interruptAgentRecentRun(firstMember);

		expect(interrupted.ok).toBe(true);
		expect(firstAbort).toHaveBeenCalled();
		expect(secondAbort).not.toHaveBeenCalled();
		expect(findAgentRecentRun(runId)?.status).toBe("running");
		expect(findAgentRecentRun(runId)?.runs.find((run) => run.memberId === secondMember)?.status).toBe("running");
		const unsupported = await resumeAgentRecentRun(firstMember, "continue");
		expect(unsupported.ok).toBe(false);
		expect(unsupported.message).toMatch(
			new RegExp(`^${firstMember} (?:cannot resume in this process|has no durable child session)`),
		);
		first.release();
		await vi.waitFor(() => expect(getLiveSession(firstMember)).toBeUndefined());
		const cancelledMember = await cancelAgentRecentRun(firstMember);
		expect(cancelledMember.ok).toBe(true);
		expect(cancelledMember.run?.runs.find((run) => run.memberId === firstMember)?.status).toBe("cancelled");
		expect(cancelledMember.run?.runs.find((run) => run.memberId === secondMember)?.status).toBe("running");

		second.release();
		const terminal = await waitForAgentRecentRun(runId);
		expect(terminal.runs.find((run) => run.memberId === firstMember)?.status).toBe("cancelled");
		expect(terminal.runs.find((run) => run.memberId === secondMember)?.status).toBe("completed");
	});

	it("keeps a concurrency-limited aggregate live after cancelling its started member", async () => {
		const first = deferredResponse("first done");
		const second = deferredResponse("second done");
		const sessions: AgentSession[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([first.response, second.response]);

		const started = await executeAgentTool(
			{
				mode: "parallel",
				background: true,
				concurrency: 1,
				tasks: [
					{ agent: "general", task: "first" },
					{ agent: "general", task: "second" },
				],
			},
			executorOptions(harness, (session) => sessions.push(session)),
		);
		await vi.waitFor(() => expect(findAgentRecentRun(started.runId!)?.runs).toHaveLength(1));
		const firstMember = findAgentRecentRun(started.runId!)!.runs[0]!.memberId!;

		const cancelledMember = await cancelAgentRecentRun(firstMember);
		expect(cancelledMember.ok).toBe(true);
		expect(cancelledMember.run?.status).toBe("running");
		first.release();
		await vi.waitFor(() => expect(sessions).toHaveLength(2));
		expect(findAgentRecentRun(started.runId!)?.status).toBe("running");

		const cancellingAggregate = cancelAgentRecentRun(started.runId!);
		second.release();
		const cancelled = await cancellingAggregate;
		expect(cancelled.ok).toBe(true);
		expect(cancelled.run?.status).toBe("cancelled");
	});

	it("normalizes a settled aggregate interruption when cancelled", async () => {
		const first = deferredResponse("first done");
		const second = deferredResponse("second done");
		const sessions: AgentSession[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([first.response, second.response]);

		const started = await executeAgentTool(
			{
				mode: "parallel",
				background: true,
				concurrency: 2,
				tasks: [
					{ agent: "general", task: "first" },
					{ agent: "general", task: "second" },
				],
			},
			executorOptions(harness, (session) => sessions.push(session)),
		);
		await vi.waitFor(() => expect(sessions).toHaveLength(2));
		const aborts = sessions.map((session) => vi.spyOn(session, "abort"));
		const interrupting = interruptAgentRecentRun(started.runId!);
		await vi.waitFor(() => expect(aborts.every((abort) => abort.mock.calls.length > 0)).toBe(true));
		first.release();
		second.release();
		const interrupted = await interrupting;
		expect(interrupted.run?.status).toBe("interrupted");

		const cancelled = await cancelAgentRecentRun(started.runId!);
		expect(cancelled.ok).toBe(true);
		expect(cancelled.run?.status).toBe("cancelled");
		expect(cancelled.run?.runs.map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
	});

	it("keeps aggregate cancellation as an intentional all-child operation", async () => {
		const first = deferredResponse("first done");
		const second = deferredResponse("second done");
		const sessions: AgentSession[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([first.response, second.response]);

		const started = await executeAgentTool(
			{
				mode: "parallel",
				background: true,
				concurrency: 2,
				tasks: [
					{ agent: "general", task: "first" },
					{ agent: "general", task: "second" },
				],
			},
			executorOptions(harness, (session) => sessions.push(session)),
		);
		await vi.waitFor(() => expect(sessions).toHaveLength(2));
		const aborts = sessions.map((session) => vi.spyOn(session, "abort"));

		const cancelling = cancelAgentRecentRun(started.runId!);
		await vi.waitFor(() => expect(aborts.every((abort) => abort.mock.calls.length > 0)).toBe(true));
		first.release();
		second.release();
		const cancelled = await cancelling;

		expect(cancelled.ok).toBe(true);
		expect(cancelled.run?.runs.map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
	});

	it("projects explicit needs-input output without changing lifecycle truth", async () => {
		const sessions: AgentSession[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("needs input: Which environment should I use?")]);

		const started = await executeAgentTool(
			{ mode: "single", background: true, tasks: [{ agent: "general", task: "choose environment" }] },
			executorOptions(harness, (session) => sessions.push(session)),
		);
		const terminal = await waitForAgentRecentRun(started.runId!);
		const snapshot = LocalAgentTask.snapshot(terminal.id);

		expect(terminal.status).toBe("interrupted");
		expect(terminal.attentionReason).toBe("user_input");
		expect(snapshot).toMatchObject({
			status: "interrupted",
			needsInput: true,
			attentionReason: "user_input",
			attentionMessage: "Which environment should I use?",
		});

		const memberId = terminal.runs[0]!.memberId!;
		const resumed = deferredResponse("Using staging; task complete");
		harness.appendResponses([resumed.response]);
		const answered = await LocalAgentTask.injectMessage?.(memberId, "Use staging");
		expect(answered?.ok).toBe(true);
		await vi.waitFor(() => expect(sessions).toHaveLength(2));
		const priorSteer = vi.spyOn(sessions[0]!, "steer");
		const resumedSteer = vi.spyOn(sessions[1]!, "steer");
		const steered = await LocalAgentTask.injectMessage?.(memberId, "Also preserve audit logs");
		expect(steered?.ok).toBe(true);
		expect(priorSteer).not.toHaveBeenCalled();
		expect(resumedSteer).toHaveBeenCalledWith("Also preserve audit logs");
		resumed.release();
		const continued = await waitForAgentRecentRun(terminal.id);
		expect(continued.status).toBe("completed");
		expect(continued.runs[0]?.memberId).toBe(memberId);
		expect(continued.runs[0]?.sessionPath).toBe(terminal.runs[0]?.sessionPath);
		expect(getTaskMessages(memberId)).toEqual([]);
	});

	it("ignores quoted and fenced needs-input examples", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				"> needs input: quoted example\n````text\n~~~\nneeds input: mixed fenced example\n````\nTask complete",
			),
		]);

		const started = await executeAgentTool(
			{ mode: "single", background: true, tasks: [{ agent: "general", task: "document protocol" }] },
			executorOptions(harness),
		);
		const terminal = await waitForAgentRecentRun(started.runId!);

		expect(terminal.status).toBe("completed");
		expect(terminal.attentionReason).toBeUndefined();
		expect(terminal.needsAttention).toBe(false);
	});
});
