import type { AgentMessage } from "@valkyriweb/pi-agent-core";
import { Container, type TUI } from "@valkyriweb/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SessionContext } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type InteractiveCompactionTestThis = {
	isInitialized: boolean;
	footer: { invalidate(): void };
	autoCompactionEscapeHandler: (() => void) | undefined;
	autoCompactionLoader: undefined;
	defaultEditor: { onEscape?: () => void };
	statusContainer: { clear(): void };
	chatContainer: Container;
	pendingTools: Map<string, never>;
	rebuildChatFromMessages(options?: { skipLeadingCompactionSummary?: boolean }): void;
	renderSessionContext(sessionContext: SessionContext, options?: { skipLeadingCompactionSummary?: boolean }): void;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	getUserMessageText(message: Extract<AgentMessage, { role: "user" }>): string;
	getMarkdownThemeWithSettings(): undefined;
	getRegisteredToolDefinition(): undefined;
	updateEditorBorderColor(): void;
	showError(message: string): void;
	showStatus(message: string): void;
	flushCompactionQueue(options: { willRetry: boolean }): Promise<void>;
	settingsManager: {
		getShowTerminalProgress(): boolean;
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	ui: TUI;
	sessionManager: {
		buildSessionContext(): SessionContext;
		getCwd(): string;
	};
	session: { retryAttempt: number };
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string | undefined;
};

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: InteractiveCompactionTestThis,
	event: AgentSessionEvent,
) => Promise<void>;

function renderChat(container: Container): string {
	return stripAnsi(container.render(100).join("\n"));
}

describe("InteractiveMode compaction events", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders exactly one live compaction summary after the rebuilt kept tail", async () => {
		const chatContainer = new Container();
		const fakeThis: InteractiveCompactionTestThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer,
			pendingTools: new Map(),
			rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
			renderSessionContext: Reflect.get(InteractiveMode.prototype, "renderSessionContext"),
			addMessageToChat: Reflect.get(InteractiveMode.prototype, "addMessageToChat"),
			getUserMessageText: Reflect.get(InteractiveMode.prototype, "getUserMessageText"),
			getMarkdownThemeWithSettings: () => undefined,
			getRegisteredToolDefinition: () => undefined,
			updateEditorBorderColor: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: {
				getShowTerminalProgress: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 60,
			},
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } } as unknown as TUI,
			sessionManager: {
				buildSessionContext: () => ({
					messages: [
						{
							role: "compactionSummary",
							summary: "persisted summary that belongs at context head",
							tokensBefore: 999,
							timestamp: Date.now(),
						},
						{
							role: "user",
							content: [{ type: "text", text: "kept tail message" }],
							timestamp: Date.now(),
						},
					],
					thinkingLevel: "off",
					model: null,
				}),
				getCwd: () => process.cwd(),
			},
			session: { retryAttempt: 0 },
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			hiddenThinkingLabel: undefined,
		};

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "live summary visible at the bottom",
				firstKeptEntryId: "kept-entry",
				estimatedTokensAfter: 42,
			},
			aborted: false,
			willRetry: false,
		});

		const rendered = renderChat(chatContainer);
		expect(rendered.match(/\[compaction\]/g)).toHaveLength(1);
		expect(rendered).toContain("kept tail message");
		expect(rendered).toContain("Compacted from 123 tokens");
		expect(rendered.indexOf("kept tail message")).toBeLessThan(rendered.indexOf("[compaction]"));
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});
});
