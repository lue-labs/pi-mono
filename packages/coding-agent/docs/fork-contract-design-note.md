# Fork contract (design note)

**Status: design conclusion, not implemented.** This note records what a fork means and why.
It does not describe current code. The mechanics of the existing implementation are in
[`fork-cache-architecture.md`](./fork-cache-architecture.md).

## What a fork is

A fork is the parent continuing itself down one path.

The child is the same agent, with the same knowledge and the same authority. It splits off,
does one piece of work, and returns. It is not a delegate. It is not a narrower helper. It is
the caller, later, on a branch.

Everything else follows from that sentence.

## What a fork inherits

A fork inherits all of it: the transcript, the system prompt, the tool set, the model, and the
thinking level. None of these are editable on a fork request.

The reason is definitional, not economic. A child with different tools cannot be the caller
continued, because the caller could do things the child cannot. A child on a different model is
a different reader of the same words. In both cases the correct request is a different agent
with `default` context and a briefing in the prompt, not a fork.

The code already behaves this way in one place. `core/agents/executor.ts:249`
(`forkBypassesProfileTools`) discards the child agent's own tool allow-list when the context
mode is `fork`, so the child receives the parent's tools. That behaviour was implemented. The
rule behind it was never written down, which is why the surrounding logic became eight
unnamed booleans across three functions.

## Why `cwd` is the one legitimate variation

A fork may run in a different working directory. This is the only permitted difference, and it
is consistent rather than exceptional.

Changing the working directory does not change who the child is or what it may do. It changes
where the work lands. The agent keeps every tool and every permission it had; it simply operates
on another copy of the tree. This is how `pi-auto-trees` isolates risky work.

This also answers the case that appears to need a restricted fork. To explore a path without
risk to the main tree, fork into a worktree. Do not remove the child's abilities. Sandbox the
filesystem, not the agent.

`AUTOMATIC_WORKTREE_CWD` in `core/agents/executor.ts:942` already marks this case.

## The second kind of reuse

Two distinct forms of prefix reuse exist, and conflating them produced most of the confusion.

**Whole-conversation reuse** is `fork`. The child reuses the parent's transcript. It depends on
the parent, and any edit destroys it.

**Header-only reuse** is `default`. The child starts a fresh conversation but reuses the system
prompt, the tools, and the skills. It does not depend on the parent at all. It shares with its
siblings. Five children spawned together write the header once and read it four times, whatever
model they run on.

The two lanes therefore need opposite handling. A fork with an edit is a misunderstanding, so
refuse it. A `default` child with a different header is ordinary, so accept it silently — that
child simply forms its own sharing group.

`isCacheCompatibleGeneral` in `core/agents/executor.ts:949` is header-only reuse. It sits beside
the fork condition and reads as one mechanism. It is a second, independent one.

## Mechanical facts the contract rests on

These are properties of Anthropic prompt caching, not choices.

1. A cache entry matches a byte prefix from position zero. Truncating the end of a history is
   still a valid prefix, so cutting a conversation short stays cheap. Selecting parts from the
   middle produces new bytes, so a curated context costs more than a full fork.
2. The tool list precedes the messages in the request. Narrowing tools therefore breaks the
   match before the transcript is reached. A fork with narrowed tools re-bills the entire
   conversation. It is the largest possible payload at zero discount.
3. Cache entries are per model. A fork on a different model shares nothing with its parent.
4. A `model:resolve` hook can replace the model after the request is validated
   (`core/agents/executor.ts:1161`). Declaration alone cannot guarantee the lane. One runtime
   check must remain, and on drift the run must fall back to a fresh lane rather than claim a
   discount it did not receive.

## What was rejected

**A cut point expressed as "last N turns."** Turn counts are a poor handle. A named marker plus
an entry id identifies the same place unambiguously and survives editing above it.

**A `summary` context mode.** It fails on both branches. Producing a summary needs a compaction
pass, which is an extra model call. Receiving a summary means the caller already wrote it, and a
caller who has written it can put it in the prompt. The four existing modes stay four.

**A separate `fork_from` mode.** Redundant. An optional cut-point argument on `fork` covers it,
and the mode list stays at `default | fork | slim | none`.

**Slug resolution owned by an extension.** The core stores entries with ids. It can resolve a
name against those entries in roughly ten lines, which keeps the feature working in plain `pi`.
A fork feature does not need to teach shared code a new concept for this.

**Refusing a fork because it would be expensive.** This was wrong and was corrected. Cost is not
a capability limit. The refusal is justified by what a fork is, not by what it bills. The
distinction matters, because the two arguments permit different things.

**Computing the lane from request shape.** The original proposal derived the lane in a pure
function. The decision belongs to the caller instead. The caller declares intent in the tool
schema (`core/tools/agent.ts:66`), and the executor keeps only the facts it must check.

## Why this is worth writing down

The invariant is that a child's request prefix is byte-identical to its parent's. That invariant
currently has no interface. It is an emergent property of scattered conditions, so it can only be
tested from outside, by comparing raw prompt strings through a faux provider. That costs 1,699
lines across three test files.

If a run reports the lane it received, the invariant gains a name and a test surface. Most of
those 1,699 lines reduce to one assertion per case.

## Open decision

Where the selected lane appears in the TUI. The recommendation is: expanded run details always,
and the footer line only when a run received no reuse at all. A `reuse: header` line on every
child is noise. A `reuse: none` line on the one run that got it wrong is worth the interruption.
The rendering seam is `core/agents/status.ts`, beside the existing model label.
