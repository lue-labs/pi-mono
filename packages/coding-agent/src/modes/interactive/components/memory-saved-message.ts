import type { Component } from "@lue-labs/pi-tui";
import { Container, Text } from "@lue-labs/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { theme } from "../theme/theme.ts";

/**
 * Built-in renderer for `customType === "memory_saved"` transcript entries
 * produced by `ctx.transcript.append({ kind: "memory_saved", ... })`.
 *
 * Layout matches the system-message bullet style used for inline notices:
 *
 *     ● Saved 3 memories
 *       feedback_x99_pod_check.md
 *       feedback_no_invented_thresholds.md
 *       project_v53_externalized_plugins.md
 */
export class MemorySavedMessageComponent extends Container {
	constructor(verb: string, paths: string[]) {
		super();
		const safeVerb = verb === "Improved" ? "Improved" : "Saved";
		const count = paths.length;
		const noun = count === 1 ? "memory" : "memories";
		const headline = `${theme.fg("dim", "●")} ${safeVerb} ${count} ${noun}`;
		this.addChild(new Text(headline, 0, 0));
		for (const path of paths) {
			this.addChild(new Text(`  ${theme.fg("dim", path)}`, 0, 0));
		}
	}
}

interface MemorySavedDetails {
	verb?: "Saved" | "Improved";
	paths?: unknown;
}

function toPaths(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
}

/**
 * MessageRenderer the interactive TUI uses when no extension has registered
 * a renderer for `memory_saved`. Exposed so other modes/tests can reuse it
 * without depending on the TUI's wiring.
 */
export const memorySavedMessageRenderer: MessageRenderer = (message: CustomMessage<unknown>): Component | undefined => {
	const details = (message.details ?? {}) as MemorySavedDetails;
	const verb = details.verb === "Improved" ? "Improved" : "Saved";
	const paths = toPaths(details.paths);
	return new MemorySavedMessageComponent(verb, paths);
};
