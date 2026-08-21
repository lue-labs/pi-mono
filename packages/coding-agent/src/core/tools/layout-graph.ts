/**
 * Layout Graph — TypeBox runtime validation schema.
 *
 * Type definitions live in `@lue-labs/pi-tui` so the LayoutRenderer
 * can consume them without depending on this package. This file owns the
 * runtime validation surface (TypeBox) and re-exports the types for
 * convenience.
 *
 * See: rusty/docs/prd/generative-ui-proposal.md §5.3
 */

import { Type } from "typebox";

export {
	LAYOUT_GRAPH_VERSION,
	type LayoutAction,
	type LayoutAlign,
	type LayoutGraph,
	type LayoutNode,
	type LayoutOption,
	type LayoutResponse,
	type LayoutTextStyle,
} from "@lue-labs/pi-tui";

const optionSchema = Type.Object({
	value: Type.String({ description: "Stable identifier for this option" }),
	label: Type.String({ description: "User-facing label" }),
	description: Type.Optional(Type.String({ description: "One-line hint" })),
});

const textStyleSchema = Type.Object({
	color: Type.Optional(Type.String()),
	bold: Type.Optional(Type.Boolean()),
	italic: Type.Optional(Type.Boolean()),
	dim: Type.Optional(Type.Boolean()),
});

const alignSchema = Type.Union([
	Type.Literal("start"),
	Type.Literal("center"),
	Type.Literal("end"),
	Type.Literal("stretch"),
]);

export const actionSchema = Type.Union([
	Type.Object({
		type: Type.Literal("submit"),
		collect: Type.Array(Type.String(), {
			description: "Input ids to collect into the response envelope",
		}),
	}),
	Type.Object({ type: Type.Literal("cancel") }),
	Type.Object({
		type: Type.Literal("set"),
		id: Type.String(),
		value: Type.Unknown(),
	}),
]);

/**
 * Runtime schema. Uses Type.This() ($ref: "#") for recursion. Because the
 * self-reference always resolves to the schema currently being validated,
 * validate nodes against `nodeSchema` directly (e.g. `Check(nodeSchema,
 * graph.root)`), not as a nested property of layoutGraphSchema — inside the
 * wrapper, `#` would point at the wrapper, breaking child checks.
 */
export const nodeSchema = Type.Union([
	Type.Object({
		type: Type.Literal("text"),
		value: Type.String(),
		style: Type.Optional(textStyleSchema),
	}),
	Type.Object({
		type: Type.Literal("markdown"),
		value: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("button"),
		id: Type.String(),
		label: Type.String(),
		variant: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("secondary")])),
		disabled: Type.Optional(Type.Boolean()),
		action: actionSchema,
	}),
	Type.Object({
		type: Type.Literal("text_input"),
		id: Type.String(),
		placeholder: Type.Optional(Type.String()),
		value: Type.Optional(Type.String()),
		multiline: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		type: Type.Literal("radio_group"),
		id: Type.String(),
		options: Type.Array(optionSchema, { minItems: 1 }),
		value: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("checkbox_group"),
		id: Type.String(),
		options: Type.Array(optionSchema, { minItems: 1 }),
		value: Type.Optional(Type.Array(Type.String())),
	}),
	Type.Object({
		type: Type.Literal("tabs"),
		tabs: Type.Array(
			Type.Object({
				header: Type.String(),
				content: Type.This(),
			}),
			{ minItems: 1 },
		),
	}),
	Type.Object({
		type: Type.Literal("row"),
		gap: Type.Optional(Type.Number()),
		align: Type.Optional(alignSchema),
		children: Type.Array(Type.This()),
	}),
	Type.Object({
		type: Type.Literal("col"),
		gap: Type.Optional(Type.Number()),
		align: Type.Optional(alignSchema),
		children: Type.Array(Type.This()),
	}),
	Type.Object({
		type: Type.Literal("stack"),
		gap: Type.Optional(Type.Number()),
		align: Type.Optional(alignSchema),
		children: Type.Array(Type.This()),
	}),
	Type.Object({
		type: Type.Literal("card"),
		title: Type.Optional(Type.String()),
		children: Type.Array(Type.This()),
	}),
	Type.Object({
		type: Type.Literal("scroll"),
		max_height: Type.Optional(Type.Number()),
		child: Type.This(),
	}),
	Type.Object({ type: Type.Literal("divider") }),
	Type.Object({
		type: Type.Literal("image"),
		src: Type.String(),
		alt: Type.Optional(Type.String()),
	}),
]);

export const layoutGraphSchema = Type.Object({
	version: Type.Literal("0.1"),
	root: nodeSchema,
	ephemeral: Type.Optional(Type.Boolean()),
	timeout_ms: Type.Optional(Type.Number()),
});
