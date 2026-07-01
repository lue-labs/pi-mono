import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/utils/ansi.ts";
import { renderPierrePatchToAnsi } from "../src/utils/pierre-diff.ts";

describe("Pierre diff renderer", () => {
	it("renders a unified patch to ANSI terminal lines", async () => {
		const patch = `--- a/demo.ts
+++ b/demo.ts
@@ -1,2 +1,2 @@
-const value = 'before';
+const value = 'after';
 console.log(value);
`;

		const lines = await renderPierrePatchToAnsi(patch, 120);
		const raw = lines.join("\n");
		const visible = stripAnsi(raw);

		expect(visible).toContain("-  1 const value = 'before';");
		expect(visible).toContain("+  1 const value = 'after';");
		expect(visible).toContain("   2 console.log(value);");
		expect(raw).toContain("\x1b[38;2;");
		expect(raw).toContain("\x1b[7m");
	});
});
