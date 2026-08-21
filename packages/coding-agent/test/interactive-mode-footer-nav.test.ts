import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("interactive-mode footer navigation", () => {
	function createFakeMode(
		onActivate = vi.fn(),
		editorText = "",
		options?: { includeEmptyFooter?: boolean; extraFooterIds?: string[] },
	) {
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
			...(options?.extraFooterIds ?? []).map((id) => ({
				id,
				spec: {
					visible: () => true,
					render: () => `● ${id}`,
					onActivate: vi.fn(),
				},
			})),
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

	// Regression (agents-ux-parity round 3): setCustomEditorComponent forwards
	// onEscape/onCtrlD/onPasteImage/onExtensionShortcut/actionHandlers from
	// defaultEditor onto a replacement editor installed via
	// `ctx.ui.setEditorComponent` (e.g. pi-syntax-input, or any extension that
	// wraps the editor), but it never forwarded `onPreInput` — the seam that
	// drives footer pill Up/Down nav (and queued-message recall). Any session
	// running such an extension silently lost footer pill highlight/nav for
	// the rest of the session (Enter still worked because onSubmit *is*
	// forwarded and routes through handleExtensionFooterNavInput directly).
	it("forwards onPreInput to a replacement editor installed via setEditorComponent", () => {
		const defaultOnPreInput = vi.fn((_data: string) => true);
		const fakeMode = {
			editor: { getText: () => "" },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			disposeActiveSelector: vi.fn(),
			setupInputHighlighter: vi.fn(),
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			keybindings: {},
			autocompleteProvider: undefined,
			defaultEditor: {
				onSubmit: vi.fn(),
				onChange: vi.fn(),
				onPreInput: defaultOnPreInput,
				onEscape: undefined,
				onCtrlD: undefined,
				onPasteImage: undefined,
				onExtensionShortcut: undefined,
				borderColor: undefined,
				getPaddingX: () => 0,
				actionHandlers: new Map(),
			},
		};
		const newEditor: Record<string, unknown> = {
			setText: vi.fn(),
			getText: () => "",
			actionHandlers: new Map(),
		};

		(
			InteractiveMode.prototype as unknown as { setCustomEditorComponent: (factory: unknown) => void }
		).setCustomEditorComponent.call(fakeMode, () => newEditor);

		expect(typeof newEditor.onPreInput).toBe("function");
		const result = (newEditor.onPreInput as (data: string) => boolean)("\x1b[B");
		expect(defaultOnPreInput).toHaveBeenCalledWith("\x1b[B");
		expect(result).toBe(true);
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

	// Regression: b25bca256 — before this fix, pressing down/up on an empty
	// editor mutated `selectedExtensionFooterId` internally but the footer's
	// rendered selection never visibly changed for pills whose extension
	// didn't implement its own highlight, and moving past the first/last pill
	// silently wrapped instead of clearing the selection. These tests exercise
	// the actual multi-pill cycling/deselect state machine, not just enter/escape.
	describe("up/down cycling across multiple pills", () => {
		function fakeModeWithTwoPills() {
			return createFakeMode(vi.fn(), "", { extraFooterIds: ["second-pill"] });
		}

		it("selects the first pill on down when nothing is selected", () => {
			const fakeMode = fakeModeWithTwoPills();

			const handled = fakeMode.handleExtensionFooterNavInput?.("\x1b[B");

			expect(handled).toBe(true);
			expect(fakeMode.selectedExtensionFooterId).toBe("runtime-tasks");
			expect(fakeMode.footer.setSelectedExtensionFooterId).toHaveBeenCalledWith("runtime-tasks");
		});

		it("selects the last pill on up when nothing is selected", () => {
			const fakeMode = fakeModeWithTwoPills();

			const handled = fakeMode.handleExtensionFooterNavInput?.("\x1b[A");

			expect(handled).toBe(true);
			expect(fakeMode.selectedExtensionFooterId).toBeUndefined();
		});

		it("advances selection forward on repeated down presses", () => {
			const fakeMode = fakeModeWithTwoPills();

			fakeMode.handleExtensionFooterNavInput?.("\x1b[B");
			expect(fakeMode.selectedExtensionFooterId).toBe("runtime-tasks");

			fakeMode.handleExtensionFooterNavInput?.("\x1b[B");
			expect(fakeMode.selectedExtensionFooterId).toBe("second-pill");
		});

		it("clears the selection instead of wrapping past the last pill", () => {
			const fakeMode = fakeModeWithTwoPills();
			fakeMode.selectedExtensionFooterId = "second-pill";

			const handled = fakeMode.handleExtensionFooterNavInput?.("\x1b[B");

			expect(handled).toBe(true);
			// Stays on the last pill rather than wrapping to the first.
			expect(fakeMode.footer.setSelectedExtensionFooterId).not.toHaveBeenCalled();
		});

		it("clears the selection instead of wrapping past the first pill on up", () => {
			const fakeMode = fakeModeWithTwoPills();
			fakeMode.selectedExtensionFooterId = "runtime-tasks";

			const handled = fakeMode.handleExtensionFooterNavInput?.("\x1b[A");

			expect(handled).toBe(true);
			expect(fakeMode.selectedExtensionFooterId).toBeUndefined();
			expect(fakeMode.footer.setSelectedExtensionFooterId).toHaveBeenCalledWith(undefined);
		});
	});

	// Regression (agents-ux-parity footer round, live-verified via tmux): opening
	// an extension main pane (e.g. the footer agents-status pill's Enter) mounted
	// the pane component into chatContainer but never gave it keyboard focus, so
	// no keystroke ever reached its handleInput -- up/down navigate, enter
	// details/zoom, and x stop were all silently dead once the pane was open
	// (only Escape worked, via the separate onEscape passthrough). Every other
	// editor-replacing surface in this file calls `ui.setFocus(component)`; this
	// one didn't.
	describe("extension main pane focus wiring", () => {
		function fakeModeWithMainPane(component: Record<string, unknown>) {
			const factory = vi.fn(() => component);
			const fakeMode = {
				activeMainPane: undefined as unknown,
				chatContainer: { children: [] as unknown[], clear: vi.fn(), addChild: vi.fn() },
				editor: { id: "editor" },
				ui: { setFocus: vi.fn(), requestRender: vi.fn() },
				session: { extensionRunner: { getRegisteredMainPane: vi.fn(() => factory) } },
			};
			return fakeMode;
		}

		it("focuses the pane component when it is shown, so its handleInput actually receives keystrokes", () => {
			const component = { render: vi.fn(() => []), handleInput: vi.fn(), dispose: vi.fn() };
			const fakeMode = fakeModeWithMainPane(component);

			(
				InteractiveMode.prototype as unknown as { showExtensionMainPane: (id: string, payload: unknown) => void }
			).showExtensionMainPane.call(fakeMode, "agents-status", {});

			expect(fakeMode.ui.setFocus).toHaveBeenCalledWith(component);
		});

		it("keeps editor focus for display-only panes that route input through editor submit", () => {
			const component = { render: vi.fn(() => []), dispose: vi.fn(), captureInput: false };
			const fakeMode = fakeModeWithMainPane(component);

			(
				InteractiveMode.prototype as unknown as { showExtensionMainPane: (id: string, payload: unknown) => void }
			).showExtensionMainPane.call(fakeMode, "zoom", {});

			expect(fakeMode.ui.setFocus).toHaveBeenCalledWith(fakeMode.editor);
		});

		it("restores focus to the editor when the pane is hidden", () => {
			const component = { render: vi.fn(() => []), handleInput: vi.fn(), dispose: vi.fn() };
			const fakeMode = fakeModeWithMainPane(component);
			(
				InteractiveMode.prototype as unknown as { showExtensionMainPane: (id: string, payload: unknown) => void }
			).showExtensionMainPane.call(fakeMode, "agents-status", {});
			fakeMode.ui.setFocus.mockClear();

			(
				InteractiveMode.prototype as unknown as { hideExtensionMainPane: (id: string) => void }
			).hideExtensionMainPane.call(fakeMode, "agents-status");

			expect(fakeMode.ui.setFocus).toHaveBeenCalledWith(fakeMode.editor);
		});
	});
});
