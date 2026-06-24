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

	it("wires footer nav through the editor onPreInput seam, not a global input listener", () => {
		// Regression: a global ui.addInputListener for footer nav ran before the
		// focused component and consumed up/down even while a focused custom
		// component (e.g. AskUserQuestion) needed those arrows, hijacking modal
		// navigation. Footer nav must be scoped to the default editor's focus via
		// onPreInput, so setupKeyHandlers must NOT register a global input listener.
		const addInputListener = vi.fn(() => () => {});
		const fakeMode = {
			defaultEditor: {
				onAction: vi.fn(),
				onEscape: undefined as unknown,
				onCtrlD: undefined as unknown,
				onPasteImage: undefined as unknown,
				onPreInput: undefined as ((data: string) => boolean) | undefined,
				onChange: undefined as unknown,
			},
			ui: { addInputListener, onDebug: undefined as unknown },
		};

		(InteractiveMode.prototype as unknown as { setupKeyHandlers: () => void }).setupKeyHandlers.call(fakeMode);

		expect(addInputListener).not.toHaveBeenCalled();
		expect(typeof fakeMode.defaultEditor.onPreInput).toBe("function");
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
});
