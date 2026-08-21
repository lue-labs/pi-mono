# Rusty core recast prototype benchmark

- Fixture: generated captain-style JSONL, 3 603 entries, 9.0 MiB.
- Contract exercised: scan a session JSONL and return entry/message/tool-result/compaction counts.
- Production TypeScript scanner and Rust prototype returned identical counters.
- Environment: v26.3.1; rustc 1.97.1 (8bab26f4f 2026-07-14); darwin/arm64.
- Measurement: 3 warmups, 9 end-to-end samples. Rust timing includes process startup and JSON output parsing; it is a conservative sidecar comparison.
- Raw samples: TypeScript [38.80, 40.67, 39.20, 40.18, 39.95, 39.81, 39.36, 38.39, 37.67]; Rust [9.15, 9.17, 8.93, 9.62, 9.52, 9.18, 9.21, 9.16, 9.03].
- TypeScript scanner heap over 50 sequential scans: observed heap +84.96 MiB, observed RSS +38.91 MiB, retained heap after forced GC 0.02 MiB.

| implementation | min ms | median ms | max ms |
| --- | ---: | ---: | ---: |
| TypeScript `readSessionFileLines` + `metadataForSessionLine` | 37.67 | 39.36 | 40.67 |
| Rust sidecar scanner | 8.93 | 9.17 | 9.62 |

Rust sidecar median speedup: 4.29x.

This is a scanner probe, not evidence of end-to-end resident-session hydration improvement. The prototype validates JSON with `serde_json`, but can allocate one physical JSONL line. The production candidate must preserve the existing session metadata and prune-plan semantics, use an addon or long-lived worker to avoid per-call spawn cost, and pass shared corpus parity tests before any replacement.

The experiment now includes a raw-C N-API addon shim that delegates default planner calculation to the same Rust code. One macOS arm64 artifact loaded and passed compact-plan plus malformed-transcript fallback smoke tests under Node v26.3.1 and Bun 1.3.11. That validates the direct synchronous ABI boundary without downloading `napi-rs`; it does not measure addon transport cost, binary size, or `loadEntriesFromFile()` latency.

A separate fresh controlled TUI trace used clawrouter / gpt-5.6-terra with the approved 600-word, 12-point, no-tool workload. The visible response reached 4,047 output tokens at 51.8 tok/s after 78.2 seconds. Its fixed 90-second window wrote 622,911 ANSI bytes and produced a 2.90 MiB Node CPU profile. The trace includes startup plus a recoverable `pi-memory` SQLite ABI warning, and forced teardown prevented `/usr/bin/time` from flushing. It is evidence for a later TUI profile, not evidence for native rendering work.
