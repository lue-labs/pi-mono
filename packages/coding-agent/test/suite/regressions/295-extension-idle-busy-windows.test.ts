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
});
