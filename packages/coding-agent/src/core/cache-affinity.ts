import { createHash } from "node:crypto";
import type { Context, Model } from "@lue-labs/pi-ai";

function hashStableJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 24);
}

function normalizeModelFamily(model: Model<any>): string {
	if (model.provider === "openai-codex") return "codex";
	return model.id;
}

/**
 * Stable provider-visible prompt-cache affinity shared by normal turns and cache heartbeats.
 *
 * The key intentionally excludes session id, cwd, and exact Codex model id. OpenAI/Codex
 * receives the concrete model separately; the prompt cache key should describe the stable
 * provider-visible prefix shape so fresh sessions and same-family Codex models can share
 * a warmed static prefix.
 */
export function createPromptCacheAffinityKey(
	model: Model<any>,
	context: Pick<Context, "systemPrompt" | "tools">,
): string {
	const digest = hashStableJson({
		provider: model.provider,
		family: normalizeModelFamily(model),
		systemPrompt: context.systemPrompt ?? "",
		tools: context.tools ?? [],
	});
	return `pi:${model.provider}:${normalizeModelFamily(model)}:${digest}`;
}
