import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@valkyriweb/pi-ai";
import { fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentRecentRunsForTests } from "../../../src/core/agents/status.ts";
import { deleteExtensionProcessServiceForTests } from "../../../src/core/extensions/loader.ts";
import { AGENTS_ENGINE_SERVICE_ID, type AgentEngine, type AgentHandle, type ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

interface CapturedFork {
	handle?: AgentHandle;
	sessionId?: string;
	error?: unknown;
	beforeAgentStartCount: number;
	parentSystemPrompts: string[];
}

function newCaptured(): CapturedFork {
	return { beforeAgentStartCount: 0, parentSystemPrompts: [] };
}

interface ContextRecord {
	contexts: Context[];
}

/**
 * Recording response factory. Logs the context (used to inspect systemPrompt /
 * tools / messages from the test) and returns a static assistant reply so
 * agent loops terminate cleanly.
 */
function recordingFactory(record: ContextRecord, label: string) {
	return (context: Context) => {
		record.contexts.push(context);
		return fauxAssistantMessage(`${label}:${record.contexts.length}`);
	};
}

/**
 * Determine whether a context belongs to a forked child agent. Child agents
 * are driven via `buildChildTaskPrompt`, which prefixes the child user message
 * with `Complete this delegated task:`. That marker is stable and survives
 * the parent transcript prefix that fork mode copies in.
 */
function isChildContext(ctx: Context): boolean {
	for (let i = ctx.messages.length - 1; i >= 0; i--) {
		const message = ctx.messages[i];
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part): part is { type: "text"; text: string } => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		return text.includes("Complete this delegated task:");
	}
	return false;
}

function makeAgentServices(harness: Harness): void {
	// Inject agent tool services into the existing harness session. The harness
	// constructs AgentSession without them, but the runner binding reads them
	// lazily via `this._agentToolServices`, so a post-construction patch is
	// safe and avoids changing harness.ts shape for this test alone.
	const internal = harness.session as unknown as {
		_agentToolServices?: {
			cwd: string;
			agentDir: string;
			authStorage: typeof harness.authStorage;
			settingsManager: typeof harness.settingsManager;
			modelRegistry: typeof harness.session.modelRegistry;
		};
	};
	internal._agentToolServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		authStorage: harness.authStorage,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
	};
}

function forkExtensionFactory(
	captured: CapturedFork,
	options: {
		allowedTools?: string[];
		abortImmediately?: boolean;
		context?: "fork" | "slim" | "none";
		forkEveryTurn?: boolean;
		metadata?: Record<string, unknown>;
		cwd?: string;
		agentType?: string;
		persistent?: boolean;
	} = {},
) {
	const handles: AgentHandle[] = [];
	const factory = (pi: ExtensionAPI) => {
		pi.on("before_agent_start", async (_event, ctx) => {
			captured.beforeAgentStartCount += 1;
			if (!options.forkEveryTurn && captured.beforeAgentStartCount > 1) return;
			captured.parentSystemPrompts.push(ctx.getSystemPrompt());
			try {
				const controller = options.abortImmediately ? new AbortController() : undefined;
				const result = await ctx.forkAgent({
					prompt: `child task ${captured.beforeAgentStartCount}`,
					description: "fork-agent test",
					...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
					...(options.context ? { context: options.context } : {}),
					...(options.agentType ? { agentType: options.agentType } : {}),
					...(options.persistent ? { persistent: options.persistent } : {}),
					...(options.metadata ? { metadata: options.metadata } : {}),
					...(options.cwd ? { cwd: options.cwd } : {}),
					...(controller ? { signal: controller.signal } : {}),
				});
				captured.handle = result.handle;
				captured.sessionId = result.sessionId;
				handles.push(result.handle);
				controller?.abort();
			} catch (err) {
				captured.error = err;
			}
		});
	};
	return { factory, handles };
}

describe("ctx.forkAgent", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		clearAgentRecentRunsForTests();
		deleteExtensionProcessServiceForTests(AGENTS_ENGINE_SERVICE_ID);
	});

	it("returns a handle that completes in the background and exposes a session id", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory } = forkExtensionFactory(captured);
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("kick off");

		expect(captured.error).toBeUndefined();
		expect(captured.handle).toBeDefined();
		expect(typeof captured.sessionId).toBe("string");
		expect(captured.sessionId).not.toBe("");
		const handle = captured.handle!;
		expect(["running", "completed"]).toContain(handle.status);
		const details = await handle.wait();
		expect(details.status).toBe("completed");
		expect(details.runs[0]?.status).toBe("completed");
		// The child made an LLM call; the parent effective prompt is captured from
		// the extension context because background child execution can consume the
		// harness provider path before the parent turn records its own context.
		expect(record.contexts.length).toBeGreaterThanOrEqual(1);
		expect(record.contexts.some(isChildContext)).toBe(true);
		expect(captured.parentSystemPrompts.length).toBe(1);
	});

	it("routes forkAgent({ agentType }) through the named agent definition", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		// context:"none" + a stable-profile agent (explore) => the executor applies
		// the agent's own stable system append instead of an inherited/auto prompt.
		const { factory } = forkExtensionFactory(captured, { agentType: "explore", context: "none" });
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("kick off");

		expect(captured.error).toBeUndefined();
		const details = await captured.handle!.wait();
		expect(details.status).toBe("completed");
		const child = record.contexts.find(isChildContext);
		expect(child).toBeDefined();
		// Proves agentType reached the executor's agent resolver: the explore
		// definition's stable child-agent append ("Agent: explore") is in the
		// child's system prompt, not the default general child prompt.
		expect(child?.systemPrompt).toContain("Agent: explore");
	});

	it("forwards forkAgent({ metadata }) through the fork path without breaking the child run", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory } = forkExtensionFactory(captured, { metadata: { structuredOutputCallId: "call-xyz" } });
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("kick off");

		expect(captured.error).toBeUndefined();
		const details = await captured.handle!.wait();
		expect(details.status).toBe("completed");
		expect(details.runs[0]?.status).toBe("completed");
		expect(record.contexts.some(isChildContext)).toBe(true);
	});

	it("forwards forkAgent({ cwd }) through the fork path without breaking the child run", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const overrideCwd = mkdtempSync(join(tmpdir(), "forkcwd-"));
		const cwdSlug = overrideCwd.split("/").pop()!; // survives session-path slugification
		const { factory } = forkExtensionFactory(captured, { cwd: overrideCwd });
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("kick off");

		expect(captured.error).toBeUndefined();
		const details = await captured.handle!.wait();
		expect(details.status).toBe("completed");
		expect(details.runs[0]?.status).toBe("completed");
		// The child session is namespaced under the overridden cwd (session paths
		// slugify the cwd), proving forkAgent({ cwd }) reached the child services.
		expect(details.runs[0]?.sessionPath ?? "").toContain(cwdSlug);
		expect(record.contexts.some(isChildContext)).toBe(true);
	});

	it("inherits the parent's frozen system prompt for cache preservation across forks", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory, handles } = forkExtensionFactory(captured, { forkEveryTurn: true });
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		// 4 responses: 2 parent turns + 2 child forks.
		harness.setResponses([
			recordingFactory(record, "msg"),
			recordingFactory(record, "msg"),
			recordingFactory(record, "msg"),
			recordingFactory(record, "msg"),
		]);

		await harness.session.prompt("turn one");
		await handles[0]?.wait();
		await harness.session.prompt("turn two");
		await handles[1]?.wait();

		const childPrompts: string[] = [];
		for (const ctx of record.contexts) {
			if (isChildContext(ctx)) childPrompts.push(ctx.systemPrompt ?? "");
		}
		const parentPrompts = captured.parentSystemPrompts;

		expect(childPrompts.length).toBe(2);
		expect(parentPrompts.length).toBe(2);
		// Cache invariant: in fork mode, the child's first LLM call carries the
		// parent's frozen system prompt bytes 1:1 — same string the parent used
		// on its own call in that turn.
		expect(childPrompts[0]).toBe(parentPrompts[0]);
		// And both child forks see byte-identical bytes across turns, which is
		// what makes pi-memory v2 caching repeatable.
		expect(childPrompts[0]).toBe(childPrompts[1]);
	});

	it("forkAgent inherits system prompt rewrites from earlier before_agent_start handlers", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const rewrite = (pi: ExtensionAPI) => {
			pi.on("before_agent_start", (event) => ({
				systemPrompt: `${event.systemPrompt}\n\nRewrite marker for fork.`,
			}));
		};
		const { factory, handles } = forkExtensionFactory(captured);
		const harness = await createHarness({ extensionFactories: [rewrite, factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("turn one");
		await handles[0]?.wait();

		const parentSystemPrompt = captured.parentSystemPrompts[0];
		const child = record.contexts.find(isChildContext);
		expect(parentSystemPrompt).toContain("Rewrite marker for fork.");
		expect(child?.systemPrompt).toBe(parentSystemPrompt);
	});

	it("forkAgent preserves slim context semantics after system prompt rewrites", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const rewrite = (pi: ExtensionAPI) => {
			pi.on("before_agent_start", (event) => ({
				systemPrompt: `${event.systemPrompt}\n\nRewrite marker for fork.`,
			}));
		};
		const { factory, handles } = forkExtensionFactory(captured, { context: "slim" });
		const harness = await createHarness({ extensionFactories: [rewrite, factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("turn one");
		await handles[0]?.wait();

		const parentSystemPrompt = captured.parentSystemPrompts[0];
		const child = record.contexts.find(isChildContext);
		expect(parentSystemPrompt).toContain("Rewrite marker for fork.");
		expect(child?.systemPrompt).not.toBe(parentSystemPrompt);
		expect(child?.systemPrompt).not.toContain("Rewrite marker for fork.");
	});

	it("forkAgent prefers a process-scoped engine override installed from a handler", async () => {
		const captured = newCaptured();
		const factory = (pi: ExtensionAPI) => {
			pi.on("before_agent_start", async (_event, ctx) => {
				const engine: AgentEngine = {
					snapshot() {
						throw new Error("snapshot() is not exercised by this fork-override test");
					},
					async run() {
						return { mode: "single", status: "completed", runs: [], background: false };
					},
					async control() {
						return undefined;
					},
					async fork() {
						return {
							sessionId: "process-engine",
							handle: {
								status: "completed",
								async wait() {
									return {
										mode: "single",
										status: "completed",
										runs: [],
										background: true,
										runId: "process-engine",
									};
								},
								async abort() {},
								async resume() {},
								async inject() {},
							},
						};
					},
				};
				pi.harness.provide(AGENTS_ENGINE_SERVICE_ID, engine, { scope: "process", replace: true });
				const result = await ctx.forkAgent({ prompt: "child task" });
				captured.sessionId = result.sessionId;
				captured.handle = result.handle;
			});
		};
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([fauxAssistantMessage("parent")]);

		await harness.session.prompt("turn one");

		expect(captured.sessionId).toBe("process-engine");
		expect(captured.handle?.status).toBe("completed");
	});

	// Uses "Bash" (still core after PR #1C) rather than "Read" (now provided by
	// my-pi/extensions/native-tool-aliases). Test-harness child sessions create a
	// fresh DefaultResourceLoader that doesn't inherit the parent's in-memory
	// extensionFactories, so extension-provided tools don't propagate to child API
	// calls. Production isn't affected: child loaders discover on-disk extensions
	// the same way the parent does. See docs/tool-inventory-2026-05-23.md PR #1C.
	it("intersects allowedTools with the parent's active tool list", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory } = forkExtensionFactory(captured, { allowedTools: ["Bash"] });
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("go");
		const details = await captured.handle!.wait();
		expect(details.runs[0]?.effectiveTools).toEqual(["Bash"]);

		const childContext = record.contexts.find(isChildContext);
		const childToolNames = (childContext?.tools ?? []).map((tool) => tool.name);
		expect(childToolNames).toEqual(["Bash"]);
	});

	it("aborts the run within ~1s when the caller signals", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory } = forkExtensionFactory(captured, { abortImmediately: true });
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		// Provide one quick parent response. The child may or may not get a
		// chance to send its own request before abort lands; the queue tolerates
		// extra unused responses.
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("go");

		const start = Date.now();
		const details = await Promise.race([
			captured.handle!.wait(),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error(`abort did not land within 2s (status=${captured.handle?.status})`)),
					2000,
				),
			),
		]);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(2000);
		expect(["cancelled", "interrupted"]).toContain(details.status);
		expect(captured.handle!.status).toBe(details.status);
	});

	// Regression: a settings.subagents provider model pin (the cheap model used for
	// explore/general fan-out) must NOT apply to a context:"fork" fork. A 1:1 fork
	// only reuses the parent's warm prompt cache when it runs on the parent's exact
	// model + thinking level; the pin used to override the omitted model and silently
	// downgrade every fork (pi-memory extraction, pi-recap, fusion, suggested-tasks),
	// cold-writing the whole inherited prefix on each run.
	it("fork mode inherits the parent model + thinking, bypassing a settings.subagents provider pin", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory } = forkExtensionFactory(captured); // default context:"fork"
		const harness = await createHarness({
			extensionFactories: [factory],
			provider: "anthropic",
			models: [
				{ id: "parent-model", name: "Parent", reasoning: true },
				{ id: "pinned-cheap-model", name: "Pinned", reasoning: true },
			],
			settings: {
				subagents: {
					providers: { anthropic: { model: "anthropic/pinned-cheap-model", thinking: "low" } },
				},
			},
		});
		harnesses.push(harness);
		makeAgentServices(harness);
		// Parent runs on parent-model at a thinking level distinct from the pin's "low".
		harness.session.setThinkingLevel("high");
		const parentThinking = harness.session.thinkingLevel;
		expect(parentThinking).not.toBe("low"); // setup sanity: pin thinking must differ
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("kick off");

		expect(captured.error).toBeUndefined();
		const details = await captured.handle!.wait();
		expect(details.status).toBe("completed");
		// The fork ran on the PARENT model + thinking (cache-identity), not the pin.
		expect(details.runs[0]?.model?.id).toBe("parent-model");
		expect(details.runs[0]?.thinking).toBe(parentThinking);
	});

	// Guard the cost optimization the fix must not regress: non-fork delegations
	// (default/slim/none context) still take the cheap subagents pin.
	it('non-fork delegation (context:"none") still honors the settings.subagents provider pin', async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory } = forkExtensionFactory(captured, { context: "none" });
		const harness = await createHarness({
			extensionFactories: [factory],
			provider: "anthropic",
			models: [
				{ id: "parent-model", name: "Parent", reasoning: true },
				{ id: "pinned-cheap-model", name: "Pinned", reasoning: true },
			],
			settings: {
				subagents: {
					providers: { anthropic: { model: "anthropic/pinned-cheap-model", thinking: "low" } },
				},
			},
		});
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.session.setThinkingLevel("high"); // parent differs from the pin on purpose
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("kick off");

		expect(captured.error).toBeUndefined();
		const details = await captured.handle!.wait();
		expect(details.status).toBe("completed");
		// Non-fork: model + thinking come from the subagents pin, not the parent.
		expect(details.runs[0]?.model?.id).toBe("pinned-cheap-model");
		expect(details.runs[0]?.thinking).toBe("low");
	});

	// ── persistent forks (long-lived, launcher-fed) ──────────────────────────────

	it("persistent fork parks as resumable (interrupted) after its turn instead of terminating", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory } = forkExtensionFactory(captured, { persistent: true });
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("kick off");
		const handle = captured.handle!;
		const details = await handle.wait();
		// Parked, not terminated: interrupted status keeps the controller alive and
		// the session resumable so the launcher can feed the next turn.
		expect(details.status).toBe("interrupted");
		expect(details.parked).toBe(true);
		expect(details.resumable).toBe(true);
		expect(handle.status).toBe("interrupted");
	});

	it("resume feeds a new turn into a persistent fork's SAME session, preserving history", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory } = forkExtensionFactory(captured, { persistent: true });
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([
			recordingFactory(record, "msg"),
			recordingFactory(record, "msg"),
			recordingFactory(record, "msg"),
			recordingFactory(record, "msg"),
		]);

		await harness.session.prompt("kick off");
		const handle = captured.handle!;
		await handle.wait(); // turn 1 parked
		const before = record.contexts.length;

		await handle.resume("resumed-digest-42");
		const details = await handle.wait(); // turn 2 parked again
		expect(details.status).toBe("interrupted");
		expect(record.contexts.length).toBeGreaterThan(before);
		// The resumed turn ran in the SAME session: its context carries BOTH the
		// original delegated task AND the resume prompt — history was preserved.
		const resumed = record.contexts.find((ctx) => {
			const text = JSON.stringify(ctx.messages);
			return text.includes("resumed-digest-42") && text.includes("child task 1");
		});
		expect(resumed).toBeDefined();
	});

	it("inject rejects when a persistent fork is parked (no active child session)", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory } = forkExtensionFactory(captured, { persistent: true });
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("kick off");
		const handle = captured.handle!;
		await handle.wait(); // parked — no active session to steer
		await expect(handle.inject("late steer")).rejects.toThrow();
	});

	it("abort terminally retires a persistent fork", async () => {
		const captured = newCaptured();
		const record: ContextRecord = { contexts: [] };
		const { factory } = forkExtensionFactory(captured, { persistent: true });
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		makeAgentServices(harness);
		harness.setResponses([recordingFactory(record, "msg"), recordingFactory(record, "msg")]);

		await harness.session.prompt("kick off");
		const handle = captured.handle!;
		await handle.wait(); // parked (interrupted, resumable)
		await handle.abort();
		expect(handle.status).toBe("cancelled");
	});
});
