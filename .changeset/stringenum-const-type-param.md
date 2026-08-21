---
"@valkyriweb/pi-ai": patch
---

Make `StringEnum` infer the literal union it documents.

The helper's doc comment promises `Static<typeof OperationSchema>` yields `"add" | "subtract" | ...`, but the type parameter was declared `<T extends readonly string[]>`. TypeScript widened a bare array literal to `string[]`, so `T[number]` collapsed to `string` and every derived static type lost its enum. Call sites only kept their unions by writing `as const`, which reads as a stylistic habit rather than the load-bearing annotation it had become; anyone who omitted it got a schema that still emitted the right JSON while its static type silently degraded to `string`.

A `const` type parameter restores the documented behavior for both spellings, and leaves non-literal `string[]` values inferring `string` as before. The emitted schema is unchanged — this is a type-level fix only.
