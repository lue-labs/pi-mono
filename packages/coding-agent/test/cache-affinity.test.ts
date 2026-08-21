import type { Context, Model } from "@lue-labs/pi-ai";
import { describe, expect, it } from "vitest";
import { createPromptCacheAffinityKey } from "../src/core/cache-affinity.ts";

// createPromptCacheAffinityKey only reads provider + id off the model.
function model(provider: string, id: string): Model<any> {
	return { provider, id, name: id } as unknown as Model<any>;
}

function ctx(systemPrompt: string, tools: unknown[]): Pick<Context, "systemPrompt" | "tools"> {
	return { systemPrompt, tools } as Pick<Context, "systemPrompt" | "tools">;
}

const SYS = "You are a helpful agent.";
const TOOLS = [{ name: "read" }, { name: "bash" }];

describe("createPromptCacheAffinityKey", () => {
	// Invariant (b): every entry path (SDK, interactive, heartbeat, model-switch) computes
	// the same key for the same prefix. Since all paths now call this one function with the
	// real {systemPrompt, tools}, path-agnosticism reduces to determinism on that input.
	it("is deterministic for the same model + prefix shape", () => {
		const m = model("openai-codex", "gpt-5.5");
		expect(createPromptCacheAffinityKey(m, ctx(SYS, TOOLS))).toBe(createPromptCacheAffinityKey(m, ctx(SYS, TOOLS)));
	});

	// Invariant: the key describes the provider-visible prefix shape, not session/cwd identity.
	// cwd and sessionId are no longer accepted as arguments, so equal-prefix requests from
	// different cwds/sessions share one warmed key.
	it("ignores cwd and sessionId (not part of the input)", () => {
		const m = model("anthropic", "claude-opus-4-8");
		// Identical prefix, computed as two independent "sessions" — must match byte-for-byte.
		const sessionA = createPromptCacheAffinityKey(m, ctx(SYS, TOOLS));
		const sessionB = createPromptCacheAffinityKey(m, ctx(SYS, TOOLS));
		expect(sessionA).toBe(sessionB);
	});

	// Invariant (a): Codex models are family-normalized — same-family ids share one key so a
	// fresh session or a sibling Codex model reuses the warmed static prefix.
	it("normalizes all openai-codex model ids to one family", () => {
		const a = createPromptCacheAffinityKey(model("openai-codex", "gpt-5.5"), ctx(SYS, TOOLS));
		const b = createPromptCacheAffinityKey(model("openai-codex", "gpt-5.4-mini"), ctx(SYS, TOOLS));
		expect(a).toBe(b);
		expect(a.startsWith("pi:openai-codex:codex:")).toBe(true);
	});

	// Non-codex providers stay keyed by exact model id (caches are per-model on Anthropic).
	it("keys non-codex providers by exact model id", () => {
		const a = createPromptCacheAffinityKey(model("anthropic", "claude-opus-4-8"), ctx(SYS, TOOLS));
		const b = createPromptCacheAffinityKey(model("anthropic", "claude-sonnet-4-6"), ctx(SYS, TOOLS));
		expect(a).not.toBe(b);
		expect(a.startsWith("pi:anthropic:claude-opus-4-8:")).toBe(true);
	});

	// The key must move when the cached prefix moves.
	it("changes when systemPrompt or tools change", () => {
		const m = model("openai-codex", "gpt-5.5");
		const base = createPromptCacheAffinityKey(m, ctx(SYS, TOOLS));
		expect(createPromptCacheAffinityKey(m, ctx(`${SYS} extra`, TOOLS))).not.toBe(base);
		expect(createPromptCacheAffinityKey(m, ctx(SYS, [...TOOLS, { name: "edit" }]))).not.toBe(base);
	});

	// Regression: passing a bare cwd string (the pre-fix interactive bug) collapsed the key to a
	// constant per family because a string has no systemPrompt/tools. Real context must NOT
	// produce that degenerate key — proves the interactive path now tracks the prefix.
	it("does not collapse to the empty-prefix key for real context", () => {
		const m = model("openai-codex", "gpt-5.5");
		const empty = createPromptCacheAffinityKey(m, ctx("", []));
		const real = createPromptCacheAffinityKey(m, ctx(SYS, TOOLS));
		expect(real).not.toBe(empty);
	});
});
