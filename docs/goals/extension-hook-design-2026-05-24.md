# Extension hook design — bash jobs, agents, deferred tools

Source goal: `docs/goals/goal-2026-05-24T12-42-38Z.md`

## Operating contract

**Outcome:** extract the remaining fork-only tool systems behind fluent extension seams, with the smallest core API needed for behavior that cannot live outside `AgentSession`.

**Verification surface:** this design, adversarial review, then PRs with targeted tests around tool activation, session persistence, background job lifecycle, agent run lifecycle, and prompt-cache stability.

**Constraints:** preserve prompt-cache affinity, avoid more per-feature core callbacks, keep simple extension usage simple, and do not move state into core when an extension can own it.

**Boundary:** `packages/coding-agent` should expose seams; implementation packages should live outside core where possible (`my-pi` or future pi packages). No upstream PR is required for this design, but PR #5 remains the best fork-delta reduction path.

## Recommendation

Ship one small core seam, then extract the remaining systems into package-owned modules.

```ts
export default function extension(pi: ExtensionAPI) {
  const state = pi.state<DeferredToolState>("pi.deferredTools", {
    defaultValue: { discoveredToolNames: [] },
    merge: mergeDeferredToolState,
  });

  const bashJobs = pi.service("bash.jobs", createBashJobStore());

  pi.registerTool(createToolSearchTool({ state, tools: pi.tools }));
  pi.registerTool(createBashTool({ jobs: bashJobs }));
  pi.registerFooter("bash.jobs", bashJobsFooter({ jobs: bashJobs }));
}
```

Core should not grow five deferred-tool callbacks, three bash callbacks, and agent-specific runner hooks. That recreates the same coupling with nicer names. The deeper seam is:

1. **Typed session state** — extension-owned persistence over existing custom entries.
2. **Typed service registry** — extension-owned runtime services discoverable by other extensions/UI adapters.
3. **Tool registry view** — a read/write view over current tool definitions and active tools.

Everything else becomes package code.

## The new core API

### 1. `pi.state()` — extension-owned session persistence

```ts
interface SessionStateOptions<T> {
  defaultValue: T;
  customType?: string;
  merge?: (previous: T, next: T) => T;
  parse?: (value: unknown) => T | undefined;
}

interface SessionState<T> {
  get(): T;
  set(next: T): void;
  update(update: (current: T) => T): T;
}

pi.state<T>(name: string, options: SessionStateOptions<T>): SessionState<T>;
```

Implementation stays thin:

- binds as a runtime action, not as a handler-only `ctx` helper;
- reads the current `SessionManager.getBranch()` at `get()` time so reload/resume/fork use the active session;
- appends via existing `sessionManager.appendCustomEntry()`;
- keeps no feature-specific fields on `AgentSession`;
- derives `customType` from `name` unless explicitly set.

This replaces `_discoveredDeferredToolNames` and `DEFERRED_TOOL_STATE_CUSTOM_TYPE` as core-owned concepts.

### 2. `pi.service()` / `pi.getService()` — package-owned runtime services

```ts
interface ServiceHandle<T> {
  id: string;
  current(): T;
  replace(next: T): void;
  dispose(): void;
}

pi.service<T>(id: string, service: T, options?: { replace?: boolean }): ServiceHandle<T>;
pi.getService<T>(id: string): T | undefined;
```

Rules:

- first registration wins by default;
- explicit `replace: true` only for reload-safe owner packages;
- services declare scope: `"runtime"` dies on reload, `"process"` survives reload until session dispose;
- `session_shutdown` notifies runtime-scoped services; `onSessionDispose` disposes process-scoped services;
- core treats service values as opaque.

This collapses the existing one-off registry drift (`registerRunRegistry`, `registerTelemetry`, live sessions, future bash job store) into one general seam. Keep existing methods as compatibility wrappers while new code uses `service()`.

### 3. `pi.tools` — natural tool registry view

```ts
interface ToolRegistryView {
  info(): ToolInfo[];
  definitions(): ToolDefinition[];
  active(): string[];
  activate(names: string[]): void;
  replaceActive(names: string[]): void;
}

pi.tools: ToolRegistryView;
```

`definitions()` is required. `ToolInfo` is intentionally UI-safe and currently omits `deferLoading`, `alwaysLoad`, `searchHint`, and provider availability; deferred-tool search needs the full `ToolDefinition` shape to reproduce current behavior. This view is still mostly a fluent wrapper around existing registry operations, but it must expose the real definition metadata for package-owned tool orchestration.

## Subsystem mapping

### PR #2 — bash background jobs

**Decision:** types live with the bash package, not core.

Recommended package: `@my-pi/bash-tools` or `@earendil-works/pi-bash-tools` later.

```ts
const jobs = createBashJobStore({ logDir: "~/.pi/agent/bash-bg" });
pi.service("bash.jobs", jobs, { scope: "process" });

pi.registerTool(createBashTool({ jobs }));
pi.registerTool(createBashOutputTool({ jobs }));
pi.registerTool(createBashKillTool({ jobs }));
pi.registerFooter("bash.jobs", createBashJobsFooter({ jobs }));
pi.onSessionDispose(() => jobs.killAll());
```

No `BashBgJob` type-only stub in core. If another extension wants the store, it imports the package type and reads `pi.getService<BashJobStore>("bash.jobs")`.

Why this is cleaner:

- the tool trio and TUI footer depend on one store, not `AgentSession`;
- the store survives `/reload` so long-running jobs are not orphaned by extension reload;
- process reaping stays package-owned via `onSessionDispose()`;
- UI invalidation uses package store subscription, not a core import from `tools/bash.ts`;
- core only provides the generic service slot.

Real extraction work remains: `createBashToolDefinition`, `createBashOutputToolDefinition`, and `createBashKillToolDefinition` must accept a `BashJobStore`, and `_buildRuntime()` must stop assuming `BashOutput` / `KillShell` are built-in defaults once the package registers them.

### PR #3 — agents

**Decision:** do not try to lift the whole agent subsystem with the current `registerTool` pattern. Extract behind an `AgentEngine` service first.

```ts
interface ParentAgentSnapshot {
  cwd: string;
  agentDir: string;
  activeTools: string[];
  sessionManager: ReadonlySessionManager;
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
}

interface ChildSessionFactory {
  create(snapshot: ParentAgentSnapshot, task: NormalizedAgentTaskConfig): Promise<AgentSession>;
}

interface AgentEngine {
  run(input: AgentToolExecutionInput, options: AgentRunOptions): Promise<AgentToolDetails>;
  control(action: AgentControlAction): Promise<AgentToolDetails>;
  runs: AgentRunStore;
  definitions: AgentDefinitionStore;
  contexts: ContextModeStore;
  childSessions: ChildSessionFactory;
}

pi.service<AgentEngine>("agents.engine", engine);
pi.registerTool(createAgentTool({ engine }));
pi.registerTool(createTaskTool({ engine }));
```

Minimal core touch:

- expose the generic service registry;
- expose a safe parent snapshot builder for active tools, model, thinking level, session manager, cwd, agentDir, and frozen system prompt;
- change `ctx.forkAgent()` to resolve `agents.engine` instead of importing `executeAgentTool` directly;
- keep `AgentSession` responsible only for parent session facts and cache-stable prompt capture.

This is the riskiest extraction. The package must not rebuild parent context casually: fork cache affinity depends on byte-identical parent `systemPrompt` plus tool schema ordering.

Do not add separate hooks for `onChildSessionStart`, `onChildSessionEnd`, `onBackgroundTerminal`, run registry, context modes, and live sessions. Those are one module: `AgentEngine`.

### PR #4 — deferred tools

**Decision:** extension-owned state, extension-owned `tool_search`, no core `_discoveredDeferredToolNames`.

```ts
const discovered = pi.state<DeferredToolState>("pi.deferredTools", {
  defaultValue: { discoveredToolNames: [] },
  merge: mergeDiscoveredToolNames,
});

pi.registerTool(createDeferredToolSearchTool({
  tools: pi.tools,
  discovered,
  model: () => pi.getModel(),
}));
```

The package can already do almost everything with existing API:

- scan prior state from session entries;
- append new state entries;
- inspect full registered `ToolDefinition` metadata via `pi.tools.definitions()`;
- activate fallback tools;
- return tool reference blocks for native deferred-tool providers.

The only missing piece is making that state pattern first-class and pleasant. `pi.state()` is one generic seam instead of deferred-tool-specific callbacks.

### PR #5 — upstream fork-delta reduction

**Decision:** pursue in parallel after the seam doc lands, not instead of it.

Upstreamable items are self-contained and high value:

- ugrep grep backend;
- find offset;
- edit hunks / originalContent.

They reduce fork delta without forcing the architectural decision. They should be separate upstream PRs because they are reviewable, low-coupling improvements.

## Why not extension-owned session manager?

Too much leverage in the wrong direction. Full session-state persistence as an extension-owned manager would expose ordering, branching, compaction, fork, tree navigation, custom messages, and storage semantics. That is not a small seam; it is core delegation.

`pi.state()` is the deep module: tiny interface, enough leverage, good locality.

## Why not many lifecycle callbacks?

A callback set like this is shallow:

```ts
onDeferredToolDiscovered()
onDeferredToolStateRead()
onDeferredToolStateWrite()
onAgentChildStart()
onAgentChildEnd()
onAgentBackgroundTerminal()
onBashJobChange()
```

Each callback leaks implementation steps. Extension authors must understand core timing, ordering, and persistence. It is extensible in the same way a power strip is architecture.

Use nouns instead:

- `SessionState`
- `Service`
- `AgentEngine`
- `BashJobStore`
- `ToolRegistryView`

Those are stable concepts with behavior behind them.

## PR sequence

1. **Core seam PR:** add `pi.state()`, `pi.service()`, `pi.getService()`, and `pi.tools.definitions()` wrappers. Add docs + tests only. Keep existing APIs.
2. **Deferred-tools PR:** move deferred-tool state and `tool_search` into a built-in extension using `pi.state()` and full tool definitions. ✅ implemented in working tree.
3. **Bash jobs PR:** move bash background store/tool companions behind a process-scoped service. ✅ companion tools/service implemented in working tree; footer invalidation still reads legacy helpers.
4. **Agents PR:** introduce `AgentEngine` service + parent snapshot / child-session factory, then migrate `agent` / `Task` tools and `ctx.forkAgent()` to it. ✅ implemented in working tree: `extensionHook("agents", hookAgents)` registers `agent` / `Agent` / `Task`; execution, controls, and `ctx.forkAgent()` route through `agents.engine` with legacy no-engine fallbacks for direct tool-factory tests.
5. **Upstream PRs:** submit ugrep/find/edit improvements as separate upstream PRs.

## Tests that must exist before completion

- `pi.state()` loads prior custom entries and appends updates in branch order.
- `pi.service()` first-registration-wins, process/runtime scope, reload survival/replacement, and dispose cleanup.
- `pi.tools.definitions()` exposes deferred metadata needed by `isDeferredTool()` without exposing mutable internal maps.
- Deferred tool search preserves discovered tools after resume/fork and does not activate deferred tools on native tool-reference providers.
- Fallback deferred tool activation preserves always-load and builtin cache-sensitive tools.
- Bash background jobs can run, read, kill, update footer, survive `/reload`, and die on session dispose without core imports.
- Agent engine service handles foreground, background, control actions, cancellation, and `ctx.forkAgent()` cache-preserving parent prompt inheritance.
- Golden test: parent fork uses byte-identical system prompt and stable tool schema ordering before/after extraction.
- `npm run check` green; touched package-specific tests green.

## Implementation status

Core seam implemented in this working tree:

- `pi.state()` typed session-state handles backed by custom entries.
- `pi.service()` / `pi.getService()` opaque runtime and process-scoped service registry.
- `pi.tools` fluent registry view with `info()`, `definitions()`, `active()`, `activate()`, and `replaceActive()`.
- `tools_changed` event for extensions that react to tool registry refreshes, including deferred extension load.
- Reload now invalidates the previous extension runner after `session_shutdown`, so captured pre-reload `pi` / `ctx` APIs throw instead of silently acting on stale runtime state.

Deferred-tools extraction implemented in this working tree:

- `tool_search` is registered by `packages/coding-agent/src/core/extensions/deferred-tools.ts` through `pi.registerTool()`.
- Discovered deferred-tool state is owned by `pi.state("pi.deferredTools", ...)`, not `AgentSession` fields.
- `AgentSession` no longer owns `_discoveredDeferredToolNames` or appends deferred-tool state directly.
- Deferred extension load is covered by `tools_changed`, so a later-loaded deferred extension can be the first provider of deferred tools and still get `tool_search`.

Bash bg-job companion extraction implemented in this working tree:

- `BashBgJobStore` / `createBashBgJobStore()` live with the bash tool module and are re-exported from `@lue-labs/pi-coding-agent`.
- `BASH_BG_JOBS_SERVICE_ID` is exported so extensions can read `pi.getService<BashBgJobStore>(BASH_BG_JOBS_SERVICE_ID)` without string literals.
- `BashOutput` and `KillShell` are registered by `packages/coding-agent/src/core/extensions/bash-bg-jobs.ts` through `pi.registerTool()`.
- The bash bg-job store is process-scoped and intentionally survives `/reload`; the built-in extension reaps jobs on session dispose.
- `AgentSession` no longer imports or calls `killAllBashBgJobs()` directly.

Verification:

- `npm --prefix packages/coding-agent exec vitest -- --run test/agent-session-dynamic-tools.test.ts test/deferred-tools-native.test.ts test/suite/regressions/deferred-tool-activation-refresh.test.ts` — 35/35 passing.
- `npm --prefix packages/coding-agent exec vitest -- --run test/bash-background.test.ts test/agent-session-dynamic-tools.test.ts test/tools.test.ts test/suite/regressions/3592-no-builtin-tools-keeps-extension-tools.test.ts` — 113/113 passing.
- `npm run check` — exits 0.
- Reviewer pass after core seam implementation — `VERDICT: PASS`.
- Reviewer pass after deferred-tools extraction and `tools_changed` fix — `VERDICT: PASS`.
- Reviewer pass after bash bg-job companion extraction — `VERDICT: PASS`.
- Reviewer pass after `AgentEngine` stage-1 seam and fork-agent override regressions — `VERDICT: PASS`.
- Reviewer pass after `agents` extension-hook registration move and control fallback fix — `VERDICT: PASS`.

## PR #3 AgentEngine blast-radius map

Current integration points:

- `AgentSession._forkAgentFromExtension()` directly calls `executeAgentTool(...)`, chains abort to `cancelAgentRecentRun(runId)`, waits through `waitForAgentRecentRun(runId)`, and returns an extension-facing `AgentHandle`.
- `AgentSession._bindExtensionCore()` exposes that method as `ctx.forkAgent(...)`.
- `_buildRuntime()` injects `agent` / `Agent` / `Task` as base tools through `createAllToolDefinitions(...)`, passing parent services, active tools, session manager, model, thinking level, frozen system prompt, and background terminal callback.
- `createAgentToolDefinition()` owns the LLM-facing schema/aliases/rendering and delegates execution to `executeAgentTool(...)`.
- `executeAgentTool()` owns orchestration: registry load, model/thinking/tool resolution, child `AgentSession` creation, context policy, foreground/background modes, recent-run status/control, progress, output files, live sessions, and completion notifications.
- Cache affinity depends on preserving the parent frozen `agent.state.systemPrompt` and tool schema ordering when context is `fork`.

Proposed `AgentEngine` seam:

```ts
interface AgentParentSnapshot {
  cwd: string;
  agentDir: string;
  activeTools: string[];
  sessionManager: ReadonlySessionManager;
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
}

interface AgentEngine {
  run(input: AgentToolExecutionInput, snapshot: AgentParentSnapshot, options?: AgentEngineRunOptions): Promise<AgentToolDetails>;
  control(action: AgentControlAction): Promise<AgentToolDetails>;
  fork(opts: ForkAgentOptions, snapshot: AgentParentSnapshot, signal?: AbortSignal): Promise<ForkAgentResult>;
  runs: AgentRunStore;
}
```

Minimal PR sequence:

1. ✅ Add `AgentParentSnapshot` builder in `AgentSession` and expose only stable parent facts.
2. ✅ Add `AgentEngine` wrapper around existing `executeAgentTool(...)` run/control/fork paths. No behavior change.
3. ✅ Register default `AgentEngine` as `agents.engine` on the runtime service map when no runtime/process override exists.
4. ✅ Move `agent` / `Agent` / `Task` tool registration to `extensionHook("agents", hookAgents)`; keep lowercase `agent` compatibility.
5. ✅ Change `ctx.forkAgent()` to resolve `agents.engine` and call `engine.fork(...)` with the parent snapshot.
6. ✅ Remove direct agent-tool construction from `AgentSession._buildRuntime()` when not using `_baseToolsOverride`.

AgentEngine seam notes:

- `ctx.forkAgent()` resolves process-scoped `agents.engine` first, then runtime-scoped engine, then lazily creates the default engine for backward-compatible tests that patch `_agentToolServices` after session construction.
- `extensionHook("agents", hookAgents)` registers `agent`, `Agent`, and `Task` via `pi.registerTool()` and resolves `agents.engine` at execution time, so advanced extensions can replace orchestration without replacing the tool schema/UI module.
- `before_agent_start` uses the current chained `systemPrompt` for default/fork-context forks so cache-affinity survives earlier prompt rewrites.
- `context: "slim"` and `context: "none"` do not receive an injected parent prompt; they keep their documented context semantics.
- Direct `createAgentToolDefinition()` use without an engine keeps the legacy execution/control fallback for tests and embedders.

Tests required before PR #3 is complete:

- `agent` / `Agent` / `Task` remain registered and default-active exactly as before.
- Foreground single, parallel, and chain modes still return the same `AgentToolDetails` shape.
- Background runs still emit `agent_completion` without polling.
- Control actions (`status`, `detail`, `interrupt`, `cancel`, `resume`) still work.
- `ctx.forkAgent()` returns a handle, aborts cooperatively, and preserves byte-identical parent system prompt for `context: "fork"`.
- Agent registry merge order still includes builtin, user/project, and extension definitions.
- Cache-affinity golden test: parent/fork system prompt and tool schema prefix remains stable.

## Completion audit status

The core seam and design decision gap are closed, PR #4 is implemented, and the PR #2 companion-tool extraction is implemented. The active goal should remain open until the agent subsystem extraction is done or Luke explicitly narrows the deliverable. Remaining work:

- PR #2 follow-up: optional footer invalidation can switch from legacy `subscribeBashBgJobs()` import to the `BashBgJobStore` service when interactive mode gets a service-aware UI seam.
- PR #3: implemented in working tree. Optional future cleanup: move the direct no-engine legacy fallback out of `tools/agent.ts` once all embedders create tools through the `agents` extension hook or pass an engine explicitly.
- PR #5: submit upstreamable grep/find/edit improvements separately if chosen.
