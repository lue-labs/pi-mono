import { fauxAssistantMessage } from "@valkyriweb/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionContext, ExtensionUIContext } from "../../../src/core/extensions/index.ts";
import { createHarness } from "../harness.ts";

describe("regression #295: extension idle state", () => {
	it("reports idle only when a new turn can start", async () => {
		let extensionContext!: ExtensionContext;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						extensionContext = ctx;
					});
				},
			],
		});
		const session = harness.session;
		await session.bindExtensions({ uiContext: {} as ExtensionUIContext, mode: "tui" });
		const privateSession = session as unknown as {
			_autoCompactionAbortController: AbortController | undefined;
		};
		const privateAgent = session.agent as unknown as {
			activeRun: unknown;
			state: { isStreaming: boolean };
		};

		try {
			expect(extensionContext.isIdle()).toBe(true);

			privateAgent.state.isStreaming = true;
			expect(extensionContext.isIdle()).toBe(false);
			privateAgent.state.isStreaming = false;

			privateSession._autoCompactionAbortController = new AbortController();
			expect(extensionContext.isIdle()).toBe(false);
			privateSession._autoCompactionAbortController = undefined;

			privateAgent.activeRun = {};
			expect(extensionContext.isIdle()).toBe(false);
			privateAgent.activeRun = undefined;

			expect(extensionContext.isIdle()).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("reports busy while prompt preflight is in flight", async () => {
		let extensionContext!: ExtensionContext;
		let markCommandStarted!: () => void;
		let releaseCommand!: () => void;
		const commandStarted = new Promise<void>((resolve) => {
			markCommandStarted = resolve;
		});
		const commandRelease = new Promise<void>((resolve) => {
			releaseCommand = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						extensionContext = ctx;
					});
					pi.registerCommand("block-preflight", {
						description: "Hold prompt preflight open for the regression",
						handler: async () => {
							markCommandStarted();
							await commandRelease;
						},
					});
				},
			],
		});
		const session = harness.session;
		await session.bindExtensions({ uiContext: {} as ExtensionUIContext, mode: "tui" });
		const prompt = session.prompt("/block-preflight");
		await commandStarted;

		try {
			expect(extensionContext.isIdle()).toBe(false);
			releaseCommand();
			await prompt;
			expect(extensionContext.isIdle()).toBe(true);
		} finally {
			releaseCommand();
			await prompt;
			harness.cleanup();
		}
	});

	it("reports busy while a custom-message turn is in preflight", async () => {
		let extensionContext!: ExtensionContext;
		let markBeforeStart!: () => void;
		let releaseBeforeStart!: () => void;
		const beforeStart = new Promise<void>((resolve) => {
			markBeforeStart = resolve;
		});
		const beforeStartRelease = new Promise<void>((resolve) => {
			releaseBeforeStart = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						extensionContext = ctx;
					});
					pi.on("before_agent_start", async () => {
						markBeforeStart();
						await beforeStartRelease;
					});
				},
			],
		});
		const session = harness.session;
		await session.bindExtensions({ uiContext: {} as ExtensionUIContext, mode: "tui" });
		harness.setResponses([fauxAssistantMessage("done")]);
		const turn = session.sendCustomMessage(
			{ customType: "test", content: "continue", display: false },
			{ triggerTurn: true },
		);
		await beforeStart;

		try {
			expect(extensionContext.isIdle()).toBe(false);
			releaseBeforeStart();
			await turn;
			expect(extensionContext.isIdle()).toBe(true);
		} finally {
			releaseBeforeStart();
			await turn.catch(() => {});
			harness.cleanup();
		}
	});
});
