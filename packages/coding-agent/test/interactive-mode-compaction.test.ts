import type { AgentMessage } from "@lue-labs/pi-agent-core";
import type { Usage } from "@lue-labs/pi-ai";
import { Container, Text, type TUI } from "@lue-labs/pi-tui";
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
	clearChatForRebuild(): void;
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
	getMarkdownTransformers(): [];
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
	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			{},
		);
	});

	test("updates the working state when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			activeStatusIndicator: undefined,
			workingVisible: true,
			showWorkingStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "turn_start" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

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
			clearChatForRebuild: Reflect.get(InteractiveMode.prototype, "clearChatForRebuild"),
			rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
			renderSessionEntries: Reflect.get(InteractiveMode.prototype, "renderSessionEntries"),
			renderSessionItems: Reflect.get(InteractiveMode.prototype, "renderSessionItems"),
			addMessageToChat: Reflect.get(InteractiveMode.prototype, "addMessageToChat"),
			getUserMessageText: Reflect.get(InteractiveMode.prototype, "getUserMessageText"),
			getMarkdownThemeWithSettings: () => undefined,
			getMarkdownTransformers: () => [],
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

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
