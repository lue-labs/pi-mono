import type { ThinkingLevel } from "@lue-labs/pi-agent-core";
import type { Api, Model, Usage } from "@lue-labs/pi-ai";

export type AgentSource = "builtin" | "user" | "project";
export type ContextMode = "default" | "fork" | "slim" | "none";
export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type AgentToolMode = "single" | "parallel" | "chain";
export type AgentToolStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type AgentOutputMode = "inline" | "file" | "both";
export type AgentScope = "user" | "project" | "both";
export type AgentToolList = string[] | "*";
export type AgentThinkingLevel = ThinkingLevel | "inherit";
export type AgentModelPreference = string | "inherit";
export type AgentCacheProfile = "normal" | "stable";

/**
 * Default model/thinking selection for a child agent, sourced from
 * settings.subagents.defaults and settings.subagents.providers[<parent.provider>].
 * Sits between the agent definition's own picks and parent inheritance.
 */
export interface AgentDefaultSelection {
	model?: string;
	thinking?: AgentThinkingLevel;
}

export interface AgentDefinition {
	id: string;
	description: string;
	prompt: string;
	source: AgentSource;
	path?: string;
	/**
	 * Child-session tool allow-list. Declared names may target deferred or extension
	 * tools that are registered only inside the child; unavailable names are ignored.
	 */
	tools?: AgentToolList;
	denyTools?: string[];
	model?: AgentModelPreference;
	thinking?: AgentThinkingLevel;
	defaultContext?: ContextMode;
	cacheProfile?: AgentCacheProfile;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
}

export interface AgentLoadDiagnostic {
	level: "warning" | "error";
	message: string;
	path?: string;
}

export interface AgentRegistry {
	agents: AgentDefinition[];
	diagnostics: AgentLoadDiagnostic[];
	projectAgentsDir?: string;
}

export interface AgentTaskConfig {
	agent: string;
	task: string;
	description?: string;
	/** Hide an internal background run from user-facing task surfaces. */
	hidden?: boolean;
	context?: ContextMode;
	extraContext?: string;
	model?: string;
	/** Explicit per-call subset of the parent's currently active tools. */
	tools?: string[];
	thinking?: ThinkingLevel;
	/**
	 * Cap the child session's output token limit to this value. Useful for cheap
	 * condensation forks where the expected output is small and runaway generation
	 * wastes tokens. Clamped to the model's own hard cap — can only lower, never
	 * raise it.
	 */
	maxOutputTokens?: number;
	/**
	 * Hard cap on the child's assistant turns. When reached, the child loop stops
	 * before another LLM call — a safety bound for runaway agentic forks (mirrors
	 * Claude Code's `query({ maxTurns })`). Undefined = unbounded.
	 */
	maxTurns?: number;
	/**
	 * Hand-built system prompt that fully replaces the auto-built one for this
	 * child run. When set, tools/agent-append/project-context/skills/date/cwd are
	 * NOT auto-injected — the caller owns every byte of the prefix.
	 *
	 * Used by extension-launched forks (`ctx.forkAgent({ systemPrompt })`) that
	 * want byte-stable cross-cwd cache reuse. Per-call dynamic data must move
	 * into the user `task` text instead.
	 */
	systemPrompt?: string;
	/**
	 * Verbatim metadata surfaced on the child's `session_start` event as
	 * `forkMetadata`. Set by `ctx.forkAgent({ metadata })`; lets the launching
	 * extension correlate the fork with per-call state from inside the child.
	 */
	forkMetadata?: Record<string, unknown>;
	/**
	 * Override the child session's working directory (e.g. a git worktree) for
	 * isolation. Defaults to the parent's cwd. Set by `ctx.forkAgent({ cwd })`.
	 */
	cwd?: string;
	output?: string;
	outputMode?: AgentOutputMode;
}

export interface NormalizedAgentTaskConfig extends AgentTaskConfig {
	context: ContextMode;
	outputMode: AgentOutputMode;
}

export interface ResolvedContextPolicy {
	mode: ContextMode;
	includeTranscript: boolean;
	includeProjectContext: boolean;
	includeSkills: boolean;
	includeAppendSystemPrompt: boolean;
}

export interface AgentToolCallSummary {
	name: string;
	argsPreview?: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
	resultPreview?: string;
}

export interface AgentSkillInvocationSummary {
	count: number;
	names: string[];
}

export interface AgentRunDetails {
	agent: string;
	source: AgentSource;
	task: string;
	description?: string;
	status: AgentRunStatus;
	/** Epoch ms when this child run started; used by task panels to render child rows. */
	startedAt?: number;
	context: ResolvedContextPolicy;
	model?: { provider: string; id: string; name?: string };
	thinking?: ThinkingLevel;
	warnings?: string[];
	effectiveTools: string[];
	deniedTools: string[];
	durationMs: number;
	toolCallCount: number;
	messageCount: number;
	currentToolName?: string;
	currentToolArgsPreview?: string;
	recentToolCalls: AgentToolCallSummary[];
	recentOutputSnippets: string[];
	loadedSkills: string[];
	invokedSkills: AgentSkillInvocationSummary;
	sessionId?: string;
	sessionPath?: string;
	outputPath?: string;
	usage?: Usage;
	error?: string;
	finalOutput?: string;
	rawOutput?: string;
}

export interface AgentToolDetails {
	mode: AgentToolMode;
	status: AgentToolStatus;
	runs: AgentRunDetails[];
	runId?: string;
	background?: boolean;
	resumable?: boolean;
	/** True only when a persistent run completed a turn and intentionally parked. */
	parked?: boolean;
	message?: string;
	concurrency?: number;
	chainDir?: string;
}

export interface AgentExecutionProgress {
	mode: AgentToolMode;
	status: AgentToolStatus;
	runs: AgentRunDetails[];
	/** True only when a persistent run completed a turn and intentionally parked. */
	parked?: boolean;
	concurrency?: number;
	chainDir?: string;
}

/**
 * Structured lifecycle payload for a background agent run. Pushed to the
 * parent session when the run reaches a terminal status or a persistent run
 * intentionally parks between turns, so the parent doesn't have to poll.
 *
 * Shape parallels Claude Code's <task_notification> block (task_id, status,
 * summary, result, output_file, usage) — enough for the model to act on
 * without further lookups.
 */
export interface AgentBackgroundCompletion {
	runId: string;
	status: AgentToolStatus | "idle";
	/** True when a persistent run intentionally parked between turns. */
	parked?: boolean;
	mode: AgentToolMode;
	agents: string[];
	tasks: string[];
	summary: string;
	/** Final assistant text from the child (truncated to a reasonable size by emitter). */
	result?: string;
	/** Path(s) the child wrote results to, if any (writeAgentOutput target). */
	outputPaths: string[];
	/** Per-child session jsonl paths — for on-demand inspection without polling status. */
	sessionPaths: string[];
	error?: string;
	durationMs?: number;
	totalTokens?: number;
	toolCallCount?: number;
}

export interface AgentModelSelection {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
}
