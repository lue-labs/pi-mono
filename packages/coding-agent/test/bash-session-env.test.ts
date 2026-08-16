import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";

function getText(result: any): string {
	return result.content?.[0]?.text ?? "";
}

async function runEcho(ctx: unknown): Promise<string> {
	const bash = createBashToolDefinition(process.cwd());
	const result = await bash.execute(
		"t",
		// Bracketed so an unset variable is still observable as an empty value.
		{ command: 'echo "id=[$PI_SESSION_ID] file=[$PI_SESSION_FILE]"' },
		undefined,
		undefined,
		ctx as never,
	);
	return getText(result);
}

describe("bash session environment", () => {
	it("exports PI_SESSION_ID and PI_SESSION_FILE from the session manager", async () => {
		const output = await runEcho({
			sessionManager: {
				getSessionId: () => "session-abc",
				getSessionFile: () => "/tmp/session-abc.jsonl",
			},
		});

		expect(output).toContain("id=[session-abc]");
		expect(output).toContain("file=[/tmp/session-abc.jsonl]");
	});

	// The typed contract requires a session manager, but SDK embedders and untyped
	// extension hosts can pass a partial context. Session metadata is decoration —
	// losing it must not fail the command with a TypeError.
	it("still runs when the context carries no session manager", async () => {
		const output = await runEcho({});

		expect(output).toContain("id=[]");
		expect(output).toContain("file=[]");
	});

	it("still runs when the session manager is missing methods", async () => {
		const output = await runEcho({ sessionManager: {} });

		expect(output).toContain("id=[]");
		expect(output).toContain("file=[]");
	});
});
