import { Buffer } from "node:buffer";
import type { AgentTool } from "@lue-labs/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@lue-labs/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./harness.ts";

function getEntryTypes(harness: Harness): string[] {
	return harness.sessionManager.getEntries().map((entry) => entry.type);
}

interface ControlledBashInvocation {
	signal: AbortSignal | undefined;
	finish: () => void;
}

function createControlledBashOperations(invocations: ControlledBashInvocation[]): BashOperations {
	return {
		exec: async (_command, _cwd, options) => {
			return await new Promise<{ exitCode: number | null }>((resolve) => {
				invocations.push({
					signal: options.signal,
					finish: () => resolve({ exitCode: 0 }),
				});
			});
		},
	};
}

describe("AgentSession bash and persistence characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records bash results immediately while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
		expect(getEntryTypes(harness)).toContain("message");
	});

	it("defers bash results while streaming and flushes them before the next prompt", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("after flush"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const firstPrompt = harness.session.prompt("start");
		await sawToolStart;
		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		releaseToolExecution?.();
		await firstPrompt;

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);

		await harness.session.prompt("next turn");

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);
		expect(getEntryTypes(harness).filter((type) => type === "message").length).toBeGreaterThan(0);
	});

	it("defers bash results recorded during compaction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("start");

		harness.session.subscribe((event) => {
			if (event.type !== "compaction_start") return;
			expect(harness.session.isStreaming).toBe(false);
			harness.session.recordBashResult("echo hi", {
				output: "hi",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			});
		});
		await harness.session.compact().catch(() => undefined);

		expect(harness.session.hasPendingBashMessages).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		await harness.session.prompt("next turn");

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);
	});

	it("flushes bash results deferred during manual compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		harness.session.subscribe((event) => {
			if (event.type !== "compaction_start") return;
			harness.session.recordBashResult("echo hi", {
				output: "hi",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			});
		});
		await harness.session.compact();

		expect(harness.session.hasPendingBashMessages).toBe(false);
		const persisted = harness.sessionManager
			.getEntries()
			.some((entry) => entry.type === "message" && entry.message.role === "bashExecution");
		expect(persisted).toBe(true);
	});

	it("persists bash results deferred during tree navigation on the originating branch", async () => {
		let recordBash: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						recordBash?.();
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		recordBash = () =>
			harness.session.recordBashResult("echo hi", {
				output: "hi",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const firstUserEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!firstUserEntry) throw new Error("expected a user entry to navigate to");

		await harness.session.navigateTree(firstUserEntry.id);

		expect(harness.session.hasPendingBashMessages).toBe(false);
		const persisted = harness.sessionManager
			.getEntries()
			.some((entry) => entry.type === "message" && entry.message.role === "bashExecution");
		expect(persisted).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);
	});

	it("executes bash commands and records the result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.executeBash("printf 'hello'");

		expect(result.output).toContain("hello");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("cancels running bash commands with abortBash", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				return await new Promise<{ exitCode: number | null }>((_resolve, reject) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
		};

		const bashPromise = harness.session.executeBash("sleep", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isBashRunning).toBe(true);
		harness.session.abortBash();

		const result = await bashPromise;
		expect(result.cancelled).toBe(true);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("keeps newer bash execution tracked when an older execution finishes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const invocations: ControlledBashInvocation[] = [];
		const operations = createControlledBashOperations(invocations);

		const firstBash = harness.session.executeBash("first", undefined, { operations });
		const secondBash = harness.session.executeBash("second", undefined, { operations });

		invocations[0].finish();
		const firstResult = await firstBash;
		const runningAfterFirstSettles = harness.session.isBashRunning;

		harness.session.abortBash();
		const secondWasAborted = invocations[1].signal?.aborted;
		invocations[1].finish();
		const secondResult = await secondBash;

		expect(firstResult.cancelled).toBe(false);
		expect(runningAfterFirstSettles).toBe(true);
		expect(secondWasAborted).toBe(true);
		expect(secondResult.cancelled).toBe(true);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("aborts all active bash executions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const invocations: ControlledBashInvocation[] = [];
		const operations = createControlledBashOperations(invocations);

		const firstBash = harness.session.executeBash("first", undefined, { operations });
		const secondBash = harness.session.executeBash("second", undefined, { operations });

		harness.session.abortBash();
		const abortedSignals = invocations.map((invocation) => invocation.signal?.aborted);
		for (const invocation of invocations) {
			invocation.finish();
		}
		const results = await Promise.all([firstBash, secondBash]);

		expect(abortedSignals).toEqual([true, true]);
		expect(results.map((result) => result.cancelled)).toEqual([true, true]);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("persists user, assistant, toolResult, and custom messages in order", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.sendCustomMessage({
			customType: "note",
			content: "hello",
			display: true,
			details: { a: 1 },
		});
		await harness.session.prompt("start");

		const entries = harness.sessionManager.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual([
			"custom_message",
			"message",
			"message",
			"custom",
			"message",
			"message",
			"custom",
		]);
		expect(
			entries
				.filter((entry) => entry.type === "custom")
				.map((entry) => (entry.type === "custom" ? entry.customType : undefined)),
		).toEqual(["cache_health", "cache_health"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"custom",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("does not emit message_end for bash execution messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const messageEndRoles: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end") {
				messageEndRoles.push(event.message.role);
			}
		});

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(messageEndRoles).toEqual([]);
	});

	it("persists aborted assistant messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		const entries = harness.sessionManager.getEntries();
		const lastEntry = entries[entries.length - 1];
		expect(lastEntry?.type).toBe("custom");
		if (lastEntry?.type === "custom") expect(lastEntry.customType).toBe("cache_health");
		const lastMessage = [...entries].reverse().find((entry) => entry.type === "message");
		expect(lastMessage?.type).toBe("message");
		if (lastMessage?.type === "message") {
			expect(lastMessage.message.role).toBe("assistant");
			if (lastMessage.message.role === "assistant") {
				expect(lastMessage.message.stopReason).toBe("aborted");
			}
		}
	});

	it("records bash output through custom operations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello from custom ops"));
				return { exitCode: 0 };
			},
		};

		const result = await harness.session.executeBash("custom", undefined, { operations });

		expect(result.output).toContain("hello from custom ops");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("streams bash output to the callback and session events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const callbackDeltas: string[] = [];
		const eventUpdates: Array<{ id: string | undefined; delta: string }> = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "bash_execution_update") {
				eventUpdates.push({ id: event.id, delta: event.delta });
			}
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello "));
				options.onData(Buffer.from("world"));
				return { exitCode: 0 };
			},
		};

		await harness.session.executeBash("custom", (delta) => callbackDeltas.push(delta), {
			id: "bash-1",
			operations,
		});
		unsubscribe();

		expect(callbackDeltas).toEqual(["hello ", "world"]);
		expect(eventUpdates).toEqual([
			{ id: "bash-1", delta: "hello " },
			{ id: "bash-1", delta: "world" },
		]);
	});
});
