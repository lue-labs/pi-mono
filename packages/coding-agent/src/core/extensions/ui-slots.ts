// Fork-owned module (fork-delta reforge slice 3): B5 TUI extension slot types
// moved verbatim from types.ts. Re-exported from types.ts for import compat.

import type { Component, TUI } from "@lue-labs/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

// ============================================================================
// B5 TUI Extension Slots — Main Pane / Overlay / Footer
// ============================================================================
//
// Slot/extension points (spatial). Distinct from temporal hooks (`on*`):
//   - register<Position>() places a component in a named slot.
//   - show<Position>(id, payload?) / hide<Position>(id) imperatively activate/deactivate.
//   - Footer is reactive (visible() predicate) rather than imperative show/hide.
//
// Design lives in valkyriweb/my-pi at docs/plans/b5-tui-hooks-design-proposal-2026-05-21.md.
// Naming follows VS Code's extension API (registerWebviewViewProvider style).

/**
 * Per-pane API surface passed to a registered main-pane factory.
 * The component requests its own hide via `requestHide()`; the framework owns
 * save/restore of the prior `chatContainer` children.
 */
export interface ExtensionMainPaneAPI {
	/** Caller payload passed via `showMainPane(id, payload)`. */
	payload: unknown;
	/** Ask the framework to hide this pane and restore prior content. */
	requestHide(): void;
}

/**
 * Factory for an extension-registered main pane. Returns a component the
 * framework mounts into `chatContainer` while the pane is shown.
 */
export interface ExtensionMainPaneComponent extends Component {
	dispose?(): void;
	/** Return true when the pane handled Escape and should remain mounted. */
	onEscape?(): boolean | undefined;
}

export type ExtensionMainPaneFactory = (
	tui: TUI,
	theme: Theme,
	api: ExtensionMainPaneAPI,
) => ExtensionMainPaneComponent;

/**
 * Per-overlay API surface passed to a registered overlay factory.
 * Mirrors `ExtensionMainPaneAPI` semantics — distinct interface so callers
 * cannot accidentally mix mainPane / overlay payloads at the type level.
 */
export interface ExtensionOverlayAPI {
	/** Caller payload passed via `showOverlay(id, payload)`. */
	payload: unknown;
	/** Ask the framework to hide this overlay. */
	requestHide(): void;
}

/**
 * Factory for an extension-registered overlay. Returns a component the
 * framework mounts as an overlay on the topmost stack position while shown.
 */
export type ExtensionOverlayFactory = (
	tui: TUI,
	theme: Theme,
	api: ExtensionOverlayAPI,
) => Component & { dispose?(): void };

/**
 * Actions wired into the extension runner by a UI-capable mode (today only
 * interactive-mode) to back the B5 imperative show/hide API. Non-UI modes
 * skip the bind call so the default no-op stubs stay in place and the API
 * silently swallows the requests.
 */
export interface ExtensionSlotUIActions {
	showMainPane: (id: string, payload: unknown) => void;
	hideMainPane: (id: string) => void;
	hasMainPane?: (id: string) => boolean;
	showOverlay: (id: string, payload: unknown) => void;
	hideOverlay: (id: string) => void;
}

/** Render context passed to a footer pill's `render()` callback. */
export interface ExtensionFooterRenderCtx {
	width: number;
	theme: Theme;
	selected: boolean;
}

/**
 * Extension-registered footer pill spec. Contributes a focusable into the
 * existing footer nav chain without owning the whole footer (use
 * `ui.setFooter(factory)` for whole-region replacement).
 *
 * Visibility is reactive: `visible()` is evaluated on every footer render pass,
 * so pills appear/disappear based on extension state without imperative
 * `show/hide` calls.
 */
export interface ExtensionFooterSpec {
	/** Render the pill content. Framework wraps it in the standard pill chrome. */
	render(ctx: ExtensionFooterRenderCtx): string;
	/** Reactive visibility predicate. Defaults to always-visible. */
	visible?: () => boolean;
	/** Called when the user activates the pill (Enter / click). */
	onActivate(api: { close(): void }): void;
	/**
	 * Optional sort key relative to built-in pills. Built-in pills use
	 * implementation-defined orders; default behavior is to append after them.
	 */
	order?: number;
}
