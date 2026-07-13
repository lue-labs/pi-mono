# Fork-Mode Sub-Agent Cache Architecture

How Pi gets sub-agents to share Anthropic prompt cache with their parent — and
with each other — when spawned in fork mode.

Date: 2026-05-28. Mirrors Claude Code 2.1.x patterns; see comparison at the
bottom.

## TL;DR

Fork-mode sub-agents (default for the `worker` agent; opt-in via
`context: "fork"` for any agent) inherit the **byte-identical** prompt prefix of
their parent unless the caller explicitly supplies a task-level `tools` /
`allowedTools` restriction:

1. **System prompt**: parent's already-rendered bytes are threaded via
   `getParentSystemPrompt()` and applied with `session.overrideBaseSystemPrompt`.
   Never re-rendered (re-rendering can drift if feature flags warm up between
   parent's render and child's spawn).
2. **Tools[]**: by default, the parent's exact active-tool list is copied 1:1
   with no `GLOBAL_DENY_TOOLS` filtering (`executor.ts` `isForkMode` branch).
   An explicit task-level tool restriction intentionally narrows this list,
   prioritizing the caller's capability boundary over a cache hit.
3. **Message history**: parent's full message stream is preserved by
   `getFilteredForkMessages`. Any `tool_use` block without a matching
   `tool_result` (denied, in-flight, or sibling-fork placeholder) is followed
   by a **fixed-bytes placeholder** `tool_result` so the leading blocks stay
   byte-identical across every fork child.
4. **Thinking config / model**: inherited from parent via
   `resolveAgentThinking(parentThinkingLevel)` and `model: "inherit"`. Both
   affect the API request shape; mismatches bust cache.
5. **Depth-aware Agent availability**: the `agent` tool schema stays in the
   fork tool list for cache identity. A trailing `<system-reminder>` states
   whether the configured depth allows another Agent call.

Without an explicit tool restriction, the only divergence is the per-task user
directive (built by `buildChildTaskPrompt`), placed at the very tail of the
request — so the entire leading prefix is a cache hit.

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
const FORK_PLACEHOLDER_RESULT_TEXT = "Another Agent task is in progress.";
```

Identical bytes → identical hash → cache hit.

## Sibling parity (the multi-fork case)

When the parent fan-outs to N parallel forks via `tasks[]`:

- Each child calls `getFilteredForkMessages(parentSession)`.
- All N children see the same set of unresolved `tool_use` IDs (the fan-out
  calls themselves).
- All N children synthesize the same placeholder text for those calls.
- Result: children with the same effective tool restriction have byte-identical
  API request prefixes through every leading block. **Siblings cache-hit off
  each other**, not just off parent.

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
| `worker` | `fork` | Parent's rendered bytes | Parent's 1:1 by default; explicit restriction opts out | **Shares prefix with parent + siblings by default** |
| `general` | `default` | Own dedicated | Resolved from agent def | Own cache, no parent share |
| `explore` | `none` | Own + `cacheProfile: "stable"` | Child-scoped read-only allow-list; installed optional search tools activate | **Stable bytes for a fixed extension set → hits across explore invocations cluster-wide** |
| `decompose` | `none` | Own + `cacheProfile: "stable"` | Read-only subset | Same as explore |
| `plan` | `slim` | Own | Read-only subset | Own cache |
| `reviewer` | `default` | Own | Defined per agent | Own cache |

Two distinct strategies coexist:

1. **Fork-share** (`worker`): inherit parent's bytes 1:1 by default and
   cache-hit on every leading block. Explicit tool restrictions intentionally
   cold-write a narrower tool prefix.
2. **Stable-profile** (`explore`, `decompose`): byte-identical own system
   prompt across every invocation regardless of caller / cwd → cheap-model
   sub-agents get cache hits across the whole session/day even though their
   prefix doesn't match parent's.

## Bytes that must NOT vary across forks

For a fork call without an explicit tool restriction, audit each item in order
when debugging a cache miss. Any drift = cache bust.

- **System prompt bytes** — threaded from parent's frozen turn-start prompt,
  not re-rendered. See `getParentSystemPrompt()` in `core/tools/agent.ts:138`.
- **Tools[] order and definitions** — copied 1:1 unless `tools` /
  `allowedTools` explicitly narrows the task. Tool-schema serialization is
  sensitive to permission-mode (CC explicitly documents this in
  `AgentTool.tsx:612`).
- **Thinking config** — inherited via `resolveAgentThinking`. Mismatched
  thinking levels produce different API request shapes.
- **Model** — `"inherit"` keeps the same model id; switching model busts
  everything.
- **Placeholder tool_result text** — `FORK_PLACEHOLDER_RESULT_TEXT` is a
  module-level const. Do not parameterize per-child or per-spawn.
- **Placeholder tool_result structure** — single text content block,
  `isError: false`. Adding fields (e.g. metadata) would diverge.

## Intentional cache opt-out

An explicit task-level `tools` / `allowedTools` restriction changes the static
tool prefix. This is a deliberate cold-cache path: preserving the requested
capability boundary takes precedence over cache reuse. Calls that need exact
fork cache identity should omit the override and use the inherited tool set.

## Bytes that CAN vary

- **Per-task user directive** at the very tail (built by
  `buildChildTaskPrompt`, or `buildAgentCourseCorrectionPrompt` on resume).
  For an unrestricted fork, this is the only intentional divergence point.
- **Placeholder `timestamp`** — set to a fixed `0` in the placeholder for
  belt-and-braces, but `timestamp` is not serialized to the Anthropic wire for
  `tool_result` blocks anyway.
- **`toolName` on the placeholder** — pulled from the original `tool_use`'s
  name, so it varies by call but is identical across siblings (they see the
  same parent tool_uses).

## Depth-aware Agent availability

Fork tasks keep the `agent` tool schema because removing it would change the
cached tool prefix. `buildChildTaskPrompt` prepends a `<system-reminder>` in the
trailing user message; resumed persistent tasks use
`buildAgentCourseCorrectionPrompt` to restate the currently resolved capability.
Resume re-applies the original fork system-prompt policy and canonical parent-tool
subset; only the trailing course-correction message changes:

1. At the configured depth cap, or when the selected profile filters Agent from
   its effective tools, `AGENT_UNAVAILABLE_REMINDER` says the tool is unavailable
   even if an inherited schema appears and returns follow-up work to the calling
   agent.
2. Below a non-zero cap, the available reminder appears only when Agent remains
   in the effective tool set. It states the exact remaining depth without
   prescribing whether or how the executing model should use it.
3. Non-fork modes remove Agent from the effective tools when the profile or
   depth disallows it. Fork mode keeps the inherited schema for cache identity
   but binds the Agent execution engine only when both the profile and depth
   allow it. `executeAgentTool` also enforces the depth cap on every bound call.

## Comparison: Claude Code 2.1.x

Pi's implementation explicitly mirrors CC. Key correspondences (CC source
mirror at `~/Projects/oss/claude-code-cli-src-code/src/tools/AgentTool/`):

| Pi | Claude Code |
|---|---|
| `executor.ts` `isForkMode` branch | `AgentTool.tsx` `isForkPath` + `useExactTools: true` |
| `getParentSystemPrompt()` (frozen at turn-start) | `toolUseContext.renderedSystemPrompt` |
| `getFilteredForkMessages` + placeholder substitute | `buildForkedMessages` + `FORK_PLACEHOLDER_RESULT` |
| `FORK_PLACEHOLDER_RESULT_TEXT = "Another Agent task is in progress."` | `FORK_PLACEHOLDER_RESULT = "Fork started — processing in background"` |
| trailing depth-aware `<system-reminder>` | `CHILD_AGENT_REMINDER` / `FORK_BOILERPLATE_TAG` |
| `worker` agent default | `FORK_AGENT` (synthetic, triggered by `!subagent_type` when `FORK_SUBAGENT` flag enabled) |
| `cacheProfile: "stable"` for `explore`/`decompose` | `omitClaudeMd: true` + drop gitStatus for Explore/Plan (saves 5–15 Gtok/wk fleet-wide per CC's measurements) |

What CC does that Pi doesn't (open follow-ups):

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
  `FORK_PLACEHOLDER_RESULT_TEXT`, `AGENT_UNAVAILABLE_REMINDER`,
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
