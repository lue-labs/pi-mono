# Pi transcript-memory investigation — 2026-08-17

Correlation: `pi-memory-transcript-20260817`

## Finding

Compaction and resident memory are separate. Compaction makes `buildSessionContext()` omit old entries from the provider context, but it does not delete the durable JSONL. In vanilla upstream, `SessionManager` also retains those old entry payloads in its `fileEntries` array, so heap can track full transcript size even though the model context is small.

The fork already has resident pruning and Luke's `pii` settings enable it:

```json
{"compaction":{"enabled":true,"triggerTokens":200000,"keepRecentTokens":10000,"residentPrune":true}}
```

After a successful compaction it stubs summarized resident entry payloads, then `AgentSession` rebuilds `agent.state.messages` from the compacted context. The JSONL is untouched. `appendMessage()` intentionally stores the same message object in the session entry and agent state; this is aliasing, not duplicated large text. Before compaction, the two arrays point at the same payload; after compaction, the agent array no longer points at summarized messages.

`OutputAccumulator` is not the retention source in this workload: it bounds rolling decoded text, discards `rawChunks` when switching to a file, and the existing benchmark records 41.02 MiB streamed with only 0.32 MiB retained heap after GC.

## Reproducible measurements

Commands run from `packages/coding-agent` after `npm run build:ts`:

```bash
npm run memory:audit -- --pi ./dist/cli.js --skip-vmmap \
  --resident-probe-iterations 5 --out-prefix /tmp/pi-memory-transcript-baseline
node --inspect=0 --expose-gc scripts/pi-transcript-memory-inspect.mjs
```

### Five-process median: one heavy compaction epoch

The built-in audit used 80 ordinary messages followed by 80 large (256 KiB) tool-result turns, then forced GC around compaction/pruning.

| phase | RSS MiB | heap used MiB | resident payload MiB |
|---|---:|---:|---:|
| after compaction, before prune | 268.5 | 63.0 | 22.75 |
| after prune + GC | 260.0 | 41.4 | 0.64 |
| change | -8.5 (-3.2%) | -21.6 (-34.3%) | -22.11 (-97.2%) |

The heap reduction is real. The much smaller RSS reduction is expected V8 allocator behaviour: V8 has freed reusable JS heap pages, but macOS RSS is not a reliable claim that those pages were returned to the OS. RSS alone therefore overstates the apparent leak.

### Three-compaction `--inspect` workload

The new probe creates three epochs of 20 tool results at 256 KiB each, compacts after every epoch, and takes snapshots in fresh pre- and post-prune child processes so snapshot allocation cannot contaminate the RSS/heap samples.

| phase | RSS MiB | heap used MiB | heap total MiB | resident payload MiB |
|---|---:|---:|---:|---:|
| before prune | 222.3 | 50.8 | 88.9 | 10.82 |
| after prune + GC | 212.3 | 40.5 | 77.8 | 0.42 |
| change | -10.0 | -10.3 | -11.1 | -10.40 |

Heap-snapshot attribution uses the synthetic `TRANSCRIPT_MEMORY_MARKER` in each tool result:

| snapshot | marker strings | marker self size MiB | all string self size MiB |
|---|---:|---:|---:|
| before prune | 61 | 10.78 | 32.55 |
| after prune | 3 (kept tail) | 0.38 | 22.14 |

This attributes the removed bytes to transcript tool-result strings held by session entries, not to a leaked `OutputAccumulator` buffer or a duplicate `agent.state.messages` copy. The JSONL hash was unchanged in both measurements.

## Behaviour guard fixed here

Resident pruning previously made a live `/export` embed placeholders, despite the complete text being present in JSONL. Export now reads the durable file directly. The same recovery is performed before `/tree` rewinds into a pruned entry, so it restores original branch context rather than continuing from placeholders. Targeted tests cover both paths and assert the JSONL remains unchanged.

## Interpretation for Luke's PID sample

A 191–370 MB RSS range on a roughly 200 MB baseline is consistent with normal Node/V8 process capacity plus extension/TUI/native allocations; it is not evidence by itself of a runaway heap leak. For `pii` with resident pruning on, inspect `heapUsed` (or a snapshot) before concluding that compaction failed. For vanilla `pi`, the full-transcript retention described above remains expected until it adopts pruning.

## Fork → vanilla assessment

`upstream/main` at `f47faf459` has no `session-resident-prune.ts`, no RSS audit, and no `tool-artifacts.ts`; `OutputAccumulator` is byte-identical. The upstreamable work is therefore narrow and independent of Luke-specific runtime policy.

### Clean upstreamable series

1. **`coding-agent: add opt-in resident session pruning after compaction`**
   - Add generic `SessionHydrationOptions`/`LoadEntriesFromFileOptions`, a raw JSONL metadata plan, paired tool-call/result protection, and an in-memory prune operation.
   - Do not add fork settings, `PI_*` policy defaults, cache-heartbeat, extensions, or Luke-specific artifact paths.
   - Initially default off upstream; include durable JSONL hash, provider-context, reload, fork, and malformed-file tests.
2. **`coding-agent: restore durable transcript for export and rewind`**
   - Make HTML export read durable JSONL and rehydrate before navigating into a pruned branch.
   - This is required for an upstream-safe retention feature, not fork policy.
3. **`coding-agent: add synthetic resident-memory audit`**
   - Ship the fixture-free audit/three-compaction inspector probe as a developer script. It uses no provider and no private transcripts.
4. **Optional later: promote the default only with upstream production telemetry.**
   - Keep the switch conservative until the upstream project chooses its memory/rewind trade-off.

### Do not upstream as part of this series

- Fork model-facing text/image artifact policy in `tool-artifacts.ts`: useful, but it changes tool-result persistence and depends on `.pi/tool-results` / `.pi/tool-artifacts` behaviour.
- Cache heartbeat, model routing, extension hook policy, `my-pi` profile defaults, and Claude-bridge observability: fork-only surfaces.
- A native/Rust transcript scanner: current evidence is scanner microbenchmark evidence, not a resident-memory requirement. Keep it out of the correctness patch series.
- `OutputAccumulator` changes: no retention evidence supports them; upstream already has the bounded implementation.

No push to `upstream` was attempted.
