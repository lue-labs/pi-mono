import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("interactive-mode footer navigation", () => {
	function createFakeMode(onActivate = vi.fn(), editorText = "", options?: { includeEmptyFooter?: boolean }) {
		const footerEntries = [
			...(options?.includeEmptyFooter
				? [
						{
							id: "empty-status",
							spec: {
								visible: () => true,
								render: () => "",
								onActivate: vi.fn(),
							},
						},
					]
				: []),
			{
				id: "runtime-tasks",
				spec: {
					visible: () => true,
					render: () => "● 1 task · enter tasks",
					onActivate,
				},
			},
		];
		const fakeMode = {
			defaultEditor: {
				getText: () => editorText,
				onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
			},
			editor: { getText: () => editorText, setText: vi.fn() },
			selectedExtensionFooterId: undefined as string | undefined,
			debugFooterInput: vi.fn(),
			getFooterNavEditorText: () => fakeMode.editor.getText(),
			handleExtensionFooterNavInput: undefined as ((data: string) => boolean) | undefined,
			getVisibleExtensionFooterIds: () =>
				(
					InteractiveMode.prototype as unknown as { getVisibleExtensionFooterIds: () => string[] }
				).getVisibleExtensionFooterIds.call(fakeMode),
			setSelectedExtensionFooterId(id: string | undefined) {
				this.selectedExtensionFooterId = id;
				this.footer.setSelectedExtensionFooterId(id);
				this.ui.requestRender();
			},
			footer: { setSelectedExtensionFooterId: vi.fn() },
			ui: { requestRender: vi.fn(), terminal: { columns: 120 } },
			session: {
				extensionRunner: {
					getRegisteredFooters: () => footerEntries,
				},
			},
		};
		fakeMode.handleExtensionFooterNavInput = (data: string) =>
			(
				InteractiveMode.prototype as unknown as { handleExtensionFooterNavInput: (data: string) => boolean }
			).handleExtensionFooterNavInput.call(fakeMode, data);
		return fakeMode;
	}

	it("opens the only visible extension footer with enter when the prompt is empty", () => {
		const onActivate = vi.fn();
		const fakeMode = createFakeMode(onActivate);

		const handled = (
			InteractiveMode.prototype as unknown as { handleExtensionFooterNavInput: (data: string) => boolean }
		).handleExtensionFooterNavInput.call(fakeMode, "\r");

		expect(handled).toBe(true);
		expect(onActivate).toHaveBeenCalledTimes(1);
		expect(fakeMode.footer.setSelectedExtensionFooterId).toHaveBeenCalledWith(undefined);
	});

	it("treats newline as footer enter before empty-submit suppression", () => {
		const onActivate = vi.fn();
		const fakeMode = createFakeMode(onActivate);

		const handled = (
			InteractiveMode.prototype as unknown as { handleExtensionFooterNavInput: (data: string) => boolean }
		).handleExtensionFooterNavInput.call(fakeMode, "\n");

		expect(handled).toBe(true);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});

	it("treats whitespace-only editor text as empty for footer activation", () => {
		const onActivate = vi.fn();
		const fakeMode = createFakeMode(onActivate, "   ");

		const handled = (
			InteractiveMode.prototype as unknown as { handleExtensionFooterNavInput: (data: string) => boolean }
		).handleExtensionFooterNavInput.call(fakeMode, "\r");

		expect(handled).toBe(true);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});

	it("ignores visible footers with empty render output when deciding direct activation", () => {
		const onActivate = vi.fn();
		const fakeMode = createFakeMode(onActivate, "", { includeEmptyFooter: true });

		const handled = (
			InteractiveMode.prototype as unknown as { handleExtensionFooterNavInput: (data: string) => boolean }
		).handleExtensionFooterNavInput.call(fakeMode, "\r");

		expect(handled).toBe(true);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});

	it("uses the active editor text rather than stale default editor text", () => {
		const onActivate = vi.fn();
		const fakeMode = createFakeMode(onActivate, "");
		fakeMode.defaultEditor.getText = () => "stale submitted prompt";

		const handled = (
			InteractiveMode.prototype as unknown as { handleExtensionFooterNavInput: (data: string) => boolean }
		).handleExtensionFooterNavInput.call(fakeMode, "\r");

		expect(handled).toBe(true);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});

	it("routes empty prompt submission to the sole visible extension footer", async () => {
		const onActivate = vi.fn();
		const fakeMode = createFakeMode(onActivate);

		(InteractiveMode.prototype as unknown as { setupEditorSubmitHandler: () => void }).setupEditorSubmitHandler.call(
			fakeMode,
		);
		await fakeMode.defaultEditor.onSubmit?.("");

		expect(onActivate).toHaveBeenCalledTimes(1);
		expect(fakeMode.editor.setText).not.toHaveBeenCalled();
	});

	it("closes an active pane before clearing selected footer on escape", () => {
		const fakeMode = createFakeMode();
		const paneEscape = vi.fn(() => true);
		fakeMode.selectedExtensionFooterId = "runtime-tasks";
		(fakeMode as unknown as { activeMainPane: unknown }).activeMainPane = {
			id: "runtime-tasks",
			component: { onEscape: paneEscape },
		};

		(InteractiveMode.prototype as unknown as { handleEscapeKey: () => void }).handleEscapeKey.call(fakeMode);

		expect(paneEscape).toHaveBeenCalledTimes(1);
		expect(fakeMode.footer.setSelectedExtensionFooterId).not.toHaveBeenCalled();
	});

	it("disposes active main pane and overlay during extension UI reset", () => {
		const paneDispose = vi.fn();
		const overlayDispose = vi.fn();
		const overlayHide = vi.fn();
		const restoredChild = { id: "restored" };
		const fakeMode = {
			activeMainPane: {
				id: "runtime-tasks",
				component: { dispose: paneDispose },
				preChildren: [restoredChild],
			},
			hideExtensionMainPane: (
				InteractiveMode.prototype as unknown as { hideExtensionMainPane: (id: string) => void }
			).hideExtensionMainPane,
			activeOverlay: {
				id: "runtime-overlay",
				component: { dispose: overlayDispose },
				handle: { hide: overlayHide },
			},
			hideExtensionOverlay: (
				InteractiveMode.prototype as unknown as { hideExtensionOverlay: (id: string) => void }
			).hideExtensionOverlay,
			chatContainer: { clear: vi.fn(), addChild: vi.fn() },
			extensionSelector: undefined,
			extensionInput: undefined,
			extensionEditor: undefined,
			ui: { hideOverlay: vi.fn(), requestRender: vi.fn() },
			clearExtensionTerminalInputListeners: vi.fn(),
			setExtensionFooter: vi.fn(),
			setExtensionHeader: vi.fn(),
			clearExtensionWidgets: vi.fn(),
			footerDataProvider: { clearExtensionStatuses: vi.fn() },
			footer: { invalidate: vi.fn() },
			autocompleteProviderWrappers: [{ id: "old" }],
			setCustomEditorComponent: vi.fn(),
			setupAutocompleteProvider: vi.fn(),
			defaultEditor: { onExtensionShortcut: vi.fn() as unknown },
			updateTerminalTitle: vi.fn(),
			workingMessage: "old",
			workingVisible: false,
			setWorkingIndicator: vi.fn(),
			loadingAnimation: undefined,
			defaultWorkingMessage: "Working",
			setHiddenThinkingLabel: vi.fn(),
		};

		(InteractiveMode.prototype as unknown as { resetExtensionUI: () => void }).resetExtensionUI.call(fakeMode);

		expect(paneDispose).toHaveBeenCalledTimes(1);
		expect(fakeMode.activeMainPane).toBeUndefined();
		expect(overlayDispose).toHaveBeenCalledTimes(1);
		expect(overlayHide).toHaveBeenCalledTimes(1);
		expect(fakeMode.activeOverlay).toBeUndefined();
		expect(fakeMode.chatContainer.clear).toHaveBeenCalled();
		expect(fakeMode.chatContainer.addChild).toHaveBeenCalledWith(restoredChild);
	});
});
