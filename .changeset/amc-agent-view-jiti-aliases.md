---
"@valkyriweb/pi-coding-agent": patch
---

Fix `pi agents` still failing to actually load the `pi-agent-view` package
after the resolver found it (#205): `cli/agent-view-command.ts`'s standalone
jiti loader had no `virtualModules`/`alias` configuration, unlike the main
extension loader (`core/extensions/loader.ts`), so it could resolve the
agent-view entrypoint file itself but then failed on that file's own
`@valkyriweb/pi-coding-agent` / `@valkyriweb/pi-tui` imports whenever the
installed `node_modules` layout didn't have a package literally named that
(e.g. npm peer-conflict dedup renaming) — falling all the way through to
`Error: pi agents requires the pi-agent-view package`. Extracted the shared
resolution options into `getExtensionJitiResolutionOptions()` and reused it
in both loaders, so drift between the two can't recur (mirrors the existing
`loader-module-alias-symmetry.test.ts` guard for the main loader's own two
branches). Found and reproduced during agents-mission-control live
verification, after #205 alone still didn't unblock a real `pi agents`
launch against the installed `@valkyriweb/my-pi-full` bundle.
