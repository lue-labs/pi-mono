---
"@lue-labs/pi-ai": patch
"@lue-labs/pi-coding-agent": patch
---

Name the types at three provider boundaries and stop spreading empty objects.

Installing the anti-slop Oxlint ruleset over fork-owned source surfaced a cluster of findings that all described the same habit: values crossing a provider boundary were inspected inline and their shapes were never named.

`summarizeServerToolResult` was the worst case. It asserted `as Record<string, unknown>` eight times across a 68-line function and returned an anonymous object type, so every caller re-derived the shape and no single place established what had actually been checked. The shape inspection now happens in two small readers, and the result type is `ServerToolResultSummary`. `stripThinkingFromLatestAssistantTurn` gained `ThinkingStripResult` for the same reason, and the schema walker in the tool serializer is now typed with an exported `JsonValue` instead of `unknown` plus an internal cast.

Separately, `glob` and `bash-bg-jobs` built optional fields with conditional empty-object spreads, which reads as though the key might be absent when the intent was a plain optional assignment.

All of this is behavior-preserving. The cache-split and server-tool changes were checked against their previous implementations across generated input sets (20 and 88 cases respectively) and produce identical output; the remaining changes are type-level or local naming. New exported types are additive.
