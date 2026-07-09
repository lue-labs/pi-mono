// Fork-owned module (fork-delta reforge slice 3): ctx.forkAgent + ctx.transcript API types
// moved verbatim from types.ts. Re-exported from types.ts for import compat.

import type { AgentToolDetails, AgentToolStatus } from "../agents/types.ts";

// ============================================================================
// Fork Agent (ctx.forkAgent)
// ============================================================================

/**
 * Handle returned by `ctx.forkAgent()` for cooperative control over a background
 * child agent run.
 */
export interface AgentHandle {
	/**
	 * Resolve with the run's terminal details. Resolves for cancelled, failed,
	 * and interrupted runs too — those are normal terminal states, not errors.
	 * Rejects only on internal lookup errors (e.g. run id evicted from history).
	 */
	wait(): Promise<AgentToolDetails>;
	/**
	 * Cooperative abort. Cancels the underlying recent-run controller, which
	 * aborts every active child session within ~1s. Resolves once the run
	 * reaches a terminal status.
	 */
	abort(): Promise<void>;
	/**
	 * Feed a new prompt into the (possibly idle) background run. Waits for any
	 * in-flight turn to finish, then relaunches the SAME session with `message`
	 * as the next user turn — the run's conversation history is preserved, so a
	 * long-lived fork accumulates context across successive resumes (unlike
	 * `forkAgent`, which always starts a fresh session). Rejects if the run is
	 * not resumable (id evicted, or a terminal state the controller can't
	 * restart). Thin wrapper over the same `resumeAgentRecentRun` path the
	 * `agent` control tool uses.
	 */
	resume(message: string): Promise<void>;
	/**
	 * Steer a message into the run's active child session mid-turn (queued after
	 * the current tool calls, before the next model call). Rejects if the run
	 * has no active session to receive it (idle or terminal) — use `resume` to
	 * feed an idle run. Thin wrapper over `injectAgentRecentRun`.
	 */
	inject(message: string): Promise<void>;
	/** Snapshot of the current run status. */
	readonly status: AgentToolStatus;
}

/** Options for `ctx.forkAgent()`. */
export interface ForkAgentOptions {
	/** First user message delivered to the forked agent. */
	prompt: string;
	/**
	 * Restrict the child's tool surface to a subset of the parent's active
	 * tools. Omit to inherit the parent's full active tool list.
	 */
	allowedTools?: string[];
	/**
	 * Model identifier (e.g. `"anthropic/claude-sonnet-4-5"`). Defaults to the
	 * parent's current model — required for cache-preserving forks. Passing a
	 * different model voids the cached prefix and incurs a full reprocess.
	 */
	model?: string;
	/**
	 * Child context inheritance. Controls how much of the parent's session bleeds
	 * into the child's system prompt — and therefore how cache-stable the child's
	 * prefix is across invocations.
	 *
	 * - `"fork"` (default): inherit parent's full system prompt + transcript.
	 *   Maximum cache reuse with the parent's current API request, but the
	 *   prefix changes whenever the parent's prompt does (CLAUDE.md edits, skill
	 *   load, project context). Use when the child needs the parent's full
	 *   working context.
	 * - `"slim"`: drop parent's project context (CLAUDE.md cascade), skills, and
	 *   transcript. Child gets a fresh minimal prefix built from base prompt +
	 *   tools list + agent-append. Stable across invocations of the same agent
	 *   from the same cwd on the same day → cross-session cache hits for
	 *   recurring extension forks.
	 * - `"none"`: same as `"slim"` but also drops the agent-append block. Use
	 *   only when the caller is supplying its own complete `systemPrompt`.
	 */
	context?: "fork" | "slim" | "none";
	/**
	 * Hand-built system prompt that fully replaces the auto-built one for the
	 * child session. When set, tools list, agent-append, project context,
	 * skills, date, and cwd are NOT auto-injected — the caller owns every byte
	 * of the prefix.
	 *
	 * Use this for cross-cwd cache stability: identical bytes across every
	 * project-rooted call → one warm Anthropic cache entry shared by all
	 * sessions, every project. Per-call dynamic data (slug, ids, file lists)
	 * must move into `prompt` (the user message) instead.
	 *
	 * Mirrors Claude Code's Task tool, which lets the launcher pass a fully
	 * pre-built `systemPrompt` to the spawned subagent.
	 */
	systemPrompt?: string;
	/** Abort signal chained with `ctx.signal`. */
	signal?: AbortSignal;
	/**
	 * Detach the fork from the parent session's abort signal. By default the
	 * fork's effective signal is `AbortSignal.any([opts.signal, parent.signal])`,
	 * so `AgentSession.dispose()` / `agent.abort()` cancels an in-flight fork.
	 *
	 * When true, the parent signal is NOT chained in — only `opts.signal` (if
	 * any) governs the fork. Use for best-effort background work that must survive
	 * a session replacement/dispose and is instead bounded by the caller's own
	 * drain (e.g. pi-memory turn-end extraction flushed on `session_shutdown`).
	 * Additive and opt-in: default (unset/false) preserves prior behaviour.
	 */
	detachFromParent?: boolean;
	/**
	 * Keep the forked agent alive across turns as a long-lived, launcher-fed
	 * background run. When true, the fork parks after each turn (retaining its
	 * controller and a resumable, disk-persisted session) instead of terminating;
	 * feed it the next turn with `handle.resume(message)`, which reloads the
	 * persisted session so conversation history accumulates across turns. Retire
	 * it with `handle.abort()`. Default (unset) terminates on completion as before.
	 *
	 * Use for stateful background helpers that observe/assist over many turns
	 * (e.g. a paired observer agent fed per-turn activity digests).
	 */
	persistent?: boolean;
	/** Short human label for logs/UI. */
	description?: string;
	/**
	 * When true (default), suppresses the `agent_completion` transcript
	 * notification for this fork. Extension-initiated forks (e.g. pi-memory
	 * extraction) should stay silent — the extension owns any transcript
	 * feedback via `ctx.transcript.append`. Set to false to restore the
	 * standard background-agent completion message.
	 */
	silent?: boolean;
	/**
	 * Cap the forked agent's output token limit. Useful for cheap single-task
	 * forks (e.g. condensation, summarisation) where the expected output is
	 * small and runaway generation wastes tokens. Clamped to the model's own
	 * hard cap — can only lower, never raise it.
	 */
	maxOutputTokens?: number;
	/**
	 * Hard cap on the forked agent's assistant turns. When reached, the child loop
	 * stops before another LLM call — a safety bound for runaway agentic forks
	 * (mirrors Claude Code's `query({ maxTurns })`). Undefined = unbounded.
	 */
	maxTurns?: number;
	/**
	 * Arbitrary metadata forwarded verbatim to the forked child's
	 * `SessionStartEvent.forkMetadata`. Lets the launching extension correlate a
	 * fork with per-call state (e.g. a structured-output schema id) so it can
	 * react inside the child — register a tool, gate a hook — without baking that
	 * logic into core. Not sent to the model; keep the bytes stable per caller if
	 * the child uses it to build cache-relevant state.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Override the child session's working directory. Defaults to the parent's
	 * cwd. Used for isolation (e.g. running a subagent inside a git worktree) so
	 * the child's resource discovery, tools and writes are scoped to that dir.
	 */
	cwd?: string;
	/**
	 * Route the fork through a named agent definition (e.g. `"explore"`,
	 * `"reviewer"`, `"plan"`) — the same registry the built-in `agent` tool uses.
	 * When set, the child inherits that agent's tools/denyTools, model, thinking
	 * level, and (for `cacheProfile: "stable"` agents with `context: "none"`) its
	 * stable system-prompt append, exactly as if launched via the agent tool.
	 * Explicit `allowedTools`/`model`/`systemPrompt` still override the
	 * definition. Omit (or `"general"`) for the default general-purpose child.
	 */
	agentType?: string;
}

/** Result of `ctx.forkAgent()`. */
export interface ForkAgentResult {
	/** Control handle for the background run. */
	handle: AgentHandle;
	/**
	 * Stable id for the spawned run. Today this is the parent-side recent-run id
	 * (e.g. `agent-12`); the child's session id only becomes available after
	 * `handle.wait()` resolves (read it off the terminal details there).
	 */
	sessionId: string;
}

// ============================================================================
// Transcript Append (ctx.transcript.append)
// ============================================================================

/**
 * Structured transcript entry surfaced inline in the live transcript.
 *
 * The union is intentionally open — additional kinds will land here as new
 * extension-facing transcript message subtypes are introduced.
 */
export type TranscriptEntry = {
	kind: "memory_saved";
	verb: "Saved" | "Improved";
	paths: string[];
};

/** Transcript API surfaced via `ctx.transcript`. */
export interface TranscriptApi {
	/**
	 * Append a structured system-message-style entry to the live transcript.
	 * Renders inline between user/assistant turns in the interactive TUI, and is
	 * serialized to the session event stream in print/RPC modes.
	 */
	append(entry: TranscriptEntry): void;
}
