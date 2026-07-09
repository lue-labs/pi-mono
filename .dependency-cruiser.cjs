/**
 * Fork-owned dependency-cruiser config (advisory static analysis lane).
 *
 * Scope: packages/*\/src only. Rules below encode the actual npm-workspace
 * dependency graph between the 5 packages (agent, ai, coding-agent,
 * orchestrator, tui) so cross-package imports that bypass package.json
 * dependencies get flagged. See each package.json "dependencies" for the
 * source of truth this was derived from:
 *   - tui: no internal deps
 *   - ai: no internal deps
 *   - agent: depends on ai
 *   - coding-agent: depends on agent, ai, tui
 *   - orchestrator: depends on coding-agent (only)
 *
 * This is advisory. no-circular/no-orphans start at "warn" (large existing
 * counts to burn down over time). The 4 package-boundary rules start at
 * "error" because the current tree has zero violations of them; if that
 * changes, drop the offending rule to "warn" until it is clean again. See
 * PR description for the ratchet plan. Do not fix findings as part of this
 * change.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			severity: "warn",
			comment: "Circular dependencies within/between packages/*/src. Advisory for now.",
			from: {},
			to: { circular: true },
		},
		{
			name: "no-orphans",
			severity: "warn",
			comment: "Modules that are not imported by anything else in scope. Advisory for now.",
			from: { orphan: true },
			to: {},
		},
		{
			name: "tui-no-cross-package-imports",
			severity: "error",
			comment: "packages/tui has no internal workspace dependencies; it should not import agent, ai, coding-agent, or orchestrator.",
			from: { path: "^packages/tui/src" },
			to: { path: "^packages/(agent|ai|coding-agent|orchestrator)/src" },
		},
		{
			name: "ai-no-cross-package-imports",
			severity: "error",
			comment: "packages/ai has no internal workspace dependencies; it should not import agent, coding-agent, orchestrator, or tui.",
			from: { path: "^packages/ai/src" },
			to: { path: "^packages/(agent|coding-agent|orchestrator|tui)/src" },
		},
		{
			name: "agent-only-depends-on-ai",
			severity: "error",
			comment: "packages/agent depends only on ai (per package.json); it should not import coding-agent, orchestrator, or tui.",
			from: { path: "^packages/agent/src" },
			to: { path: "^packages/(coding-agent|orchestrator|tui)/src" },
		},
		{
			name: "coding-agent-no-orchestrator-import",
			severity: "error",
			comment: "packages/coding-agent depends on agent, ai, and tui only; orchestrator depends on coding-agent, not the reverse.",
			from: { path: "^packages/coding-agent/src" },
			to: { path: "^packages/orchestrator/src" },
		},
	],
	options: {
		doNotFollow: {
			path: "node_modules",
		},
		tsPreCompilationDeps: true,
		tsConfig: {
			fileName: "tsconfig.base.json",
		},
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default", "types"],
		},
		reporterOptions: {
			dot: {
				collapsePattern: "node_modules/[^/]+",
			},
			archi: {
				collapsePattern: "^(packages)/[^/]+/",
			},
			text: {
				highlightFocused: true,
			},
		},
	},
};
