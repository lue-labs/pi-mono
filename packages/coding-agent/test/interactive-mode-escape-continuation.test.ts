import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function handleEscape(fakeMode: unknown): void {
	(InteractiveMode.prototype as unknown as { handleEscapeKey: () => void }).handleEscapeKey.call(fakeMode);
}

function createFakeMode(options: {
	editorText?: string;
	queuedMessages?: string[];
	abortAndResume?: () => Promise<void>;
	prompt?: (text: string) => Promise<void>;
}) {
	let editorText = options.editorText ?? "";
	const setText = vi.fn((text: string) => {
		editorText = text;
	});
	const queuedMessages = options.queuedMessages ?? [];
	const prompt = vi.fn(options.prompt ?? (async () => {}));
	const abortAndResumeQueuedMessages = vi.fn(
		options.abortAndResume ??
			(async () => {
				for (const queued of queuedMessages) await prompt(queued);
			}),
	);
	const fakeMode = {
		activeMainPane: undefined,
		selectedExtensionFooterId: undefined,
		escapeContinuationInFlight: false,
		editor: {
			getText: () => editorText,
			getExpandedText: () => editorText,
			setText,
			addToHistory: vi.fn(),
		},
		session: {
			isStreaming: true,
			isBashRunning: false,
			abortAndResumeQueuedMessages,
			prompt,
		},
		setSelectedExtensionFooterId: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		handleStreamingEscape: () =>
			(InteractiveMode.prototype as unknown as { handleStreamingEscape: () => void }).handleStreamingEscape.call(
				fakeMode,
			),
		showError: vi.fn(),
		settingsManager: { getDoubleEscapeAction: () => "none" },
		ui: { requestRender: vi.fn() },
	};
	return { fakeMode, setText, abortAndResumeQueuedMessages, prompt };
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("interactive-mode Escape continuation", () => {
	it("aborts then submits composer text as the next normal prompt", async () => {
		const calls: string[] = [];
		const { fakeMode, setText, abortAndResumeQueuedMessages, prompt } = createFakeMode({
			editorText: "  continue with this  ",
			abortAndResume: async () => {
				calls.push("abort");
			},
			prompt: async (text) => {
				calls.push(`prompt:${text}`);
			},
		});

		handleEscape(fakeMode);
		await flushAsyncWork();

		expect(calls).toEqual(["abort", "prompt:continue with this"]);
		expect(abortAndResumeQueuedMessages).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith("continue with this");
		expect(setText).toHaveBeenCalledWith("");
	});

	it("promotes queued work when the composer is empty", async () => {
		const { fakeMode, abortAndResumeQueuedMessages, prompt } = createFakeMode({
			queuedMessages: ["queued"],
		});

		handleEscape(fakeMode);
		await flushAsyncWork();

		expect(abortAndResumeQueuedMessages).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith("queued");
	});

	it("retains plain abort when composer and queues are empty", async () => {
		const { fakeMode, abortAndResumeQueuedMessages, prompt } = createFakeMode({});

		handleEscape(fakeMode);
		await flushAsyncWork();

		expect(abortAndResumeQueuedMessages).toHaveBeenCalledTimes(1);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("ignores repeated Escape while abort and submit are in flight", async () => {
		let releaseAbort: (() => void) | undefined;
		const abortBlocked = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		const { fakeMode, abortAndResumeQueuedMessages, prompt } = createFakeMode({
			editorText: "next",
			abortAndResume: async () => abortBlocked,
		});

		handleEscape(fakeMode);
		handleEscape(fakeMode);
		expect(abortAndResumeQueuedMessages).toHaveBeenCalledTimes(1);

		releaseAbort?.();
		await flushAsyncWork();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith("next");
	});

	it("restores composer text when the continuation prompt fails", async () => {
		const { fakeMode, setText } = createFakeMode({
			editorText: "keep me",
			prompt: async () => {
				throw new Error("prompt failed");
			},
		});

		handleEscape(fakeMode);
		await flushAsyncWork();

		expect(setText).toHaveBeenNthCalledWith(1, "");
		expect(setText).toHaveBeenNthCalledWith(2, "keep me");
		expect(fakeMode.showError).toHaveBeenCalledWith("prompt failed");
	});
});
