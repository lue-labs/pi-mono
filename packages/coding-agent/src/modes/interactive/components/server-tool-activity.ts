import type { ServerToolSource } from "@lue-labs/pi-ai";
import { Box, Container, Spacer, Text } from "@lue-labs/pi-tui";
import { theme } from "../theme/theme.ts";

const MAX_SOURCES_SHOWN = 5;

/**
 * Display-only activity card for provider-executed (server-side) tools —
 * Anthropic native `web_search` / `web_fetch` / `advisor`. These run inside the model turn on
 * the provider side, so they never become real tool calls (no local execution, no
 * round-trip). They are surfaced via `server_tool_use` / `server_tool_result`
 * stream events and rendered here as a distinct activity card, intentionally
 * different from a `ToolExecutionComponent`.
 */
export class ServerToolActivityComponent extends Container {
	private readonly box: Box;
	private readonly toolName: string;
	private readonly query?: string;
	private readonly url?: string;
	private status: "running" | "completed" | "error" = "running";
	private sources: ServerToolSource[] = [];
	private errorCode?: string;

	constructor(args: { toolName: string; query?: string; url?: string }) {
		super();
		this.toolName = args.toolName;
		this.query = args.query;
		this.url = args.url;
		this.box = new Box(1, 0);
		this.addChild(new Spacer(1));
		this.addChild(this.box);
		this.rebuild();
	}

	setResult(args: { status: "completed" | "error"; sources?: ServerToolSource[]; errorCode?: string }): void {
		this.status = args.status;
		this.sources = args.sources ?? [];
		this.errorCode = args.errorCode;
		this.rebuild();
	}

	private title(): string {
		const verb = this.toolName === "web_fetch" ? "Web fetch" : this.toolName === "advisor" ? "Advisor" : "Web search";
		const icon = this.status === "error" ? "✗" : this.status === "completed" ? "✓" : "…";
		const subject = this.query ?? this.url;
		return `${icon} ${verb}${subject ? `: ${subject}` : ""}`;
	}

	private rebuild(): void {
		this.box.clear();
		this.box.addChild(new Text(theme.fg("toolTitle", `\x1b[1m${this.title()}\x1b[22m`), 0, 0));

		if (this.status === "error") {
			this.box.addChild(new Text(theme.fg("muted", `  (${this.errorCode ?? "error"})`), 0, 0));
			return;
		}

		const shown = this.sources.slice(0, MAX_SOURCES_SHOWN);
		for (const source of shown) {
			const line = source.title ? `${source.title} — ${source.url}` : source.url;
			this.box.addChild(new Text(theme.fg("dim", `  • ${line}`), 0, 0));
		}
		const extra = this.sources.length - shown.length;
		if (extra > 0) {
			this.box.addChild(new Text(theme.fg("muted", `  +${extra} more`), 0, 0));
		}
	}
}
