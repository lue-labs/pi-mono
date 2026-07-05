import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "@valkyriweb/pi-tui";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { readSessionAwaitingInput } from "../../src/core/session-awaiting-input.ts";
import {
	type BuildInterfaceInput,
	buildInterfaceSchema,
	createBuildInterfaceToolDefinition,
	dispatchBuildInterface,
	executeBuildInterface,
} from "../../src/core/tools/build-interface.ts";
import { LAYOUT_GRAPH_VERSION, layoutGraphSchema, nodeSchema } from "../../src/core/tools/layout-graph.ts";
import {
	createLLMHarness,
	type ExampleQuestionsData,
	exampleQuestionsHarness,
	exampleQuestionsInputId,
	recordingHarness,
	staticHarness,
} from "../../src/core/tools/ui-harness.ts";

const minimalGraph = {
	version: LAYOUT_GRAPH_VERSION,
	root: { type: "text" as const, value: "hello" },
};

describe("buildInterfaceSchema", () => {
	it("accepts a minimal call with intent + data, no responseShape", () => {
		const input: BuildInterfaceInput = { intent: "show greeting", data: {} };
		expect(Check(buildInterfaceSchema, input)).toBe(true);
	});

	it("accepts a call with responseShape", () => {
		const input: BuildInterfaceInput = {
			intent: "ask name",
			data: { prompt: "Your name?" },
			responseShape: { type: "object", properties: { name: { type: "string" } } },
		};
		expect(Check(buildInterfaceSchema, input)).toBe(true);
	});

	it("rejects calls missing intent", () => {
		expect(Check(buildInterfaceSchema, { data: {} })).toBe(false);
	});

	it("rejects calls missing data", () => {
		expect(Check(buildInterfaceSchema, { intent: "x" })).toBe(false);
	});
});

describe("dispatchBuildInterface", () => {
	it("returns the harness's graph verbatim", async () => {
		const graph = await dispatchBuildInterface({ intent: "i", data: {} }, staticHarness(minimalGraph));
		expect(graph).toBe(minimalGraph);
	});

	it("passes the input through to the harness", async () => {
		const harness = recordingHarness(minimalGraph);
		const input: BuildInterfaceInput = {
			intent: "ask retry strategy",
			data: { foo: 1 },
			responseShape: { type: "object" },
		};
		await dispatchBuildInterface(input, harness);
		expect(harness.calls).toHaveLength(1);
		expect(harness.calls[0]).toEqual(input);
	});

	it("propagates harness errors", async () => {
		const failing = async () => {
			throw new Error("harness boom");
		};
		await expect(dispatchBuildInterface({ intent: "i", data: {} }, failing)).rejects.toThrow("harness boom");
	});

	it("passes abort signals to LLM harness calls", async () => {
		const signal = AbortSignal.abort();
		let receivedSignal: AbortSignal | undefined;
		const harness = createLLMHarness({
			call: async ({ signal }) => {
				receivedSignal = signal;
				return JSON.stringify(minimalGraph);
			},
		});
		await dispatchBuildInterface({ intent: "i", data: {} }, harness, { signal });
		expect(receivedSignal).toBe(signal);
	});
});

describe("layoutGraphSchema", () => {
	it("rejects empty option groups", () => {
		expect(
			Check(layoutGraphSchema, {
				version: LAYOUT_GRAPH_VERSION,
				root: { type: "radio_group", id: "choice", options: [] },
			}),
		).toBe(false);
	});

	it("rejects empty tab sets", () => {
		expect(
			Check(layoutGraphSchema, {
				version: LAYOUT_GRAPH_VERSION,
				root: { type: "tabs", tabs: [] },
			}),
		).toBe(false);
	});
});

describe("exampleQuestionsHarness", () => {
	const sample: ExampleQuestionsData = {
		questions: [
			{
				header: "Strategy",
				question: "Which retry strategy should we use?",
				multiSelect: false,
				options: [
					{
						label: "Exponential backoff (Recommended)",
						description: "2^n with jitter",
					},
					{ label: "Fixed interval", description: "Retry every 5s" },
					{ label: "No retry", description: "Fail fast on first error" },
				],
			},
		],
	};

	it("produces a graph the renderer schema accepts", async () => {
		const graph = await exampleQuestionsHarness({
			intent: "ask retry strategy",
			data: sample,
		});
		expect(graph.version).toBe(LAYOUT_GRAPH_VERSION);
		expect(Check(nodeSchema, graph.root)).toBe(true);
	});

	it("collapses a single-question input into a card root", async () => {
		const graph = await exampleQuestionsHarness({ intent: "x", data: sample });
		expect(graph.root.type).toBe("card");
		if (graph.root.type !== "card") throw new Error("expected card root");
		expect(graph.root.children).toHaveLength(2);
		const [questionNode, groupNode] = graph.root.children;
		expect(questionNode?.type).toBe("text");
		expect(groupNode?.type).toBe("radio_group");
		if (groupNode?.type !== "radio_group") throw new Error("expected radio_group");
		expect(groupNode.id).toBe(exampleQuestionsInputId(0));
		expect(groupNode.options).toHaveLength(3);
	});

	it("wraps multiple questions in tabs and picks checkbox_group for multiSelect", async () => {
		const multi: ExampleQuestionsData = {
			questions: [
				{
					header: "Lang",
					question: "Language?",
					multiSelect: false,
					options: [
						{ label: "TS", description: "" },
						{ label: "Rust", description: "" },
					],
				},
				{
					header: "Targets",
					question: "Targets?",
					multiSelect: true,
					options: [
						{ label: "macOS", description: "" },
						{ label: "Linux", description: "" },
					],
				},
			],
		};
		const graph = await exampleQuestionsHarness({ intent: "x", data: multi });
		expect(graph.root.type).toBe("tabs");
		if (graph.root.type !== "tabs") throw new Error("expected tabs root");
		expect(graph.root.tabs).toHaveLength(2);

		const secondCard = graph.root.tabs[1]!.content;
		if (secondCard.type !== "card") throw new Error("expected card");
		const groupNode = secondCard.children[1];
		expect(groupNode?.type).toBe("checkbox_group");
	});

	it("rejects malformed data", async () => {
		await expect(exampleQuestionsHarness({ intent: "x", data: {} })).rejects.toThrow(/must be \{ questions/);
	});

	it("is deterministic when used through dispatch", async () => {
		const input: BuildInterfaceInput = { intent: "x", data: sample };
		const g1 = await dispatchBuildInterface(input, exampleQuestionsHarness);
		const g2 = await dispatchBuildInterface(input, exampleQuestionsHarness);
		expect(JSON.stringify(g1)).toBe(JSON.stringify(g2));
	});
});

// ---------------------------------------------------------------------------
// executeBuildInterface (the tool body) — exercised with a mocked
// ExtensionContext whose custom() drives the renderer programmatically.
// ---------------------------------------------------------------------------

/**
 * Build a fake ExtensionContext that implements only ctx.hasUI + ctx.ui.custom.
 * The harness gets a chance to drive the returned LayoutRenderer via the
 * `drive` callback: the test asserts what's mounted, calls handleInput, then
 * the tool resolves.
 */
function mockUIContext(drive: (component: Component) => void): ExtensionContext {
	const ui = {
		async custom<T>(
			factory: (
				tui: unknown,
				theme: unknown,
				kb: unknown,
				done: (result: T) => void,
			) => Component | Promise<Component>,
		): Promise<T> {
			return new Promise<T>((resolve) => {
				const component = factory(null, null, null, resolve);
				Promise.resolve(component).then((c) => drive(c));
			});
		},
	} as any;
	return { hasUI: true, ui } as unknown as ExtensionContext;
}

describe("executeBuildInterface", () => {
	const questionsInput: BuildInterfaceInput = {
		intent: "ask retry strategy",
		data: {
			questions: [
				{
					header: "Strategy",
					question: "Which retry strategy?",
					multiSelect: false,
					options: [
						{ label: "Exponential backoff", description: "2^n" },
						{ label: "Fixed interval", description: "every 5s" },
					],
				},
			],
		},
	};

	it("runs harness → renderer → response and returns the user's choice", async () => {
		const ctx = mockUIContext((component) => {
			// Component is a LayoutRenderer — exercise its public input contract.
			// Move cursor to second option, then submit.
			component.handleInput?.("\x1b[B"); // down
			component.handleInput?.("\r"); // enter
		});

		const result = await executeBuildInterface(questionsInput, exampleQuestionsHarness, ctx);
		expect(result.details.outcome.status).toBe("submitted");
		if (result.details.outcome.status !== "submitted") throw new Error();
		expect(result.details.outcome.response).toEqual({ q0: "0-1" });
		expect(result.content[0]?.text).toBe(JSON.stringify({ q0: "0-1" }));
	});

	it("surfaces cancellation as a text message to the model", async () => {
		const ctx = mockUIContext((component) => {
			component.handleInput?.("\x1b"); // esc
		});
		const result = await executeBuildInterface(questionsInput, exampleQuestionsHarness, ctx);
		expect(result.details.outcome.status).toBe("cancelled");
		expect(result.content[0]?.text).toMatch(/cancelled/i);
	});

	it("throws when no UI is available (print/RPC mode)", async () => {
		const ctx = { hasUI: false } as unknown as ExtensionContext;
		await expect(executeBuildInterface(questionsInput, exampleQuestionsHarness, ctx)).rejects.toThrow(
			/requires an interactive UI/,
		);
	});

	it("respects a pre-aborted signal", async () => {
		const ctx = mockUIContext(() => {});
		const signal = AbortSignal.abort();
		await expect(executeBuildInterface(questionsInput, exampleQuestionsHarness, ctx, signal)).rejects.toThrow(
			/aborted/i,
		);
	});
});

describe("executeBuildInterface awaiting-input marker", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function mockUIContextWithSession(
		sessionPath: string,
		drive: (component: Component, markerDuringPrompt: unknown) => void,
	): ExtensionContext {
		const ui = {
			async custom<T>(
				factory: (
					tui: unknown,
					theme: unknown,
					kb: unknown,
					done: (result: T) => void,
				) => Component | Promise<Component>,
			): Promise<T> {
				return new Promise<T>((resolve) => {
					const component = factory(null, null, null, resolve);
					Promise.resolve(component).then((c) => drive(c, readSessionAwaitingInput(sessionPath)));
				});
			},
		} as any;
		return {
			hasUI: true,
			ui,
			sessionManager: { getSessionFile: () => sessionPath },
		} as unknown as ExtensionContext;
	}

	const questionsInput: BuildInterfaceInput = {
		intent: "ask retry strategy",
		data: {
			questions: [
				{
					header: "Strategy",
					question: "Which retry strategy?",
					multiSelect: false,
					options: [
						{ label: "Exponential backoff", description: "2^n" },
						{ label: "Fixed interval", description: "every 5s" },
					],
				},
			],
		},
	};

	it("marks the session awaiting-input while the prompt is open, clears it once resolved", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-build-interface-awaiting-"));
		tempDirs.push(dir);
		const sessionPath = join(dir, "session.jsonl");

		let markerDuringPrompt: unknown;
		const ctx = mockUIContextWithSession(sessionPath, (component, marker) => {
			markerDuringPrompt = marker;
			component.handleInput?.("\r");
		});

		await executeBuildInterface(questionsInput, exampleQuestionsHarness, ctx);

		expect(markerDuringPrompt).toMatchObject({ reason: "ask retry strategy" });
		expect(readSessionAwaitingInput(sessionPath)).toBeUndefined();
	});

	it("clears the marker even when the prompt is cancelled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-build-interface-awaiting-"));
		tempDirs.push(dir);
		const sessionPath = join(dir, "session.jsonl");

		const ctx = mockUIContextWithSession(sessionPath, (component) => {
			component.handleInput?.("\x1b");
		});

		await executeBuildInterface(questionsInput, exampleQuestionsHarness, ctx);
		expect(readSessionAwaitingInput(sessionPath)).toBeUndefined();
	});
});

describe("createBuildInterfaceToolDefinition", () => {
	it("produces a ToolDefinition with the expected default surface", () => {
		const def = createBuildInterfaceToolDefinition({
			harness: staticHarness(minimalGraph),
		});
		expect(def.name).toBe("BuildInterface");
		expect(def.label).toBe("Build UI");
		expect(def.parameters).toBe(buildInterfaceSchema);
		expect(typeof def.execute).toBe("function");
	});

	it("honours toolName + label overrides", () => {
		const def = createBuildInterfaceToolDefinition({
			harness: staticHarness(minimalGraph),
			toolName: "ui",
			label: "UI",
		});
		expect(def.name).toBe("ui");
		expect(def.label).toBe("UI");
	});
});
