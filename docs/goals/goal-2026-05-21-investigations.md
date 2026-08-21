# Goal 2026-05-21T08-42-24Z — Investigation Report

Three read-only comparisons informing OpenClaw ↔ pi-extension boundaries. All claims cite `file:line`.

---

## 1. pi-advisor vs openclaw-advisor

### pi-advisor — `/Users/luke/Projects/personal/my-pi/extensions/advisor/`

- **(a) Session injection:** On `session_start` it toggles the advisor tool active/inactive via `setAdvisorToolState()`; on `before_agent_start` it repeats the toggle and renders status in the UI. No direct `system_prompt` hook — guidance flows through the tool's `promptGuidelines` which only render when the tool is active.
  - `extensions/advisor/index.ts:380-387` (session_start)
  - `extensions/advisor/index.ts:397-405` (before_agent_start)
  - `extensions/advisor/index.ts:298, 401` (promptGuidelines)
- **(b) Hooks/tools registered:**
  - `registerTool("advisor")` — deferred, always registered but only active when enabled. `index.ts:289`
  - `registerCommand("advisor")` + `registerCommand("advisor:model")` — slash command surface. `index.ts:253, 369`
  - `resources_discover` hook supplies skill paths when enabled. `index.ts:389-391`
- **(c) Triggers:** On-demand when the agent calls the `advisor` tool; no threshold-based auto-fire. `index.ts:289-290, 315-360`
- **(d) Model/prompt:**
  - Default: `claude-bridge/claude-opus-4-7` (Anthropic) or `openai-codex/gpt-5.5` (Codex path), provider-aware. `index.ts:35-36`
  - Configurable via `/advisor model <m>` or `PI_ADVISOR_MODEL`. `index.ts:104-110`, `config.ts:24`
  - System prompt: hard-coded ("You are advising a Pi coding agent…") + dynamic guidelines from the tool definition. `index.ts:76-88, 330-343`
  - Reasoning via `reasoning: config.thinking` (default "high"); cache `cacheRetention` ("short" default). `index.ts:322`, `config.ts:14`
- **(e) User surface:** Slash commands `/advisor {status|on|off|model|thinking|cache|logs|transcript}` (`index.ts:253`); status-bar widget `advisor:on:<model>` (`index.ts:197-202`); logs at `~/.pi/agent/extensions/advisor/logs/advisor.jsonl`, last transcript at `last-advisor-sees.md` (`index.ts:42-43`).

### openclaw-advisor — `/Users/luke/Projects/infra/openclaw-claude/plugins/advisor/`

- **(a) Session injection:** Not via Pi hooks. Registered as an OpenClaw peer tool via `api.registerTool(ctx => ({ ... }))`. `plugins/advisor/index.js:62`
- **(b) Hooks/tools:**
  - One `api.registerTool()` call exposing the `advisor` tool to OpenClaw agents. `plugins/advisor/index.js:62-125`
  - Per-session budget cache (`maxUsesPerSession`, `maxUsesPerTurn`, `costCapPerSession`) tracked keyed by sessionId. `index.js:43-48`, `lib/budget.js:7-9`
  - OTLP metric emission via `api.emit("metric", …)`. `lib/metrics.js:33-65`
- **(c) Triggers:** On-demand; gated by hard per-session limits (default 5 calls, 2/turn, $0.50 cap). Denied calls return a friendly message instead of throwing. `lib/advisor.js:70-76`; `lib/budget.js:7-9`. Agent filter via `enabledAgents` config (default `["*"]`). `index.js:58-63`
- **(d) Model/prompt:**
  - Default model: `"bridge-opus"` via claude-bridge. `lib/advisor.js:94`
  - System prompt: hard-coded ("You are a senior technical advisor…") + user question + optional `context_summary`. `lib/advisor.js:10-14, 22-29`
  - Reasoning via `thinkLevel` (default "medium"). `lib/advisor.js:107`
  - **Reasoning-only:** `disableTools: true` — advisor child has no tool surface. `lib/advisor.js:107`
- **(e) User surface:** No direct slash commands in the plugin; invoked by OpenClaw agents calling the tool. Separate `/advisor` CLI config command at `docs/claude-code-cli/src/commands/advisor.ts` is metadata-only. Structured `api.logger.info()` logs; OTLP metrics (invocations, tokens, latency_ms, budget.remaining) at `lib/metrics.js:37-65`.

### Verdict: **OVERLAPPING**

Both call a strong reasoning model (Opus via claude-bridge) on-demand with similar "advisor reviews the approach" intent, but they bind to **different runtimes**: pi-advisor is a Pi extension hooked into Pi session lifecycle and slash commands; openclaw-advisor is an OpenClaw plugin enforcing hard budget caps and emitting OTLP metrics around OpenClaw-embedded Pi runs. Same model + same idea, different orchestrators and different safety/observability surfaces. If both are active simultaneously, they will each be advisable independently — no shared budget, no shared logs. Recommendation: keep separate; document the split in OpenClaw's advisor README (and link pi-advisor's skill).

---

## 2. pi-opik-cli-bridge vs openclaw opik-openclaw

### pi-opik-cli-bridge — `/Users/luke/Projects/personal/my-pi/extensions/observability/pi-opik-cli-bridge.js`

- **(a) Hooks:**
  - `before_agent_start` — `pi-opik-cli-bridge.js:40-49`
  - `agent_end` — `pi-opik-cli-bridge.js:52-64`
- **(b) Fields:** `session_id` (from `ctx.sessionManager.getSessionId()`), `turn_id` (randomUUID per turn), `model` (`provider/id`), `usage.input_tokens` / `usage.output_tokens` (from `lastRecord.usage`), `deployment_environment` (env-normalized), `token_budget_gate` (from metadata). `pi-opik-cli-bridge.js:23-34, 39-64`
- **(c) Opik concept:** Stateless trace per pi turn. The bridge subprocess accumulates per-turn state (TTL 60 min) in `~/.local/share/opik-cli-bridge/sessions/`, then POSTs one trace + one llm span directly to Opik. `~/.local/share/opik-cli-bridge/bridge.js:189-215, 258-323`
- **(d) Transport:** CLI subprocess spawn — `node ~/.local/share/opik-cli-bridge/bridge.js --cli pi --event <e>` with JSON over stdin (detached, non-blocking). The bridge then performs `POST $OPIK_BASE_URL/traces` and `/spans`. `pi-opik-cli-bridge.js:27-33`; `bridge.js:189-215, 258-323`

### openclaw opik-openclaw — `/Users/luke/Projects/infra/openclaw-claude/docker/plugins/node_modules/@opik/opik-openclaw/`

- **(a) Hooks (OpenClaw, not Pi):**
  - `llm_input` / `llm_output` — `src/service/hooks/llm.ts:38-205`
  - `before_tool_call` / `after_tool_call` — `src/service/hooks/tool.ts:35-118+`
  - `subagent_spawning`, `subagent_spawned`, `subagent_delivery_target`, `subagent_ended` — `src/service/hooks/subagent.ts:28+`
  - `tool_result_persist` — `src/service.ts:583-599`
  - `agent_end` diagnostic — `src/service.ts:608-677`
- **(b) Fields:** `threadId` (= OpenClaw `sessionKey`), `model`, `provider`, `usage.{input,output,cacheRead,cacheWrite,total}`, `project_name`, `tags`, plus metadata: `created_from`, `agentId`, `sessionId`, `runId`, `channel`, `channelId`, `trigger`, `costUsd`, `contextLimit`, `contextUsed`, `durationMs`, `success`, `model`, `provider`, `error`. `service/hooks/llm.ts:49, 71-108, 185`; `service.ts:567-578, 629, 642, 666-673`
- **(c) Opik concept:** Persistent in-process Opik SDK client. One **trace per OpenClaw agent run** (threadId = sessionKey) with **nested spans** for every tool call, LLM invocation, and subagent spawn. Active traces tracked in `activeTraces` map with child span maps (`toolSpans`, `llmSpans`, `subagentSpans`). `service.ts:666-673`; `types.ts:42-65`
- **(d) Transport:** Direct Opik JS SDK (`new Opik({ apiUrl, apiKey })`); async retry queue with exponential backoff, drained on stop. `service.ts:669, 778-796`

### Verdict: **COMPLEMENTARY**

When OpenClaw spawns a Pi turn and both emitters are active, they write to the **same Opik project** but **different correlation IDs**: openclaw-opik uses `threadId = sessionKey` (OpenClaw scope), pi-opik-cli-bridge uses `session_id = pi sessionManager id` + randomUUID `turn_id` (Pi scope). Result: one OpenClaw trace with nested tool/LLM spans (the orchestration view) and one independent Pi trace per turn (the model-routing/token-budget view). No duplicate spans, no shared trace.

**Recommendation: keep both.** OpenClaw's plugin is the right place for plan-step + tool + subagent hierarchy; the pi-extension is the right place for Pi-specific fields (token_budget_gate, Pi provider routing) and for telemetry when Pi runs standalone. Consolidating would push Pi-specific concerns (token budget, sessionManager UUIDs) into the OpenClaw plugin and lose standalone Pi coverage. Document the split in both READMEs.

---

## 3. OpenClaw plugin → pi extension injection feasibility

### Critical finding: pi is **not** spawned as a subprocess by OpenClaw

OpenClaw integrates pi by **embedding `createAgentSession()`** from `@lue-labs/pi-coding-agent` directly in-process. There is no `child_process.spawn("pi", …)` from pi-harness.

- Integration entry: `~/openclaw/src/agents/pi-embedded-runner/run/attempt.ts:1` (`createAgentSession` import)
- Auto-discovery disabled: `DefaultResourceLoader` is constructed with `noExtensions: true`. `resource-loader.ts:11`
- Extensions are injected via `extensionFactories: …` passed to `DefaultResourceLoader`. `resource-loader.ts:19`
- Embedded factory builder: `buildEmbeddedExtensionFactories()` invoked at `attempt.ts:1708`; result passed to resource loader at `attempt.ts:1714-1719`.

This changes the answer materially: a future "inject a pi extension from an OpenClaw plugin" feature is a **function-call**, not an env/CLI/settings handoff.

### pi extension loading surface (pi-mono-fork)

- Discovery paths: `~/.pi/agent/extensions/*.ts`, `~/.pi/agent/extensions/*/index.ts`, `.pi/extensions/*.ts`, `.pi/extensions/*/index.ts`. `packages/coding-agent/docs/extensions.md:26`; `packages/coding-agent/src/core/extensions/loader.ts:490-530`
- `settings.json` array:
  ```json
  { "extensions": ["/abs/path/to/ext.ts", "/abs/path/to/ext-dir"] }
  ```
  `packages/coding-agent/docs/extensions.md:46`
- **No env var** like `PI_EXTRA_EXTENSIONS` exists today. Grep for `PI_EXTRA`, `process.env.*EXTENSION` in `loader.ts` returns nothing.
- **CLI flag**: `--extension <path>` / `-e <path>` is supported. `packages/coding-agent/src/cli/args.ts:125-128`
  ```ts
  } else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
      result.extensions = result.extensions ?? [];
      result.extensions.push(args[++i]);
  ```

### Recommendation

**Option D (new mechanism) — wire OpenClaw plugins into `buildEmbeddedExtensionFactories()`.**

Rationale: since pi is embedded, env vars / CLI flags / settings.json never reach the pi loader path — `DefaultResourceLoader` is invoked with `noExtensions: true` and the `extensionFactories` parameter. The cleanest path is to thread plugin-supplied extension factories through the OpenClaw plugin API into that same parameter.

Pseudo-code (OpenClaw side):

```js
// In pi-harness (or wherever buildEmbeddedExtensionFactories runs):
function buildEmbeddedExtensionFactories(params) {
  const built = [...defaultEmbeddedFactories];
  // NEW: collect factories contributed by other OpenClaw plugins.
  for (const plugin of api.listPlugins()) {
    const contributed = plugin.exports?.piExtensionFactories?.(params) ?? [];
    built.push(...contributed);
  }
  return built;
}

// In an OpenClaw plugin (e.g. pi-goal-openclaw):
module.exports = {
  exports: {
    piExtensionFactories: (params) => [
      () => import("./pi-goal-extension.js").then(m => m.default(params)),
    ],
  },
};

// In resource-loader.ts (existing):
const resourceLoader = createEmbeddedPiResourceLoader({
  cwd, agentDir, settingsManager,
  extensionFactories,  // now includes plugin-contributed factories
});
```

**Fallback for true subprocess case** (if pi is ever spawned via `spawn("pi", …)`):

A small core patch in `packages/coding-agent/src/core/extensions/loader.ts` to honor `PI_EXTRA_EXTENSIONS` (colon- or comma-delimited paths) inside `discoverAndLoadExtensions()` would let OpenClaw set `env.PI_EXTRA_EXTENSIONS = "/abs/path/a.ts:/abs/path/b.ts"` and the spawned pi would pick them up. ~6 lines. Not needed for current embedded integration.

### Required core patch? **No.**

Both the pi loader surface (`extensionFactories` parameter on `DefaultResourceLoader`) and the OpenClaw pi-harness embedded path already exist. The only addition is a hook on the OpenClaw plugin API (`plugin.exports.piExtensionFactories`) and the loop in `buildEmbeddedExtensionFactories()` that calls it — both OpenClaw-side, not pi-mono-fork-side.

---

## Code changes shipped this session

- `packages/ai/src/utils/validation.ts` — pre-parse stringified JSON for schemas declaring `array`/`object`, walking nested properties / items / anyOf / oneOf. Conservative: only `[…]` / `{…}` shaped strings with the matching parsed top-level kind are accepted; everything else falls through to existing validation.
- `packages/ai/test/validation.test.ts` — coverage for stringified-array and stringified-object tasks.
- `packages/coding-agent/src/core/tools/agent.ts`:
  - Default TUI label is now capitalized ("Agent") while the underlying tool id stays lowercase ("agent").
  - Output text prefix "agent {mode}: …" → "Agent {mode}: …" (3 sites: background-running, final-result, expanded view).
  - `renderCall` error fallback no longer prefixes `${toolName}:` (avoided "Agent agent: error" double-prefix).
  - Tool `description` and `promptGuidelines` extended to spell out that `tasks` / `chain` must be native JSON arrays, not stringified — closing the original misfire described in `docs/goals/goal-2026-05-21T08-42-24Z.md`.
- `packages/coding-agent/test/tool-execution-component.test.ts` — updated to assert the capitalized "Agent" label.

Gates: `npx biome check` clean on the four files; `npx tsgo --noEmit` clean repo-wide; targeted vitest suites green (4/4 + 35/35).
