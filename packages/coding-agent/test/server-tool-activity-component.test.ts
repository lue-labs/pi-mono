import { beforeAll, describe, expect, test } from "vitest";
import { ServerToolActivityComponent } from "../src/modes/interactive/components/server-tool-activity.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderText(component: ServerToolActivityComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("ServerToolActivityComponent titles", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("labels web_search with its query", () => {
		const component = new ServerToolActivityComponent({ toolName: "web_search", query: "pi docs" });
		expect(renderText(component)).toContain("… Web search: pi docs");
	});

	test("labels web_fetch with its url", () => {
		const component = new ServerToolActivityComponent({ toolName: "web_fetch", url: "https://example.com" });
		expect(renderText(component)).toContain("… Web fetch: https://example.com");
	});

	test("labels advisor failures as Advisor, not Web search", () => {
		// Regression: a failing advisor_20260301 server tool used to render as
		// "✗ Web search (unavailable)" because title() defaulted every
		// non-web_fetch tool to "Web search".
		const component = new ServerToolActivityComponent({ toolName: "advisor" });
		component.setResult({ status: "error", errorCode: "unavailable" });
		const text = renderText(component);
		expect(text).toContain("✗ Advisor");
		expect(text).toContain("(unavailable)");
		expect(text).not.toContain("Web search");
	});
});
