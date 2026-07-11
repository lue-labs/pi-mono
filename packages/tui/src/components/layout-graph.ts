/**
 * Layout Graph — pure TS types for the generative-UI schema.
 *
 * See: rusty/docs/prd/generative-ui-proposal.md §5.3 for the design.
 *
 * Types live here in `@earendil-works/pi-tui` so the LayoutRenderer can
 * consume them without depending on the coding-agent package. The TypeBox
 * runtime validation schema is defined in
 * `packages/coding-agent/src/core/tools/layout-graph.ts`, which re-exports
 * these types. Schema + types must stay in sync.
 *
 * v0 covers the subset needed for AskUserQuestion + simple forms. Adding a
 * primitive is a deliberate act — type entry + Pi renderer + Rusty renderer
 * + harness docstring. See §5.4 ("catalog is the API surface").
 */

export const LAYOUT_GRAPH_VERSION = "0.1" as const;

export interface LayoutOption {
	value: string;
	label: string;
	description?: string;
}

export interface LayoutTextStyle {
	color?: string;
	bold?: boolean;
	italic?: boolean;
	dim?: boolean;
}

export type LayoutAction =
	| { type: "submit"; collect: string[] }
	| { type: "cancel" }
	| { type: "set"; id: string; value: unknown };

export type LayoutAlign = "start" | "center" | "end" | "stretch";

/**
 * Hand-written recursive union. TS can unify these structurally across nested
 * `children`/`content` slots, where a Static<>-derived recursive type cannot.
 */
export type LayoutNode =
	| { type: "text"; value: string; style?: LayoutTextStyle }
	| { type: "markdown"; value: string }
	| {
			type: "button";
			id: string;
			label: string;
			variant?: "primary" | "secondary";
			disabled?: boolean;
			action: LayoutAction;
	  }
	| {
			type: "text_input";
			id: string;
			placeholder?: string;
			value?: string;
			multiline?: boolean;
	  }
	| {
			type: "radio_group";
			id: string;
			options: LayoutOption[];
			value?: string;
	  }
	| {
			type: "checkbox_group";
			id: string;
			options: LayoutOption[];
			value?: string[];
	  }
	| { type: "tabs"; tabs: Array<{ header: string; content: LayoutNode }> }
	| {
			type: "row" | "col" | "stack";
			gap?: number;
			align?: LayoutAlign;
			children: LayoutNode[];
	  }
	| { type: "card"; title?: string; children: LayoutNode[] }
	| { type: "scroll"; max_height?: number; child: LayoutNode }
	| { type: "divider" }
	| { type: "image"; src: string; alt?: string };

export interface LayoutGraph {
	version: typeof LAYOUT_GRAPH_VERSION;
	root: LayoutNode;
	/**
	 * If true, the live UI is torn down on submit; only an archival summary
	 * remains. Default for AskUserQuestion.
	 */
	ephemeral?: boolean;
	/** Auto-cancel after this many milliseconds. */
	timeout_ms?: number;
}

/**
 * Response envelope returned to the agent after submit. Maps input id to the
 * user-supplied value (string for radio/text, string[] for checkbox).
 */
export type LayoutResponse = Record<string, string | string[] | undefined>;
