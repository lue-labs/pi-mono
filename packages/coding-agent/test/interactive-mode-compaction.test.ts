import type { AgentMessage } from "@valkyriweb/pi-agent-core";
import { Container, Text, type TUI } from "@valkyriweb/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
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
	loadedResourcesContainer: Container;
	pendingTools: Map<string, never>;
	rebuildChatFromMessages(options?: { skipLeadingCompactionSummary?: boolean }): void;
	renderSessionEntries(
		entries: SessionEntry[],
		options?: { updateFooter?: boolean; populateHistory?: boolean; skipLeadingCompactionSummary?: boolean },
	): void;
	renderSessionItems(
		items: readonly (AgentMessage | Extract<SessionEntry, { type: "custom" }>)[],
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	getUserMessageText(message: Extract<AgentMessage, { role: "user" }>): string;
	getMarkdownThemeWithSettings(): undefined;
	getRegisteredToolDefinition(): undefined;
	updateEditorBorderColor(): void;
	showError(message: string): void;
	showStatus(message: string): void;
	clearStatusIndicator(id: string): void;
	flushCompactionQueue(options: { willRetry: boolean }): Promise<void>;
	setToolsExpanded(expanded: boolean): void;
	settingsManager: {
		getShowTerminalProgress(): boolean;
		getShowCacheMissNotices(): boolean;
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	ui: TUI;
	sessionManager: {
		buildContextEntries(): SessionEntry[];
		getEntries(): SessionEntry[];
		getCwd(): string;
	};
	session: { retryAttempt: number };
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string | undefined;
	outputPad: number;
	customHeader: undefined;
	builtInHeader: undefined;
};

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: InteractiveCompactionTestThis,
	event: AgentSessionEvent,
) => Promise<void>;

const setToolsExpanded = Reflect.get(InteractiveMode.prototype, "setToolsExpanded") as (
	this: InteractiveCompactionTestThis,
	expanded: boolean,
) => void;

function renderChat(container: Container): string {
	return stripAnsi(container.render(100).join("\n"));
}

describe("InteractiveMode compaction events", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("clears old transcript and renders one expandable live summary after the kept tail", async () => {
		const now = new Date().toISOString();
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "compaction-entry",
				parentId: "old-assistant",
				timestamp: now,
				summary: "persisted summary at context head",
				firstKeptEntryId: "kept-user",
				tokensBefore: 999,
			},
			{
				type: "message",
				id: "kept-user",
				parentId: "old-assistant",
				timestamp: now,
				message: {
					role: "user",
					content: [{ type: "text", text: "kept tail message" }],
					timestamp: Date.now(),
				},
			},
		];
		const chatContainer = new Container();
		chatContainer.addChild(new Text("old transcript that must be cleared", 0, 0));
		const fakeThis: InteractiveCompactionTestThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer,
			loadedResourcesContainer: new Container(),
			pendingTools: new Map<string, never>(),
			rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
			renderSessionEntries: Reflect.get(InteractiveMode.prototype, "renderSessionEntries"),
			renderSessionItems: Reflect.get(InteractiveMode.prototype, "renderSessionItems"),
			addMessageToChat: Reflect.get(InteractiveMode.prototype, "addMessageToChat"),
			getUserMessageText: Reflect.get(InteractiveMode.prototype, "getUserMessageText"),
			getMarkdownThemeWithSettings: () => undefined,
			getRegisteredToolDefinition: () => undefined,
			updateEditorBorderColor: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			setToolsExpanded: Reflect.get(InteractiveMode.prototype, "setToolsExpanded"),
			settingsManager: {
				getShowTerminalProgress: () => false,
				getShowCacheMissNotices: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 60,
			},
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } } as unknown as TUI,
			sessionManager: {
				buildContextEntries: () => entries,
				getEntries: () => entries,
				getCwd: () => process.cwd(),
			},
			session: { retryAttempt: 0 },
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			hiddenThinkingLabel: undefined,
			outputPad: 1,
			customHeader: undefined,
			builtInHeader: undefined,
		};

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "live summary visible after expansion",
				firstKeptEntryId: "kept-user",
				estimatedTokensAfter: 42,
			},
			aborted: false,
			willRetry: false,
		});

		const collapsed = renderChat(chatContainer);
		expect(collapsed).not.toContain("old transcript that must be cleared");
		expect(collapsed.match(/\[compaction\]/g)).toHaveLength(1);
		expect(collapsed).toContain("kept tail message");
		expect(collapsed).toContain("Compacted from 123 tokens");
		expect(collapsed).not.toContain("live summary visible after expansion");
		expect(collapsed.indexOf("kept tail message")).toBeLessThan(collapsed.indexOf("[compaction]"));

		setToolsExpanded.call(fakeThis, true);
		expect(renderChat(chatContainer)).toContain("live summary visible after expansion");
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});
});
