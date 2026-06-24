/**
 * openai-codex-responses — native `defer_loading` serialization.
 *
 * Mirrors Codex CLI's `ResponsesApiTool` shape (`codex-rs/tools/src/responses_api.rs`):
 *   - `defer_loading: true` is emitted on the wire for tools with
 *     `deferLoading === true && alwaysLoad !== true`.
 *   - `alwaysLoad: true` suppresses emission even when `deferLoading: true`.
 *   - Plain tools have no `defer_loading` field.
 *   - The vanilla `openai-responses` provider (no `emitDeferLoading` opt-in)
 *     never emits the field.
 *
 * Serialization byte-stability across turns is the prompt-cache guarantee:
 * `defer_loading: true` is constant for a given tool definition, so the
 * tools-array prefix is byte-identical across turns.
 */
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertResponsesTools } from "../src/api/openai-responses-shared.ts";
import type { Tool } from "../src/types.ts";

function tool(name: string, extra: Partial<Tool> = {}): Tool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({}),
		...extra,
	} as Tool;
}

describe("convertResponsesTools — emitDeferLoading (openai-codex)", () => {
	it("emits defer_loading:true for deferLoading tools when opted in", () => {
		const tools: Tool[] = [tool("alpha", { deferLoading: true })];
		const [converted] = convertResponsesTools(tools, { emitDeferLoading: true }) as Array<{
			defer_loading?: boolean;
		}>;
		expect(converted.defer_loading).toBe(true);
	});

	it("alwaysLoad overrides deferLoading (no defer_loading emitted)", () => {
		const tools: Tool[] = [tool("locked", { deferLoading: true, alwaysLoad: true })];
		const [converted] = convertResponsesTools(tools, { emitDeferLoading: true }) as Array<{
			defer_loading?: boolean;
		}>;
		expect(converted.defer_loading).toBeUndefined();
	});

	it("plain tools have no defer_loading field", () => {
		const tools: Tool[] = [tool("plain")];
		const [converted] = convertResponsesTools(tools, { emitDeferLoading: true }) as Array<{
			defer_loading?: boolean;
		}>;
		expect(converted.defer_loading).toBeUndefined();
	});

	it("does not emit defer_loading when emitDeferLoading is not set (vanilla openai-responses)", () => {
		const tools: Tool[] = [tool("alpha", { deferLoading: true })];
		const [converted] = convertResponsesTools(tools) as Array<{ defer_loading?: boolean }>;
		expect(converted.defer_loading).toBeUndefined();
	});

	it("serialization bytes are stable for the same tool across calls", () => {
		const tools: Tool[] = [
			tool("alpha", { deferLoading: true }),
			tool("beta", { deferLoading: true, alwaysLoad: true }),
			tool("gamma"),
		];
		const a = JSON.stringify(convertResponsesTools(tools, { emitDeferLoading: true, deterministic: true }));
		const b = JSON.stringify(convertResponsesTools(tools, { emitDeferLoading: true, deterministic: true }));
		expect(a).toBe(b);
		// And the deferred field appears exactly once (alpha) — beta is alwaysLoad-suppressed.
		expect(a.match(/"defer_loading":true/g)?.length ?? 0).toBe(1);
	});
});
