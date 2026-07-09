# Fork-Mode Sub-Agent Cache Architecture

How Pi gets sub-agents to share Anthropic prompt cache with their parent — and
with each other — when spawned in fork mode.

Date: 2026-05-28. Mirrors Claude Code 2.1.x patterns; see comparison at the
bottom.

## TL;DR

Fork-mode sub-agents (default for the `worker` agent; opt-in via
`context: "fork"` for any agent) inherit the **byte-identical** prompt prefix of
their parent:

1. **System prompt**: parent's already-rendered bytes are threaded via
   `getParentSystemPrompt()` and applied with `session.overrideBaseSystemPrompt`.
   Never re-rendered (re-rendering can drift if feature flags warm up between
   parent's render and child's spawn).
2. **Tools[]**: parent's exact active-tool list is copied 1:1 with no
   `GLOBAL_DENY_TOOLS` filtering (`executor.ts` `isForkMode` branch). Tool
   schemas must be byte-identical for cache hits.
3. **Message history**: parent's full message stream is preserved by
   `getFilteredForkMessages`. Any `tool_use` block without a matching
   `tool_result` (denied, in-flight, or sibling-fork placeholder) is followed
   by a **fixed-bytes placeholder** `tool_result` so the leading blocks stay
   byte-identical across every fork child.
4. **Thinking config / model**: inherited from parent via
   `resolveAgentThinking(parentThinkingLevel)` and `model: "inherit"`. Both
   affect the API request shape; mismatches bust cache.
5. **Recursion guard**: the `agent` tool stays in the child's tool list (so the
   schema stays cache-identical), but a `<system-reminder>` block prepended to
   the child's task message tells it not to delegate. Same pattern as CC's
   `CHILD_AGENT_REMINDER` / fork boilerplate tag.

The only divergence is the per-child user directive (built by
`buildChildTaskPrompt`), placed at the very tail of the request — so the entire
leading prefix is a cache hit.

## Why placeholder, not strip

Pre-2026-05-28, `getFilteredForkMessages` stripped parent `agent` / `subagent`
`tool_use` blocks and their `tool_result`s from the fork child's history. The
intent was "don't show the child its parent's delegation history." The cost:

- Anthropic prompt cache keys on the **full request prefix**.
- If parent's cached prefix included an `agent` tool_use at message N, and the
  child's request had that block stripped, every block from N onward diverges
  byte-for-byte from the parent's cache key.
- The child's first request paid a full cache write instead of a cache hit on
  N-1 blocks of prior history.

The new strategy keeps the parent's `tool_use` blocks **in place** and supplies
a fixed-bytes placeholder `tool_result` for any that lack one in the stream:

```ts
const FORK_PLACEHOLDER_RESULT_TEXT = "Sibling agent task in progress.";
```

Identical bytes → identical hash → cache hit.

## Sibling parity (the multi-fork case)

When the parent fan-outs to N parallel forks via `tasks[]`:

- Each child calls `getFilteredForkMessages(parentSession)`.
- All N children see the same set of unresolved `tool_use` IDs (the fan-out
  calls themselves).
- All N children synthesize the same placeholder text for those calls.
- Result: every child's API request prefix is byte-identical through every
  leading block. **Siblings cache-hit off each other**, not just off parent.

This is the single biggest token-efficiency win for parallel sub-agent work.
Without sibling parity, N parallel forks pay N × (parent prefix) in cache
writes. With parity, only the first child pays the write; the rest hit.

Regression invariant: `JSON.stringify(getFilteredForkMessages(s)) ===
JSON.stringify(getFilteredForkMessages(s))` for any session `s`. Test:
`agent-context-inheritance.test.ts` → "sibling forks produce byte-identical
message arrays".

## Cache-share matrix (per built-in agent)

| Agent | `defaultContext` | System prompt source | Tools | Cache strategy |
|---|---|---|---|---|
| `worker` | `fork` | Parent's rendered bytes | Parent's 1:1 | **Shares prefix with parent + siblings** |
| `general` | `default` | Own dedicated | Resolved from agent def | Own cache, no parent share |
| `explore` | `none` | Own + `cacheProfile: "stable"` | Child-scoped read-only allow-list; installed optional search tools activate | **Stable bytes for a fixed extension set → hits across explore invocations cluster-wide** |
| `decompose` | `none` | Own + `cacheProfile: "stable"` | Read-only subset | Same as explore |
| `plan` | `slim` | Own | Read-only subset | Own cache |
| `reviewer` | `default` | Own | Defined per agent | Own cache |

Two distinct strategies coexist:

1. **Fork-share** (`worker`): inherit parent's bytes 1:1, cache-hit on every
   leading block.
2. **Stable-profile** (`explore`, `decompose`): byte-identical own system
   prompt across every invocation regardless of caller / cwd → cheap-model
   sub-agents get cache hits across the whole session/day even though their
   prefix doesn't match parent's.

## Bytes that must NOT vary across forks

When debugging cache-miss-on-fork, audit each in order. Any drift = cache bust.

- **System prompt bytes** — threaded from parent's frozen turn-start prompt,
  not re-rendered. See `getParentSystemPrompt()` in `core/tools/agent.ts:138`.
- **Tools[] order and definitions** — copied 1:1, no permission-mode
  re-resolution. Tool-schema serialization is sensitive to permission-mode
  (CC explicitly documents this in `AgentTool.tsx:612`).
- **Thinking config** — inherited via `resolveAgentThinking`. Mismatched
  thinking levels produce different API request shapes.
- **Model** — `"inherit"` keeps the same model id; switching model busts
  everything.
- **Placeholder tool_result text** — `FORK_PLACEHOLDER_RESULT_TEXT` is a
  module-level const. Do not parameterize per-child or per-spawn.
- **Placeholder tool_result structure** — single text content block,
  `isError: false`. Adding fields (e.g. metadata) would diverge.

## Bytes that CAN vary

- **Per-child user directive** at the very tail (built by
  `buildChildTaskPrompt`). This is the only intentional divergence point.
- **Placeholder `timestamp`** — set to a fixed `0` in the placeholder for
  belt-and-braces, but `timestamp` is not serialized to the Anthropic wire for
  `tool_result` blocks anyway.
- **`toolName` on the placeholder** — pulled from the original `tool_use`'s
  name, so it varies by call but is identical across siblings (they see the
  same parent tool_uses).

## Recursion guard

Fork children keep the `agent` tool in their tool list because removing it
would change tool schemas and bust cache. The guard is **prompt-level**:

1. `buildChildTaskPrompt` prepends `CHILD_AGENT_REMINDER` (a
   `<system-reminder>` block) to the child's user-message directive telling it
   not to delegate.
2. (Future) `querySource` tagging on `ctx.options` survives autocompact, can
   be checked at agent-tool call time. Pi today relies on the prompt-level
   reminder; if a child ignores it and tries to call `agent`, the
   `denyTools: ["agent"]` runtime check in non-fork mode catches recursive
   attempts. For fork mode the prompt reminder is currently the primary
   guard — mirror of CC's `isInForkChild` message-scan fallback when needed.

## Comparison: Claude Code 2.1.x

Pi's implementation explicitly mirrors CC. Key correspondences (CC source
mirror at `~/Projects/oss/claude-code-cli-src-code/src/tools/AgentTool/`):

| Pi | Claude Code |
|---|---|
| `executor.ts` `isForkMode` branch | `AgentTool.tsx` `isForkPath` + `useExactTools: true` |
| `getParentSystemPrompt()` (frozen at turn-start) | `toolUseContext.renderedSystemPrompt` |
| `getFilteredForkMessages` + placeholder substitute | `buildForkedMessages` + `FORK_PLACEHOLDER_RESULT` |
| `FORK_PLACEHOLDER_RESULT_TEXT = "Sibling agent task in progress."` | `FORK_PLACEHOLDER_RESULT = "Fork started — processing in background"` |
| `CHILD_AGENT_REMINDER` `<system-reminder>` | `CHILD_AGENT_REMINDER` / `FORK_BOILERPLATE_TAG` |
| `worker` agent default | `FORK_AGENT` (synthetic, triggered by `!subagent_type` when `FORK_SUBAGENT` flag enabled) |
| `cacheProfile: "stable"` for `explore`/`decompose` | `omitClaudeMd: true` + drop gitStatus for Explore/Plan (saves 5–15 Gtok/wk fleet-wide per CC's measurements) |

What CC does that Pi doesn't (open follow-ups):

- **`querySource` threading** on `ctx.options` (survives autocompact). Pi's
  prompt-level reminder is sufficient today but a defense-in-depth runtime
  check would catch models that ignore the system-reminder. Worth adding when
  we see evidence of a model bypassing the guard.
- **Background-summarization cache-safe params** (`onCacheSafeParams` in CC).
  Pi doesn't have background summarization yet.

What Pi does that CC doesn't:

- **Explicit `cacheProfile: "stable"`** as a first-class agent property. CC
  achieves the same via `omitClaudeMd` flags and hardcoded list of agents.
- **`context` modes (`default` / `fork` / `slim` / `none`)** exposed as
  user-facing knobs on the agent tool call. CC's fork mode is gated by an
  internal feature flag.

## Files

- `packages/coding-agent/src/core/agents/context.ts` —
  `getFilteredForkMessages`, `substitutePlaceholdersForUnresolvedToolCalls`,
  `FORK_PLACEHOLDER_RESULT_TEXT`, `CHILD_AGENT_REMINDER`,
  `buildChildTaskPrompt`, `resolveContextPolicy`.
- `packages/coding-agent/src/core/agents/executor.ts` — `isForkMode` branch,
  `parentSystemPrompt` threading, message assignment.
- `packages/coding-agent/src/core/tools/agent.ts` — `getParentSystemPrompt`,
  `getParentActiveTools` capture at parent turn-start.
- `packages/coding-agent/test/agent-context-inheritance.test.ts` — fork
  filtering, placeholder substitution, sibling byte-identity regression.

## Regression triage

If you see cache misses on fork-mode children where you expect hits:

1. Verify `cache_creation_input_tokens` on parent's last assistant response
   matches the prefix size the child's first request hits — cache eligibility
   gate.
2. Diff parent's wire-level request bytes against child's first request (use
   `pi-claude-bridge` cache diagnostics). The first differing byte is the
   suspect.
3. Common culprits in order of likelihood:
   - Tool schema drift (extension registered a new tool after parent's
     turn-start render but before child spawn).
   - System prompt drift (some extension's `before_agent_start` mutated the
     prompt for the parent's next render in a way that affected the captured
     bytes — see `tool-search` per-session state keying for the prior bug
     class).
   - Placeholder text mismatch (someone edited `FORK_PLACEHOLDER_RESULT_TEXT`
     without bumping the cache-busting cohort — don't edit it lightly).
   - Model id mismatch (`model: "inherit"` resolving to a different concrete
     model — e.g. provider routing change).
   - Thinking config drift (child not inheriting parent's level).
