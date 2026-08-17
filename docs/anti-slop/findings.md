# Anti-slop findings register

Every open anti-slop finding in fork-owned source, at line granularity.
Regenerate with `node scripts/anti-slop-inventory.mjs`.

Counts at the time of writing: 334 findings in fork-owned source, plus 689 in
fork-owned tests. The test findings are listed separately by
the generator and are not reproduced here, because they are dominated by
deliberate fixture casts.

## How to read this register

A finding appears here because it is open, not because it is wrong. Each rule
section below states what was found when the sites were read, and what would
have to change to clear them. Two rules turned out to be structurally
unclearable in a parser, and that is recorded rather than hidden.

## Dispositions by rule

### require-safety-comment-for-type-assertion (122)

Assertions on values crossing a boundary the type system does not model:
extension modules loaded at runtime, YAML agent definitions, and SDK content
blocks. Each one would be cleared by a `SAFETY:` comment, but adding 122 such
comments mechanically is exactly the laundering `anti-slop/code.md` warns
against, and would assert an invariant nobody verified. They are cleared
properly by parsing at the boundary, as done in
`packages/ai/src/api/anthropic-server-tools.ts` (24 findings to 7).

### no-runtime-typeof (96)

Hand-rolled `typeof` validation of untyped input: agent-definition parsing in
`chains.ts`, `loader.ts`, and `executor.ts`, and provider payloads in
`packages/ai`. The rule is right that these should be schema parses. The fork
already depends on TypeBox, so the fix is available, but converting 96 sites
across the agent-definition loader changes what malformed input is accepted and
is a behavior-carrying project rather than a lint cleanup.

### no-known-value-widening (39)

Functions returning inline anonymous object types, so each return site
re-widens. Cleared by naming the type; done for `ServerToolResultSummary` and
`ThinkingStripResult`. The remainder are the same mechanical fix, each
touching a published signature.

### no-unknown-parameters (39)

**This rule cannot be satisfied at a parser entry point.** A function that
validates untyped input must accept `unknown`; that is the correct signature.
The rule fires on `fields(value: unknown)` in `anthropic-server-tools.ts`,
which is code this sweep just wrote to *fix* other findings. Recorded as a rule
limit, not a defect.

### no-unsafe-dictionary-type (28)

`Record<string, unknown>` describing genuine JSON objects arriving from a
provider or a YAML file. Where the shape is known, a named type is the fix;
where the value is arbitrary JSON, `Record<string, unknown>` is the honest type
and the finding is a false positive.

### no-chained-type-assertions (6), no-shape-in-symbol-names (3), no-conditional-empty-object-spread (2), no-unknown-returns (1)

Reviewed individually. The two spread findings in
`anthropic-tool-serialization.ts` are deliberate: key insertion order defines
the cached `tools[]` prefix byte order, and an in-code comment records this. The
three `responseShape` findings are a published `ui_harness` tool-schema field
with 24 usages, so renaming is a breaking change for zero correctness gain.

## Full register


### no-chained-type-assertions

| File | Line | Source |
| --- | ---: | --- |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 94 | `return tool.anthropicServerTool as unknown as Anthropic.Messages.ToolUnion;` |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 106 | `return {` |
| `packages/coding-agent/src/core/bash-bg-jobs.ts` | 794 | `const unref = (stream as unknown as { unref?: () => void } \| null)?.unref;` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 231 | `content = [...(nextMessages[messageIndex] as unknown as { content: unknown[] }).content];` |
| `packages/coding-agent/src/core/tools/bash-output.ts` | 172 | `details: { bgId, fullOutputPath: orphaned.fullOutputPath } as unknown as BashOutputToolDetails,` |
| `packages/coding-agent/src/utils/color-diff.ts` | 345 | `const emitter = (result as unknown as { emitter?: unknown }).emitter;` |

### no-conditional-empty-object-spread

| File | Line | Source |
| --- | ---: | --- |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 129 | `...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),` |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 130 | `...(deferLoading ? { defer_loading: true } : {}),` |

### no-known-value-widening

| File | Line | Source |
| --- | ---: | --- |
| `packages/coding-agent/src/core/agents/chains.ts` | 84 | `return { diagnostics: [{ level: "warning", message: `Could not parse chain JSON: ${String(error)}`, path }] };` |
| `packages/coding-agent/src/core/agents/chains.ts` | 88 | `return {` |
| `packages/coding-agent/src/core/agents/chains.ts` | 155 | `return {` |
| `packages/coding-agent/src/core/agents/chains.ts` | 189 | `if (!existsSync(dir)) return { chains: [], diagnostics: [] };` |
| `packages/coding-agent/src/core/agents/chains.ts` | 198 | `return {` |
| `packages/coding-agent/src/core/agents/chains.ts` | 219 | `return { chains, diagnostics };` |
| `packages/coding-agent/src/core/agents/executor.ts` | 342 | `return { effectiveTools: [...new Set(effectiveTools)], deniedTools: [...new Set(deniedTools)] };` |
| `packages/coding-agent/src/core/agents/executor.ts` | 551 | `return {` |
| `packages/coding-agent/src/core/agents/executor.ts` | 1111 | `return { model: prepared.model, thinkingLevel: prepared.thinking };` |
| `packages/coding-agent/src/core/agents/executor.ts` | 1122 | `return { model: prepared.model, thinkingLevel: prepared.thinking };` |
| `packages/coding-agent/src/core/agents/executor.ts` | 1124 | `return {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 139 | `return {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 150 | `return {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 174 | `return {` |
| `packages/coding-agent/src/core/bash-bg-jobs.ts` | 401 | `if (!job \|\| job.status !== "running") return { job };` |
| `packages/coding-agent/src/core/bash-bg-jobs.ts` | 597 | `if (job.status !== "running" \|\| !lifecycle \|\| lifecycle.stopRequest) return { job };` |
| `packages/coding-agent/src/core/bash-bg-jobs.ts` | 1131 | `return { text: "", shownLines: 0, totalLines: 0, lineCountExact: true, truncated: false };` |
| `packages/coding-agent/src/core/bash-bg-jobs.ts` | 1151 | `return {` |
| `packages/coding-agent/src/core/cache-heartbeat.ts` | 38 | `} = {` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 134 | `return { toolCallEntryIds, toolResultEntryIds };` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 291 | `return { relativePath };` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 297 | `return { error: error instanceof Error ? error.message : String(error) };` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 301 | `return { error: error instanceof Error ? error.message : String(error) };` |
| `packages/coding-agent/src/core/tools/agent.ts` | 286 | `return {` |
| `packages/coding-agent/src/core/tools/agent.ts` | 291 | `if (hasParallel) return { mode: "parallel", tasks: tasks ?? [] };` |
| `packages/coding-agent/src/core/tools/agent.ts` | 292 | `return { mode: "chain", tasks: chain ?? [] };` |
| `packages/coding-agent/src/core/tools/bash-output.ts` | 71 | `return { text: `${header}\n\n${body}`, fullOutputPath: job.logPath };` |
| `packages/coding-agent/src/core/tools/glob.ts` | 263 | `return { content: [{ type: "text", text: resultOutput }], details };` |
| `packages/coding-agent/src/modes/interactive/components/tool-panel.ts` | 14 | `return { contentWidth: Math.max(1, width - paddingX * 2), paddingX };` |
| `packages/coding-agent/src/utils/color-diff.ts` | 118 | `const ONE_DARK_PRO_SCOPES: Record<string, Color> = {` |
| `packages/coding-agent/src/utils/color-diff.ts` | 146 | `const GITHUB_SCOPES: Record<string, Color> = {` |
| `packages/coding-agent/src/utils/color-diff.ts` | 192 | `const ANSI_SCOPES: Record<string, Color> = {` |
| `packages/coding-agent/src/utils/color-diff.ts` | 276 | `const FILENAME_LANGS: Record<string, string> = {` |
| `packages/coding-agent/src/utils/pierre-diff.ts` | 65 | `return { marker: "-", ansi: RED };` |
| `packages/coding-agent/src/utils/pierre-diff.ts` | 67 | `return { marker: "+", ansi: GREEN };` |
| `packages/coding-agent/src/utils/pierre-diff.ts` | 69 | `return { marker: " ", ansi: DIM };` |

### no-runtime-typeof

| File | Line | Source |
| --- | ---: | --- |
| `packages/ai/src/api/anthropic-server-tools.ts` | 39 | `if (value === null \|\| typeof value !== "object" \|\| Array.isArray(value)) return undefined;` |
| `packages/ai/src/api/anthropic-server-tools.ts` | 46 | `return typeof value === "string" ? value : undefined;` |
| `packages/ai/src/api/anthropic-thinking-recovery.ts` | 21 | `error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error ?? "");` |
| `packages/ai/src/api/anthropic-thinking-recovery.ts` | 56 | `if (typeof assistant.content === "string") continue;` |
| `packages/ai/src/api/anthropic-thinking-recovery.ts` | 84 | `if (typeof message.content === "string") return true;` |
| `packages/ai/src/api/anthropic-thinking-recovery.ts` | 119 | `if (message.role !== "assistant" \|\| typeof message.content === "string") {` |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 51 | `if (value === null \|\| typeof value !== "object" \|\| Array.isArray(value)) return value;` |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 105 | `if (typeof advisorModel === "string" && advisorModel.length > 0) {` |
| `packages/ai/src/api/tool-use-adjacency.ts` | 32 | `if (typeof content === "string") return ["text"];` |
| `packages/ai/src/api/tool-use-adjacency.ts` | 47 | `if (!next \|\| next.role !== "user" \|\| typeof next.content === "string") return ids;` |
| `packages/ai/src/api/tool-use-adjacency.ts` | 57 | `if (typeof content === "string") return ids;` |
| `packages/ai/src/api/tool-use-adjacency.ts` | 79 | `if (message.role !== "assistant" \|\| typeof message.content === "string") continue;` |
| `packages/coding-agent/examples/extensions/environment-composition.ts` | 38 | `if (!payload \|\| typeof payload !== "object") return payload;` |
| `packages/coding-agent/src/cli/agent-view-command.ts` | 91 | `return typeof candidate?.runAgentViewCli === "function" ? (candidate as AgentViewModule) : undefined;` |
| `packages/coding-agent/src/cli/agent-view-command.ts` | 146 | `return typeof data.name === "string" ? data.name : undefined;` |
| `packages/coding-agent/src/core/agents/chains.ts` | 71 | `if (!Array.isArray(value) \|\| !value.every((entry) => typeof entry === "string")) return undefined;` |
| `packages/coding-agent/src/core/agents/chains.ts` | 86 | `const name = typeof raw.name === "string" ? raw.name.trim() : "";` |
| `packages/coding-agent/src/core/agents/chains.ts` | 96 | `if (!step \|\| typeof step !== "object") {` |
| `packages/coding-agent/src/core/agents/chains.ts` | 101 | `const preferredAgent = typeof item.subagent_type === "string" ? item.subagent_type : undefined;` |
| `packages/coding-agent/src/core/agents/chains.ts` | 102 | `const legacyAgent = typeof item.agent === "string" ? item.agent : undefined;` |
| `packages/coding-agent/src/core/agents/chains.ts` | 103 | `const preferredTask = typeof item.prompt === "string" ? item.prompt : undefined;` |
| `packages/coding-agent/src/core/agents/chains.ts` | 104 | `const legacyTask = typeof item.task === "string" ? item.task : undefined;` |
| `packages/coding-agent/src/core/agents/chains.ts` | 134 | `description: typeof item.description === "string" ? item.description : undefined,` |
| `packages/coding-agent/src/core/agents/chains.ts` | 136 | `typeof item.context === "string" && CONTEXT_MODES.has(item.context)` |
| `packages/coding-agent/src/core/agents/chains.ts` | 139 | `extraContext: typeof item.extraContext === "string" ? item.extraContext : undefined,` |
| `packages/coding-agent/src/core/agents/chains.ts` | 140 | `model: typeof item.model === "string" ? item.model : undefined,` |
| `packages/coding-agent/src/core/agents/chains.ts` | 143 | `typeof item.thinking === "string" && THINKING_LEVELS.has(item.thinking)` |
| `packages/coding-agent/src/core/agents/chains.ts` | 146 | `output: typeof item.output === "string" ? item.output : undefined,` |
| `packages/coding-agent/src/core/agents/chains.ts` | 148 | `typeof item.outputMode === "string" && OUTPUT_MODES.has(item.outputMode)` |
| `packages/coding-agent/src/core/agents/chains.ts` | 160 | `description: typeof raw.description === "string" ? raw.description : undefined,` |
| `packages/coding-agent/src/core/agents/chains.ts` | 164 | `concurrency: typeof raw.concurrency === "number" ? raw.concurrency : undefined,` |
| `packages/coding-agent/src/core/agents/chains.ts` | 166 | `typeof raw.context === "string" && CONTEXT_MODES.has(raw.context)` |
| `packages/coding-agent/src/core/agents/chains.ts` | 169 | `model: typeof raw.model === "string" ? raw.model : undefined,` |
| `packages/coding-agent/src/core/agents/chains.ts` | 171 | `typeof raw.thinking === "string" && THINKING_LEVELS.has(raw.thinking)` |
| `packages/coding-agent/src/core/agents/chains.ts` | 176 | `typeof raw.outputMode === "string" && OUTPUT_MODES.has(raw.outputMode)` |
| `packages/coding-agent/src/core/agents/engine.ts` | 53 | `return typeof intercom === "object" && intercom !== null && (intercom as Record<string, unknown>).hidden === true;` |
| `packages/coding-agent/src/core/agents/engine.ts` | 151 | `if (typeof opts?.prompt !== "string" \|\| opts.prompt.length === 0) {` |
| `packages/coding-agent/src/core/agents/executor.ts` | 258 | `if (typeof raw !== "number" \|\| !Number.isFinite(raw) \|\| raw <= 0) return 0;` |
| `packages/coding-agent/src/core/agents/executor.ts` | 516 | `if (typeof custom.content === "string" && custom.content.length > 0) warnings.push(custom.content);` |
| `packages/coding-agent/src/core/agents/executor.ts` | 529 | `typeof part === "object" &&` |
| `packages/coding-agent/src/core/agents/executor.ts` | 531 | `typeof (part as { text?: unknown }).text === "string",` |
| `packages/coding-agent/src/core/agents/executor.ts` | 549 | `.filter((part): part is string => typeof part === "string" && part.length > 0)` |
| `packages/coding-agent/src/core/agents/executor.ts` | 609 | `text = typeof value === "string" ? value : JSON.stringify(value);` |
| `packages/coding-agent/src/core/agents/executor.ts` | 618 | `if (typeof content === "string") return previewValue(content, maxLength);` |
| `packages/coding-agent/src/core/agents/executor.ts` | 624 | `typeof part === "object" &&` |
| `packages/coding-agent/src/core/agents/executor.ts` | 626 | `typeof (part as { text?: unknown }).text === "string",` |
| `packages/coding-agent/src/core/agents/executor.ts` | 703 | `const argRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;` |
| `packages/coding-agent/src/core/agents/executor.ts` | 705 | `(value): value is string => typeof value === "string" && value.length > 0,` |
| `packages/coding-agent/src/core/agents/executor.ts` | 1394 | `return typeof t === "number" ? sum + t : sum;` |
| `packages/coding-agent/src/core/agents/executor.ts` | 1398 | `(child) => typeof child.finalOutput === "string" && child.finalOutput.length > 0,` |
| `packages/coding-agent/src/core/agents/executor.ts` | 1480 | `if (error && typeof error === "object" && "details" in error) {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 73 | `if (typeof value === "string") {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 79 | `if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 98 | `if (typeof value === "string" && CONTEXT_MODES.has(value as ContextMode)) {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 111 | `if (typeof value === "string" && CACHE_PROFILES.has(value as AgentCacheProfile)) {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 125 | `if (typeof value === "boolean") return value;` |
| `packages/coding-agent/src/core/agents/loader.ts` | 145 | `const id = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";` |
| `packages/coding-agent/src/core/agents/loader.ts` | 146 | `const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";` |
| `packages/coding-agent/src/core/agents/loader.ts` | 163 | `typeof frontmatter.thinking === "string" && THINKING_LEVELS.has(frontmatter.thinking)` |
| `packages/coding-agent/src/core/agents/loader.ts` | 183 | `model: typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined,` |
| `packages/coding-agent/src/core/cache-health.ts` | 54 | `return typeof value === "number" && Number.isFinite(value) ? value : 0;` |
| `packages/coding-agent/src/core/cache-health.ts` | 67 | `if (typeof value === "number" && Number.isFinite(value)) return value;` |
| `packages/coding-agent/src/core/cache-health.ts` | 68 | `if (typeof value !== "string" \|\| value.length === 0) return null;` |
| `packages/coding-agent/src/core/context-file-imports.ts` | 543 | `} else if (typeof token.text === "string") {` |
| `packages/coding-agent/src/core/context-usage.ts` | 78 | `if (typeof content === "string") return estimateTextTokens(content);` |
| `packages/coding-agent/src/core/context-usage.ts` | 83 | `if (!part \|\| typeof part !== "object") continue;` |
| `packages/coding-agent/src/core/context-usage.ts` | 88 | `if (typeof text === "string") tokens += estimateTextTokens(text);` |
| `packages/coding-agent/src/core/context-usage.ts` | 91 | `if (typeof text === "string") tokens += estimateTextTokens(text);` |
| `packages/coding-agent/src/core/context-usage.ts` | 94 | `if (typeof name === "string") tokens += estimateTextTokens(name);` |
| `packages/coding-agent/src/core/deferred-tools.ts` | 32 | `if (content && typeof content === "object" && "content" in content)` |
| `packages/coding-agent/src/core/deferred-tools.ts` | 40 | `typeof value === "object" &&` |
| `packages/coding-agent/src/core/deferred-tools.ts` | 42 | `typeof (value as { name?: unknown }).name === "string"` |
| `packages/coding-agent/src/core/extensions/context-usage.ts` | 50 | `typeof message.timestamp === "number"` |
| `packages/coding-agent/src/core/session-liveness.ts` | 88 | `if (typeof parsed.pid !== "number" \|\| typeof parsed.heartbeat !== "number") return null;` |
| `packages/coding-agent/src/core/session-liveness.ts` | 91 | `startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : parsed.heartbeat,` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 161 | `return typeof value === "object" && value !== null && !Array.isArray(value);` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 176 | `if (typeof content === "string") return RESIDENT_PRUNED_TEXT;` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 242 | `typeof block === "object" &&` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 245 | `typeof (block as { data?: unknown }).data === "string"` |
| `packages/coding-agent/src/core/tools/agent.ts` | 177 | `if (typeof primary === "string" && typeof alias === "string" && primary !== alias) {` |
| `packages/coding-agent/src/core/tools/agent.ts` | 180 | `return typeof primary === "string" ? primary : typeof alias === "string" ? alias : undefined;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 190 | `if (typeof primary === "boolean" && typeof alias === "boolean" && primary !== alias) {` |
| `packages/coding-agent/src/core/tools/agent.ts` | 193 | `return typeof primary === "boolean" ? primary : typeof alias === "boolean" ? alias : undefined;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 223 | `if (typeof candidate === "string") {` |
| `packages/coding-agent/src/core/tools/agent.ts` | 231 | `if (typeof candidate === "object") {` |
| `packages/coding-agent/src/core/tools/agent.ts` | 234 | `throw new Error(`agent tool ${field} must be an array of task objects, got ${typeof candidate}`);` |
| `packages/coding-agent/src/core/tools/agent.ts` | 851 | `if (detailsChanged && !state.runId && typeof context.invalidate === "function") context.invalidate();` |
| `packages/coding-agent/src/core/tools/glob.ts` | 267 | `const seconds = typeof timeout === "number" && Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT_SECONDS;` |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 228 | `if (typeof value !== "object" \|\| value === null) {` |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 237 | `if (!v.root \|\| typeof v.root !== "object") {` |
| `packages/coding-agent/src/modes/interactive/components/memory-saved-message.ts` | 38 | `return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];` |
| `packages/coding-agent/src/utils/color-diff.ts` | 314 | `if (typeof node === "string") {` |
| `packages/coding-agent/src/utils/color-diff.ts` | 324 | `typeof emitter === "object" &&` |
| `packages/coding-agent/src/utils/color-diff.ts` | 327 | `typeof (emitter as Record<string, unknown>).rootNode === "object" &&` |
| `packages/coding-agent/src/utils/pierre-diff.ts` | 40 | `if (typeof style !== "string") return "";` |
| `scripts/check-fork-delta-static.mjs` | 93 | `if (typeof stdout === "string" && stdout.trim().length > 0) {` |

### no-shape-in-symbol-names

| File | Line | Source |
| --- | ---: | --- |
| `packages/coding-agent/src/core/tools/build-interface.ts` | 57 | `responseShape: Type.Optional(` |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 195 | `if (input.responseShape !== undefined) {` |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 196 | `parts.push(`  responseShape: ${JSON.stringify(input.responseShape)}`);` |

### no-unknown-parameters

| File | Line | Source |
| --- | ---: | --- |
| `packages/ai/src/api/anthropic-server-tools.ts` | 38 | `function fields(value: unknown): Readonly<Record<string, unknown>> \| undefined {` |
| `packages/ai/src/api/anthropic-thinking-recovery.ts` | 18 | `export function isLatestThinkingModifiedError(error: unknown): boolean {` |
| `packages/coding-agent/src/core/agents/chains.ts` | 70 | `function parseStringArray(value: unknown): string[] \| undefined {` |
| `packages/coding-agent/src/core/agents/executor.ts` | 605 | `function previewValue(value: unknown, maxLength = 240): string \| undefined {` |
| `packages/coding-agent/src/core/agents/executor.ts` | 617 | `function extractTextPreview(content: unknown, maxLength = 240): string \| undefined {` |
| `packages/coding-agent/src/core/agents/executor.ts` | 700 | `function recordSkillInvocation(details: AgentRunDetails, toolName: string, args: unknown): void {` |
| `packages/coding-agent/src/core/agents/executor.ts` | 1257 | `function throwChildSetupFailure(details: AgentRunDetails, error: unknown): never {` |
| `packages/coding-agent/src/core/agents/executor.ts` | 1479 | `function getErrorDetails(error: unknown): AgentRunDetails \| undefined {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 67 | `value: unknown,` |
| `packages/coding-agent/src/core/agents/loader.ts` | 90 | `function parseTools(value: unknown, path: string, diagnostics: AgentLoadDiagnostic[]): AgentToolList \| undefined {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 96 | `function parseContext(value: unknown, path: string, diagnostics: AgentLoadDiagnostic[]): ContextMode \| undefined {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 106 | `value: unknown,` |
| `packages/coding-agent/src/core/agents/loader.ts` | 119 | `value: unknown,` |
| `packages/coding-agent/src/core/agents/status.ts` | 397 | `export function failAgentRecentRun(run: AgentRecentRun, error: unknown, expectedGeneration?: number): void {` |
| `packages/coding-agent/src/core/cache-affinity.ts` | 4 | `function hashStableJson(value: unknown): string {` |
| `packages/coding-agent/src/core/cache-health.ts` | 53 | `function finiteNumber(value: unknown): number {` |
| `packages/coding-agent/src/core/context-usage.ts` | 35 | `function estimateJsonTokens(value: unknown): number {` |
| `packages/coding-agent/src/core/context-usage.ts` | 77 | `function estimateContentTokens(content: unknown): number {` |
| `packages/coding-agent/src/core/deferred-tools.ts` | 30 | `function contentBlocks(content: unknown): unknown[] {` |
| `packages/coding-agent/src/core/deferred-tools.ts` | 37 | `function isDeferredToolReferenceBlock(value: unknown): value is DeferredToolReferenceBlock {` |
| `packages/coding-agent/src/core/extensions/context-usage.ts` | 12 | `function isStaleContextError(error: unknown): boolean {` |
| `packages/coding-agent/src/core/extensions/extension-api-fork.ts` | 206 | `showMainPane(id: string, payload?: unknown): void {` |
| `packages/coding-agent/src/core/extensions/extension-api-fork.ts` | 226 | `showOverlay(id: string, payload?: unknown): void {` |
| `packages/coding-agent/src/core/extensions/extension-api-fork.ts` | 327 | `const parse = (value: unknown): T \| undefined => (options.parse ? options.parse(value) : (value as T));` |
| `packages/coding-agent/src/core/extensions/ui-slots.ts` | 76 | `showMainPane: (id: string, payload: unknown) => void;` |
| `packages/coding-agent/src/core/extensions/ui-slots.ts` | 79 | `showOverlay: (id: string, payload: unknown) => void;` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 69 | `function jsonByteLength(value: unknown): number {` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 160 | `function isRecord(value: unknown): value is Record<string, unknown> {` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 164 | `function keepRecoverableDetails(details: unknown): Record<string, unknown> \| undefined {` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 240 | `function isImageContent(block: unknown): block is ImageContent {` |
| `packages/coding-agent/src/core/tools/agent.ts` | 220 | `function coerceTaskList(value: unknown, field: "tasks" \| "chain"): NonNullable<AgentToolInput["tasks"]> \| undefined {` |
| `packages/coding-agent/src/core/tools/glob.ts` | 311 | `function isAbortError(error: unknown): boolean {` |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 227 | `export function validateLayoutGraph(value: unknown): LayoutGraph {` |
| `packages/coding-agent/src/modes/interactive/agent-commands.ts` | 52 | `showExtensionMainPane(id: string, payload: unknown): void;` |
| `packages/coding-agent/src/modes/interactive/components/memory-saved-message.ts` | 37 | `function toPaths(value: unknown): string[] {` |
| `packages/coding-agent/src/utils/color-diff.ts` | 322 | `function hasRootNode(emitter: unknown): emitter is { rootNode: HljsNode } {` |
| `packages/coding-agent/src/utils/pierre-diff.ts` | 21 | `asyncRender(diff: unknown): Promise<{` |
| `packages/coding-agent/src/utils/pierre-diff.ts` | 39 | `function styleToAnsi(style: unknown): string {` |
| `packages/coding-agent/src/utils/pierre-diff.ts` | 62 | `function markerForLineType(lineType: unknown): { marker: string; ansi: string } {` |

### no-unknown-returns

| File | Line | Source |
| --- | ---: | --- |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 207 | `export function parseHarnessJSON(raw: string): unknown {` |

### no-unsafe-dictionary-type

| File | Line | Source |
| --- | ---: | --- |
| `packages/ai/src/api/anthropic-server-tools.ts` | 38 | `function fields(value: unknown): Readonly<Record<string, unknown>> \| undefined {` |
| `packages/ai/src/api/anthropic-server-tools.ts` | 40 | `return value as Readonly<Record<string, unknown>>;` |
| `packages/ai/src/api/anthropic-server-tools.ts` | 44 | `function stringField(record: Readonly<Record<string, unknown>> \| undefined, key: string): string \| undefined {` |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 115 | `const properties = sortObjectKeysDeep(schema.properties ?? {}) as Record<string, unknown>;` |
| `packages/coding-agent/src/core/agents/chains.ts` | 100 | `const item = step as Record<string, unknown>;` |
| `packages/coding-agent/src/core/agents/engine.ts` | 53 | `return typeof intercom === "object" && intercom !== null && (intercom as Record<string, unknown>).hidden === true;` |
| `packages/coding-agent/src/core/agents/executor.ts` | 547 | `}): Record<string, unknown> {` |
| `packages/coding-agent/src/core/agents/executor.ts` | 703 | `const argRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;` |
| `packages/coding-agent/src/core/agents/executor.ts` | 901 | `routingMetadata?: Record<string, unknown>;` |
| `packages/coding-agent/src/core/agents/executor.ts` | 943 | `(task as NormalizedAgentTaskConfig & Record<PropertyKey, unknown>)[AUTOMATIC_WORKTREE_CWD] === true;` |
| `packages/coding-agent/src/core/agents/types.ts` | 98 | `forkMetadata?: Record<string, unknown>;` |
| `packages/coding-agent/src/core/extensions/extension-api-fork.ts` | 243 | `getExtensionConfig<T = Record<string, unknown>>(namespace: string): T \| undefined {` |
| `packages/coding-agent/src/core/extensions/fork-agent-types.ts` | 161 | `metadata?: Record<string, unknown>;` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 160 | `function isRecord(value: unknown): value is Record<string, unknown> {` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 164 | `function keepRecoverableDetails(details: unknown): Record<string, unknown> \| undefined {` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 166 | `const retained: Record<string, unknown> = {};` |
| `packages/coding-agent/src/core/tools/agent.ts` | 153 | `type AgentToolParams = AgentToolInput & Record<string, unknown>;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 154 | `type AgentTaskParams = NonNullable<AgentToolInput["tasks"]>[number] & Record<string, unknown>;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 162 | `function rejectUnsupportedFutureFields(params: Record<string, unknown>): void {` |
| `packages/coding-agent/src/core/tools/agent.ts` | 171 | `params: Record<string, unknown>,` |
| `packages/coding-agent/src/core/tools/agent.ts` | 184 | `params: Record<string, unknown>,` |
| `packages/coding-agent/src/core/tools/agent.ts` | 268 | `const task: AgentTaskConfig & Record<PropertyKey, unknown> = {` |
| `packages/coding-agent/src/core/tools/agent.ts` | 282 | `const automaticWorktreeCwd = (normalized as AgentToolInput & Record<PropertyKey, unknown>)[` |
| `packages/coding-agent/src/utils/color-diff.ts` | 327 | `typeof (emitter as Record<string, unknown>).rootNode === "object" &&` |
| `packages/coding-agent/src/utils/color-diff.ts` | 328 | `(emitter as Record<string, unknown>).rootNode !== null &&` |
| `packages/coding-agent/src/utils/color-diff.ts` | 329 | `"children" in ((emitter as Record<string, unknown>).rootNode as object)` |
| `packages/coding-agent/src/utils/pierre-diff.ts` | 13 | `properties?: Record<string, unknown>;` |
| `packages/coding-agent/src/utils/pierre-diff.ts` | 19 | `options?: Record<string, unknown>,` |

### require-safety-comment-for-type-assertion

| File | Line | Source |
| --- | ---: | --- |
| `packages/agent/src/harness/progressive-disclosure.ts` | 64 | `const params = rawParams as ToolSearchParams;` |
| `packages/agent/src/harness/progressive-disclosure.ts` | 93 | `const params = rawParams as SkillSearchParams;` |
| `packages/agent/src/harness/session/search.ts` | 47 | `const cwd = (metadata as { cwd?: unknown }).cwd;` |
| `packages/ai/src/api/anthropic-server-tools.ts` | 40 | `return value as Readonly<Record<string, unknown>>;` |
| `packages/ai/src/api/anthropic-thinking-recovery.ts` | 19 | `if ((error as { status?: unknown })?.status !== 400) return false;` |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 94 | `return tool.anthropicServerTool as unknown as Anthropic.Messages.ToolUnion;` |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 103 | `const schema = tool.parameters as { properties?: { model?: { default?: string } } };` |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 106 | `return {` |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 114 | `const schema = tool.parameters as { properties?: JsonValue; required?: string[] };` |
| `packages/ai/src/api/anthropic-tool-serialization.ts` | 115 | `const properties = sortObjectKeysDeep(schema.properties ?? {}) as Record<string, unknown>;` |
| `packages/ai/src/api/tool-use-adjacency.ts` | 136 | `const fs = (process as ProcessWithNodeBuiltinModule).getBuiltinModule?.("node:fs");` |
| `packages/coding-agent/examples/extensions/build-interface-demo.ts` | 98 | `ctx.ui.notify(`Demo failed: ${(err as Error).message}`, "error");` |
| `packages/coding-agent/examples/extensions/build-interface-demo.ts` | 110 | `ctx.ui.notify(`Demo failed: ${(err as Error).message}`, "error");` |
| `packages/coding-agent/src/cli/agent-view-command.ts` | 89 | `const mod = (await jiti.import(specifier)) as Partial<AgentViewModule> & { default?: Partial<AgentViewModule> };` |
| `packages/coding-agent/src/cli/agent-view-command.ts` | 91 | `return typeof candidate?.runAgentViewCli === "function" ? (candidate as AgentViewModule) : undefined;` |
| `packages/coding-agent/src/cli/agent-view-command.ts` | 93 | `const code = (error as { code?: string } \| null)?.code;` |
| `packages/coding-agent/src/cli/agent-view-command.ts` | 145 | `const data = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: unknown };` |
| `packages/coding-agent/src/core/agents/chains.ts` | 82 | `raw = JSON.parse(readFileSync(path, "utf-8")) as RawAgentChainDefinition;` |
| `packages/coding-agent/src/core/agents/chains.ts` | 100 | `const item = step as Record<string, unknown>;` |
| `packages/coding-agent/src/core/agents/chains.ts` | 137 | `? (item.context as AgentTaskConfig["context"])` |
| `packages/coding-agent/src/core/agents/chains.ts` | 144 | `? (item.thinking as AgentTaskConfig["thinking"])` |
| `packages/coding-agent/src/core/agents/chains.ts` | 149 | `? (item.outputMode as AgentTaskConfig["outputMode"])` |
| `packages/coding-agent/src/core/agents/chains.ts` | 167 | `? (raw.context as AgentTaskConfig["context"])` |
| `packages/coding-agent/src/core/agents/chains.ts` | 172 | `? (raw.thinking as AgentTaskConfig["thinking"])` |
| `packages/coding-agent/src/core/agents/chains.ts` | 177 | `? (raw.outputMode as AgentTaskConfig["outputMode"])` |
| `packages/coding-agent/src/core/agents/context.ts` | 251 | `return clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;` |
| `packages/coding-agent/src/core/agents/engine.ts` | 53 | `return typeof intercom === "object" && intercom !== null && (intercom as Record<string, unknown>).hidden === true;` |
| `packages/coding-agent/src/core/agents/executor.ts` | 485 | `? (options.defaults.thinking as ThinkingLevel)` |
| `packages/coding-agent/src/core/agents/executor.ts` | 514 | `const custom = message as { role: string; customType?: string; content?: unknown };` |
| `packages/coding-agent/src/core/agents/executor.ts` | 530 | `(part as { type?: unknown }).type === "text" &&` |
| `packages/coding-agent/src/core/agents/executor.ts` | 531 | `typeof (part as { text?: unknown }).text === "string",` |
| `packages/coding-agent/src/core/agents/executor.ts` | 625 | `(part as { type?: unknown }).type === "text" &&` |
| `packages/coding-agent/src/core/agents/executor.ts` | 626 | `typeof (part as { text?: unknown }).text === "string",` |
| `packages/coding-agent/src/core/agents/executor.ts` | 703 | `const argRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;` |
| `packages/coding-agent/src/core/agents/executor.ts` | 717 | `const messages = session.messages as AssistantMessage[];` |
| `packages/coding-agent/src/core/agents/executor.ts` | 943 | `(task as NormalizedAgentTaskConfig & Record<PropertyKey, unknown>)[AUTOMATIC_WORKTREE_CWD] === true;` |
| `packages/coding-agent/src/core/agents/executor.ts` | 1393 | `const t = (child.usage as { totalTokens?: number } \| undefined)?.totalTokens;` |
| `packages/coding-agent/src/core/agents/executor.ts` | 1481 | `return (error as { details?: AgentRunDetails }).details;` |
| `packages/coding-agent/src/core/agents/loader.ts` | 98 | `if (typeof value === "string" && CONTEXT_MODES.has(value as ContextMode)) {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 99 | `return value as ContextMode;` |
| `packages/coding-agent/src/core/agents/loader.ts` | 111 | `if (typeof value === "string" && CACHE_PROFILES.has(value as AgentCacheProfile)) {` |
| `packages/coding-agent/src/core/agents/loader.ts` | 112 | `return value as AgentCacheProfile;` |
| `packages/coding-agent/src/core/agents/loader.ts` | 164 | `? (frontmatter.thinking as AgentDefinition["thinking"])` |
| `packages/coding-agent/src/core/bash-bg-jobs.ts` | 615 | `if ((err as { code?: string })?.code !== "ESRCH") {` |
| `packages/coding-agent/src/core/bash-bg-jobs.ts` | 794 | `const unref = (stream as unknown as { unref?: () => void } \| null)?.unref;` |
| `packages/coding-agent/src/core/cache-heartbeat.ts` | 275 | `this._emitCacheHeartbeatEvent(scope, model, event.message as AssistantMessage);` |
| `packages/coding-agent/src/core/context-file-imports.ts` | 555 | `visit(new Lexer({ gfm: false }).lex(content) as MarkdownToken[]);` |
| `packages/coding-agent/src/core/context-usage.ts` | 84 | `const { type } = part as { type?: unknown };` |
| `packages/coding-agent/src/core/context-usage.ts` | 87 | `const { text } = part as { text?: unknown };` |
| `packages/coding-agent/src/core/context-usage.ts` | 90 | `const { text } = part as { text?: unknown };` |
| `packages/coding-agent/src/core/context-usage.ts` | 93 | `const { name, args } = part as { name?: unknown; args?: unknown };` |
| `packages/coding-agent/src/core/context-usage.ts` | 97 | `const { result } = part as { result?: unknown };` |
| `packages/coding-agent/src/core/context-usage.ts` | 139 | `const assistant = entry.message as AssistantMessage;` |
| `packages/coding-agent/src/core/deferred-tool-capabilities.ts` | 26 | `const compat = model.compat as { supportsDeferredTools?: boolean } \| undefined;` |
| `packages/coding-agent/src/core/deferred-tool-capabilities.ts` | 38 | `const compat = model.compat as { supportsDeferredTools?: boolean } \| undefined;` |
| `packages/coding-agent/src/core/deferred-tools.ts` | 22 | `const message = rawMessage as MessageLike;` |
| `packages/coding-agent/src/core/deferred-tools.ts` | 33 | `return contentBlocks((content as { content: unknown }).content);` |
| `packages/coding-agent/src/core/deferred-tools.ts` | 41 | `(value as { type?: unknown }).type === "tool_reference" &&` |
| `packages/coding-agent/src/core/deferred-tools.ts` | 42 | `typeof (value as { name?: unknown }).name === "string"` |
| `packages/coding-agent/src/core/extensions/extension-api-fork.ts` | 36 | `return processServices.get(id) as T \| undefined;` |
| `packages/coding-agent/src/core/extensions/extension-api-fork.ts` | 113 | `return runtime.services.has(id) ? (runtime.services.get(id) as T) : getExtensionProcessService<T>(id);` |
| `packages/coding-agent/src/core/extensions/extension-api-fork.ts` | 128 | `return services.get(id) as T;` |
| `packages/coding-agent/src/core/extensions/extension-api-fork.ts` | 143 | `extension.defaultMessageRenderers.set(customType, renderer as MessageRenderer);` |
| `packages/coding-agent/src/core/extensions/extension-api-fork.ts` | 245 | `return runtime.extensionConfig[namespace] as T \| undefined;` |
| `packages/coding-agent/src/core/extensions/extension-api-fork.ts` | 327 | `const parse = (value: unknown): T \| undefined => (options.parse ? options.parse(value) : (value as T));` |
| `packages/coding-agent/src/core/extensions/extension-hooks.ts` | 101 | `current = await (filter.callback as FilterCallback<T>)(current, ...args);` |
| `packages/coding-agent/src/core/extensions/extension-hooks.ts` | 203 | `callback: callback as FilterCallback,` |
| `packages/coding-agent/src/core/session-liveness.ts` | 81 | `return (err as NodeJS.ErrnoException).code === "EPERM";` |
| `packages/coding-agent/src/core/session-liveness.ts` | 87 | `const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LivenessMarker>;` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 320 | `return JSON.parse(`"${raw}"`) as string;` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 467 | `message: { role: "user", content: rawStubContent(), timestamp } as AgentMessage,` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 481 | `message: {` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 498 | `message: {` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 512 | `message: {` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 527 | `message: {` |
| `packages/coding-agent/src/core/session-resident-prune.ts` | 667 | `const compactionEntry = path[compactionIndex] as CompactionEntry \| undefined;` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 183 | `const content = (messages[messageIndex] as { content: unknown[] }).content;` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 205 | `const content = "content" in message ? (message as { content?: unknown }).content : undefined;` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 231 | `content = [...(nextMessages[messageIndex] as unknown as { content: unknown[] }).content];` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 232 | `nextMessages[messageIndex] = { ...nextMessages[messageIndex], content } as T;` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 244 | `(block as { type?: unknown }).type === "image" &&` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 245 | `typeof (block as { data?: unknown }).data === "string"` |
| `packages/coding-agent/src/core/tool-artifacts.ts` | 293 | `if ((error as NodeJS.ErrnoException).code === "EEXIST") {` |
| `packages/coding-agent/src/core/tools/agent.ts` | 230 | `if (Array.isArray(candidate)) return candidate as NonNullable<AgentToolInput["tasks"]>;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 232 | `return [candidate] as NonNullable<AgentToolInput["tasks"]>;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 238 | `const input = params as AgentToolParams;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 247 | `tasks: tasks?.map((task) => normalizeAgentTaskAliases(task as AgentTaskParams, "tasks")),` |
| `packages/coding-agent/src/core/tools/agent.ts` | 248 | `chain: chain?.map((task) => normalizeAgentTaskAliases(task as AgentTaskParams, "chain")),` |
| `packages/coding-agent/src/core/tools/agent.ts` | 258 | `const tasks = normalized.tasks as AgentTaskConfig[] \| undefined;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 259 | `const chain = normalized.chain as AgentTaskConfig[] \| undefined;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 282 | `const automaticWorktreeCwd = (normalized as AgentToolInput & Record<PropertyKey, unknown>)[` |
| `packages/coding-agent/src/core/tools/agent.ts` | 787 | `const text = (context.lastComponent as Text \| undefined) ?? new Text("", 0, 0);` |
| `packages/coding-agent/src/core/tools/agent.ts` | 788 | `const state = (context.state ?? {}) as AgentRendererState;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 848 | `const state = (context.state ?? {}) as AgentRendererState;` |
| `packages/coding-agent/src/core/tools/agent.ts` | 853 | `const component = (context.lastComponent as Container \| undefined) ?? new Container();` |
| `packages/coding-agent/src/core/tools/bash-output.ts` | 172 | `details: { bgId, fullOutputPath: orphaned.fullOutputPath } as unknown as BashOutputToolDetails,` |
| `packages/coding-agent/src/core/tools/glob.ts` | 513 | `resolve(undefined as never);` |
| `packages/coding-agent/src/core/tools/glob.ts` | 526 | `formatGlobTimeoutResult({` |
| `packages/coding-agent/src/core/tools/glob.ts` | 649 | `formatGlobTimeoutResult({` |
| `packages/coding-agent/src/core/tools/glob.ts` | 711 | `const text = (context.lastComponent as Text \| undefined) ?? new Text("", 0, 0);` |
| `packages/coding-agent/src/core/tools/glob.ts` | 716 | `const text = (context.lastComponent as Text \| undefined) ?? new Text("", 0, 0);` |
| `packages/coding-agent/src/core/tools/glob.ts` | 717 | `text.setText(formatGlobResult(result as any, options, theme, context.showImages));` |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 62 | `const fn = (async (input: BuildInterfaceInput) => {` |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 108 | `const data = input.data as ExampleQuestionsData \| undefined;` |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 218 | `throw new HarnessParseError(`harness response is not valid JSON: ${(e as Error).message}`, raw);` |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 231 | `const v = value as Partial<LayoutGraph>;` |
| `packages/coding-agent/src/core/tools/ui-harness.ts` | 246 | `return value as LayoutGraph;` |
| `packages/coding-agent/src/modes/interactive/components/footer-usage.ts` | 118 | `? ((lastAssistantEntry.message as { provider?: string }).provider ?? "")` |
| `packages/coding-agent/src/modes/interactive/components/footer-usage.ts` | 120 | `lastAssistantEntry?.type === "message" ? ((lastAssistantEntry.message as { model?: string }).model ?? "") : "",` |
| `packages/coding-agent/src/modes/interactive/components/footer-usage.ts` | 122 | `? ((lastAssistantEntry.message as { responseModel?: string }).responseModel ?? "")` |
| `packages/coding-agent/src/modes/interactive/components/footer-usage.ts` | 129 | `? ((previousAssistantEntry.message as { model?: string }).model ?? "")` |
| `packages/coding-agent/src/modes/interactive/components/footer-usage.ts` | 150 | `? (lastAssistantEntry.message as { api?: string }).api` |
| `packages/coding-agent/src/modes/interactive/components/footer-usage.ts` | 154 | `? (lastAssistantEntry.message as { provider?: string }).provider` |
| `packages/coding-agent/src/modes/interactive/components/footer-usage.ts` | 158 | `? (lastAssistantEntry.message as { model?: string }).model` |
| `packages/coding-agent/src/modes/interactive/components/footer-usage.ts` | 162 | `? (lastAssistantEntry.message as { responseModel?: string }).responseModel` |
| `packages/coding-agent/src/modes/interactive/components/footer-usage.ts` | 168 | `? (previousAssistantEntry.message as { model?: string }).model` |
| `packages/coding-agent/src/modes/interactive/components/memory-saved-message.ts` | 47 | `const details = (message.details ?? {}) as MemorySavedDetails;` |
| `packages/coding-agent/src/utils/color-diff.ts` | 327 | `typeof (emitter as Record<string, unknown>).rootNode === "object" &&` |
| `packages/coding-agent/src/utils/color-diff.ts` | 328 | `(emitter as Record<string, unknown>).rootNode !== null &&` |
| `packages/coding-agent/src/utils/color-diff.ts` | 329 | `"children" in ((emitter as Record<string, unknown>).rootNode as object)` |
| `packages/coding-agent/src/utils/color-diff.ts` | 345 | `const emitter = (result as unknown as { emitter?: unknown }).emitter;` |
| `packages/coding-agent/src/utils/pierre-diff.ts` | 102 | `const pierre = (await import("@pierre/diffs")) as PierreDiffsModule;` |
