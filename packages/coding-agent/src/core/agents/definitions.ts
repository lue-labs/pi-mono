import type { AgentDefinition } from "./types.ts";

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
	{
		id: "general",
		description:
			"Delegated task execution for children that must write files OR run bash with mutation (rm/mv/git push/npm install/...) OR mix search+edit+verify in one run. For pure read-only investigation use `explore` (now has read-only bash for git log/diff/cat etc.); for scoped implementation with known file paths use `worker`.",
		tools: "*",
		// No denyTools["agent"]: general is the one builtin allowed to nest. Whether it
		// can actually delegate is gated at runtime by `subagents.maxDelegationDepth`
		// (default 0 = no nesting) via the executor's engine-binding depth cap.
		model: "inherit",
		thinking: "inherit",
		defaultContext: "default",
		inheritProjectContext: true,
		inheritSkills: true,
		source: "builtin",
		prompt: `You are a Pi child agent. Complete the delegated task fully without gold-plating.
Search broadly when the location is unclear. Prefer editing existing files over creating new files.
Do not create documentation unless explicitly requested.
Return a concise report with findings, files changed, and validation performed.`,
	},
	{
		id: "worker",
		description: "Implementation worker for scoped coding tasks.",
		tools: "*",
		denyTools: ["agent"],
		model: "inherit",
		thinking: "inherit",
		defaultContext: "fork",
		inheritProjectContext: true,
		inheritSkills: true,
		source: "builtin",
		prompt: `You are a Pi implementation worker. Execute the assigned implementation task in this child context.
Respect the caller's constraints exactly. Make the smallest complete change.
Do not delegate. Do not broaden scope. Report changes, validation, and blockers.`,
	},
	{
		id: "explore",
		description:
			'Fast read-only search agent. PREFER over `general` for any task whose every step is read/grep/find/ls or read-only bash (git log/status/diff/show/blame, cat/head/tail, wc, stat, `gh pr view`/`gh issue view`) — "search for X", "find where Y", "where is Z defined", "how does W work", "which files use V", "explore/investigate/audit the codebase", "map out", "trace", "who changed X", "when was Y introduced". Use it to find files by pattern (eg. `src/components/**/*.tsx`), grep for symbols or keywords, answer "where is X defined / which files reference Y", or inspect git history. Specify breadth in `extraContext`: "quick" for a single targeted lookup, "medium" for moderate exploration, or "very thorough" to search across multiple locations and naming conventions. Runs on a cheap model with no transcript, project context, or skills — brief the agent in `task` and `extraContext` like a smart colleague who just walked in. NOT for: code review (use `reviewer`), design-doc auditing or cross-file consistency analysis (use `plan`), or anything that mutates state (use `general`/`worker`) — mutating bash commands are blocked at the executor.',
		tools: ["read", "grep", "find", "ls", "bash"],
		denyTools: ["agent", "edit", "write"],
		model: "fast",
		thinking: "off",
		defaultContext: "none",
		cacheProfile: "stable",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "builtin",
		prompt: `You are a file search specialist for Pi. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE — NO STATE CHANGES ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating, modifying, deleting, moving, or copying files (including in /tmp)
- Running ANY bash command that mutates state
- Network requests that send data (no POST/PUT/DELETE, no \`git push\`, no \`gh pr create\`, no \`curl -X POST\`)
- Installing packages, starting servers, killing processes, or changing config

You have NO \`edit\` or \`write\` tool — attempts will fail. You DO have \`bash\`, but the executor enforces a deny-list (rm/mv/cp/git push/git commit/npm install/kubectl apply/output redirection/etc.) and will reject mutating commands. Use bash ONLY for read-only inspection.

You get only the task text and any Additional context the parent passes. You do not receive the parent transcript, project instructions, or skills by default. Treat the brief as complete.

Allowed bash (examples):
- Git inspection: \`git status\`, \`git log\`, \`git diff\`, \`git show\`, \`git blame\`, \`git rev-parse\`, \`git ls-files\`
- File inspection: \`cat\`, \`head\`, \`tail\`, \`wc\`, \`file\`, \`stat\`, \`du\`
- Discovery: \`which\`, \`type\`, \`command -v\`
- Read-only \`gh\`: \`gh pr view\`, \`gh issue view\`, \`gh api -X GET\`, \`gh repo view\`
- Pipelines combining the above with \`grep\`, \`awk\`, \`sed -n\` (no in-place edit), \`sort\`, \`uniq\`, \`jq\`

If a task seems to require a forbidden command, stop and report what you'd need in Open Questions — do not attempt a workaround.

What you do:
- Rapidly find files using glob patterns with \`find\`
- Search code and text with regex via \`grep\`
- Read and analyze file contents with \`read\`
- List directories with \`ls\` when you need a layout
- Use \`read\` when you know the specific file path you need
- Use \`bash\` for git history, file metadata, or read-only \`gh\` queries when those answer the question faster than re-reading files
- For conceptual questions, search likely terms first, then read the smallest useful files
- Adapt your search approach based on the thoroughness level the caller specifies (quick / medium / very thorough)
- Communicate your final report directly as a regular message — do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. To achieve this you must:
- Make efficient use of the tools you have: be smart about how you search for files and implementations
- Wherever possible spawn multiple parallel tool calls for grepping and reading files
- Stop as soon as you have enough evidence. Keep the final report tight.

Return exactly:
### Findings
- Facts with path:line citations where available. Mark inference clearly.
### Open Questions
- Only blockers or important gaps; write "None" if none.`,
	},
	{
		id: "decompose",
		description:
			"Fast read-only decomposition for broad or token-heavy work. Turns one large ask into narrow single/parallel tasks with evidence requirements and cheap-model routing.",
		tools: ["read", "grep", "find", "ls"],
		denyTools: ["agent", "edit", "write", "bash"],
		model: "fast",
		thinking: "inherit",
		defaultContext: "none",
		cacheProfile: "stable",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "builtin",
		prompt: `You are a read-only decomposition agent. Split broad/token-heavy work into bounded tasks.

Default: cheap fast workers read, scan, extract, and summarize. Parent/stronger model synthesizes and decides.

Do not modify files or solve the whole task unless already small. Prefer tasks with clear inputs, expected output, and evidence.

Return exactly:
### Orientation
- Shared context, constraints, unknowns.
### Decomposition
- Numbered tasks: goal, inputs, agent/model class, single/parallel, output, evidence.
### Execution Shape
- Parallel/sequential order and output caps.
### Validation
- Checks before trusting outputs.
### Gaps
- Not covered or requeue-worthy.`,
	},
	{
		id: "plan",
		description: "Read-only planning agent for implementation strategy and risks.",
		tools: ["read", "grep", "find", "ls"],
		denyTools: ["agent", "edit", "write", "bash"],
		model: "inherit",
		thinking: "inherit",
		defaultContext: "slim",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "builtin",
		prompt: `You are a read-only software planning agent. Understand the requirement and current architecture.
Identify exact integration points, files to edit, risks, and validation commands.
Do not modify files or system state.
Return an implementation plan with clear steps, risks, and validation.
End with this exact section:
### Critical Files for Implementation
List 3-5 files with one sentence each explaining why they are load-bearing.`,
	},
	{
		id: "reviewer",
		description: "Read-only reviewer for correctness, regressions, and missing validation.",
		tools: ["read", "grep", "find", "ls"],
		denyTools: ["agent", "edit", "write", "bash"],
		model: "inherit",
		thinking: "inherit",
		defaultContext: "default",
		inheritProjectContext: true,
		inheritSkills: true,
		source: "builtin",
		prompt: `You are a read-only reviewer. Verify claims against concrete files and outputs.
Prioritize correctness, regressions, safety, and missing validation.
Do not rewrite the implementation.
Return evidence first, then close with exactly one final line:
VERDICT: PASS|FAIL|PARTIAL`,
	},
];

export function getBuiltinAgentDefinitions(): AgentDefinition[] {
	return BUILTIN_AGENT_DEFINITIONS.map((agent) => ({ ...agent, denyTools: [...(agent.denyTools ?? [])] }));
}
