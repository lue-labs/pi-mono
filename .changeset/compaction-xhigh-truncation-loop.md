---
"@lue-labs/pi-ai": patch
"@lue-labs/pi-coding-agent": patch
---

Stop the high/xhigh truncation + failed compact-and-retry loop near a full context window.

- `clampMaxTokensToContext` no longer floors the output cap at 1 token. When the context estimate leaves less than `MIN_ANSWER_TOKENS` of room, the caller's cap is passed through so the provider adjudicates (a real window returns a detectable context-overflow error; a route with a wider real window succeeds). Previously every request past `contextWindow - 4096` — including the compaction summary used to recover — went out with `max_tokens: 1` and came back as a 1-token `length` stop, so overflow recovery could never succeed (202 consecutive 1-token turns observed on `clawrouter/claude-fable-5-1-200k`).
- `isContextOverflow` recognizes Anthropic's "input length and `max_tokens` exceed context limit" error, so that pass-through routes to compaction like "prompt is too long".
- Re-port fork #509 (dropped by the 0.99.0 re-base): persisted compaction checkpoints request reasoning off instead of inheriting the session's high/xhigh effort, which on adaptive Claude has no budget cap and could consume the whole `0.8 x reserveTokens` summary allocation ("generation hit the token cap").
