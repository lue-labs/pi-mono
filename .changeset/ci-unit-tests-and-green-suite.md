---
"@lue-labs/pi-coding-agent": patch
---

Run the unit test suite on pull requests, and fix the four regressions it had been hiding.

No CI job ever ran the tests on a PR: `fork-safety-check` covers lint, typecheck, build and a CLI smoke, while `release.yml` runs three targeted suites *after* code has already landed on main. Adding a `unit-tests` job to `ci.yml` surfaced 27 failures on a clean main:

- **Bash tool crashed on a partial extension context.** `resolveSpawnContext` and `execute` called `ctx.sessionManager.getSessionId()` / `.getSessionFile()` unguarded. The typed contract requires a session manager, but SDK embedders and untyped extension hosts can pass a partial context, and losing best-effort `PI_*` decoration must not fail the turn with a `TypeError`.
- **The fork identified itself as the official distribution.** `OFFICIAL_PACKAGE_NAME` names the *upstream* package so the fork can tell it is not upstream; blanket `@earendil-works` → `@valkyriweb` scope sweeps during upstream merges rewrote it into a self-reference, making `isOfficialDistribution()` always true and re-enabling official-only first-time setup on the fork. This had regressed three times and been hand-fixed each time, because the test that catches it never ran.
- **`ultra` tier alias pointed at a model that does not exist.** Retiring GPT-5.4/5.5 left `ultra: ["gpt-5.6"]` on `openai` and `azure-openai-responses`; the catalog only ships the luna/terra/sol family. Now an empty list, matching google/xai/bedrock, so `ultra` falls back to the parent model instead of resolving to nothing.
- **A Cloudflare test pinned a literal model id.** The generated catalog is rebuilt from live provider data, so the pinned id vanished when the provider retired it. Now selected by capability, per the `test/helpers/models.ts` policy.
