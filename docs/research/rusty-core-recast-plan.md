# Rusty core recast: evidence and staged migration plan

## Decision

Do not rewrite Pi coding-agent in Rust. Recast one narrow boundary first: the raw JSONL metadata scan in `packages/coding-agent/src/core/session-resident-prune.ts` that supports resident-history pruning on long sessions.

The probe shows a material CPU and allocation opportunity at that boundary. It does not show that Rust helps the TUI, provider I/O, or tool buffering. Keep those in TypeScript until their own profiles prove otherwise.

## Evidence

| workload | result | meaning |
| --- | --- | --- |
| Isolated RPC startup, Node, five measured runs | median 1,063.3 ms; min 871.9 ms; max 1,342.1 ms | Startup is mostly module/file loading: selected CPU profile samples `read` (13.6%), module compilation (8.3%), `readFileUtf8` (7.4%), and `open` (5.7%). Rust does not address this directly. |
| Resident transcript metadata scan, 9.0 MiB generated captain-style JSONL, 3,603 non-header entries | production TypeScript median 39.36 ms; Rust sidecar median 9.17 ms; 4.29x | Strong candidate for a native boundary. Rust now validates JSON with `serde_json`; its time includes a fresh process spawn and JSON result parsing, so it is a conservative sidecar number. |
| Same scan, 50 sequential TypeScript scans | observed heap +84.96 MiB; observed RSS +38.91 MiB; retained heap after forced GC +0.02 MiB | The scan creates substantial transient allocation/GC pressure, but this run does not show retained growth. |
| `OutputAccumulator`, 41.02 MiB streamed in 3,000 chunks with frequent snapshots | 66.92 ms; observed heap +5.79 MiB; observed RSS +17.41 MiB; retained heap +0.32 MiB | Current tool-result buffering remains bounded after GC. Optimize its snapshot frequency or string work only if an interactive profile makes it a visible stall. |
| Native addon spike, raw C N-API shim plus Rust planner | one arm64 `.node` artifact loads and passes compact-plan/fallback smoke tests on Node 26.3.1 and Bun 1.3.11 | The narrow synchronous addon seam is technically viable without a new crate or runtime integration. This is compatibility evidence, not an end-to-end resume benchmark. |
| Fresh controlled live TUI trace, clawrouter / gpt-5.6-terra, 600-word 12-point no-tool prompt | visible response reached 4,047 output tokens at 51.8 tok/s after 78.2 s; 622,911 ANSI-write bytes; 2.90 MiB CPU profile; 95.0 s fixed-window wall time | Native TUI work remains unproven. The trace includes startup and a recoverable `pi-memory` SQLite ABI warning; its forced teardown left `/usr/bin/time` output empty. |
| Offline TUI write-volume proxy, fixed 80x24 transcript, three fresh pseudo-terminal runs | median 1,001 ANSI bytes; 731 plain bytes; 45 control sequences; 291.1 ms wall; 9.0 ms user CPU | `tui-write-volume.mjs` establishes a reproducible rendering/write baseline, not interactive or provider-session performance. |

The Node CPU profile for the original transcript benchmark places the TypeScript scanner's own work in `extractJsonStringField` (15.4% of sampled time), `extractLastJsonStringField` (4.6%), individual field regexes, JSON string decoding, and `readSessionFileLines`. `spawnSync` is 40.3% of that earlier mixed benchmark, which reinforces that the production design must not ship as a per-call process.

Artifacts:

- Benchmark: `docs/research/rusty-core-recast-prototype-benchmark.md`
- Rust prototype: `experiments/rusty-core-recast/`
- Node CPU profiles: `/tmp/rusty-recast-cpu/resident-scanner.cpuprofile` and `/tmp/rusty-recast-startup-profile/rusty-recast-rpc-002.cpuprofile`
- Source boundary: `packages/coding-agent/src/core/session-resident-prune.ts`
- Tool buffer source: `packages/coding-agent/src/core/tools/output-accumulator.ts`

## Recast boundary

`buildResidentLoadPrunePlan()` reads a durable JSONL transcript, extracts only the metadata needed to decide which historical entries can be stubbed, and returns a plan used during hydration. The durable session file stays unchanged. That is a clean ownership boundary: local file input, deterministic metadata/plan output, no provider call, no TUI state, and an existing TypeScript implementation that can remain the fallback.

The counter benchmark is only a scanner probe. It now validates JSON through `serde_json`, but `BufRead::lines()` can still allocate one oversized physical JSONL line. It compares counters from production `readSessionFileLines()` plus `metadataForSessionLine()` and does not measure end-to-end hydration.

The follow-up planner probe uses `serde_json` from the local Cargo cache and returns only a file fingerprint, candidate IDs, protected IDs, and compact stub metadata. Its executable corpus freezes timestamps as raw strings and compares those deterministic fields against `buildResidentLoadPrunePlan()` across malformed lines, whitespace/escaped JSON, branches, split tool pairs, every stub-capable entry kind, and all other known session entry kinds. It does not construct hydrated JavaScript entries or wire into `SessionManager`.

The addon spike is `experiments/rusty-core-recast/src/lib.rs` plus `src/native-addon.c`. Its hand-written C shim follows Pi's existing Darwin modifier addon: it dynamically resolves N-API symbols, exposes `scanResidentTranscript(path)`, and delegates parsing/planning to Rust. The `cdylib` exports one macOS arm64 `.node` artifact; experiment-local `native-addon.mjs` parses its JSON result and `native-addon-smoke.mjs` proves default compact-plan parity and malformed-transcript fallback on both supported runtimes. It does not fetch `napi-rs` or add package/release work.

A shipping implementation should keep this a native addon or a long-lived worker behind a TypeScript facade, never a per-call sidecar. The recommended facade is an internal `scanResidentTranscript(filePath): ResidentLoadPrunePlan | undefined` with the current implementation as a fallback. The native side owns only byte scanning and compact plan calculation; TypeScript keeps session ownership, stub construction, policy switches, persistence, and compatibility handling.

## Staged plan

1. **Lock behavior before moving it — complete for the experiment.** `experiments/rusty-core-recast/parity.mjs` has a deterministic corpus covering branches, escaped/whitespace JSON, malformed lines, split tool pairs, compaction boundaries, both pruning options, every stub-capable entry kind, and all other known session entry kinds. It compares candidate IDs, protected IDs, and only stub-construction metadata. Timestamp fallback stays outside this comparison: unparseable timestamps require an injected clock or explicit normalization before any production parity gate. TypeScript remains the default.
2. **Turn the planner probe into an addon or worker spike — addon spike complete.** `src/lib.rs` exposes the Rust planner through a raw-C N-API shim in `src/native-addon.c`; `build.rs` compiles it with macOS dynamic N-API lookup and exports `napi_register_module_v1`. A single arm64 `.node` artifact loads on Node 26.3.1 and Bun 1.3.11, and the smoke runner proves compact default-plan parity plus malformed-transcript fallback. It remains experiment-only: a production candidate still needs a packaging/ABI policy, binary-size and transport measurements, an explicit TypeScript fallback, and end-to-end hydration proof.
3. **Integrate behind an explicit opt-in.** Add one facade at `session-resident-prune.ts`; route only opt-in local sessions through it. Fall back to TypeScript on load, parse, ABI, fingerprint, or parity failure and record structured diagnostics. Verify no durable JSONL changes and no altered tool-pair protection.
4. **Promote only after long-session evidence.** Run representative captain sessions with heap snapshots before/after compaction and resume, CPU profiles around `loadEntriesFromFile(path, { residentPrune: true })`, and retained-RSS checks. Promote the native path only if it improves the measured end-to-end resume path without changing transcript behavior.
5. **Run the TUI optimisation review as a separate phase — first controlled trace complete.** `tui-write-volume.mjs` captures an isolated offline pseudo-terminal workload with `PI_TUI_WRITE_LOG`, CPU metadata, terminal-write volume, and eight explicit render requests. `controlled-tui-trace.mjs` runs the live workload in detached tmux with a fresh session directory, explicit `--approve`, explicit provider/model arguments, write log, CPU profile, pane capture, and isolated artifacts. The approved clawrouter / gpt-5.6-terra response reached 4,047 output tokens at 51.8 tok/s after 78.2 s; the fixed 90 s window wrote 622,911 ANSI bytes. The trace includes startup and a recoverable `pi-memory` SQLite ABI warning, and forced teardown prevented macOS `/usr/bin/time` from flushing. It does not justify a Rust TUI recast. Recast no TUI code unless a later profile isolates a pure CPU transform whose native boundary beats the crossing cost.

## Acceptance gates

- Rust and TypeScript agree on deterministic planner fields in the corpus; timestamp fallback has a frozen/injected policy before full parity.
- Session JSONL hashes stay unchanged after hydration/pruning.
- Tool-call/tool-result pairing stays valid after every prune plan.
- The production addon or worker has no per-call process spawn, loads under supported Node and Bun targets, and has a tested TypeScript fallback for unsupported ABI/platform cases.
- The end-to-end long-session profile, not the microbenchmark, demonstrates a meaningful resume or compaction gain.
- TUI work has independent profile evidence and does not ride in the transcript-scanner change.

## Rusty-core alignment

`~/Projects/personal/rusty-core` is not an integration target for this Pi experiment. Its local `main` includes all eight P4 remediation commits and its offline workspace tests plus O1–O4 proof scripts pass. The formal P4 status remains **v0.1 NO-GO** until a fresh independent review returns non-FAIL. Its current `cargo clippy --workspace --all-targets -- -D warnings` also fails under Rust 1.97 on `clippy::map_unwrap_or` in `crates/rustyd-store/src/log.rs`; no changes were made there. The useful shared lesson is architectural, not code reuse: preserve a compact seam, pinned/fallback behavior, and cache-sensitive ownership in TypeScript.

## Morning report

**Recommendation:** fund a narrow Rust addon experiment for resident transcript metadata scanning; do not start a core rewrite.

**What works now:** `experiments/rusty-core-recast/` builds from the offline Cargo cache, validates scanner counters against the production TypeScript scanner, and writes the benchmark above. On the 9.0 MiB long-session fixture, the JSON-validating Rust sidecar finishes in 9.17 ms median versus 39.36 ms for the existing scanner. The TypeScript path creates high transient allocation but retains almost none after forced GC. The follow-up planner probe has deterministic compact-plan parity; it still does not validate native stubs or end-to-end hydration.

**What not to infer:** the result does not prove an interactive TUI benefit, a provider-loop benefit, or a tool-buffer leak. The TUI proxy measures a fixed terminal-write workload only. The startup profile also says startup is I/O/module-load dominated. A full Rust core rewrite would be expensive theatre at this point.

**First morning decision:** the addon spike and parity corpus now prove the narrow ABI seam; reject any promotion until packaging, fallback, and end-to-end hydration evidence exist. Keep the real TUI trace as its own next phase.
