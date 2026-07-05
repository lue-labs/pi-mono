---
"@valkyriweb/pi-coding-agent": patch
---

Fix `pi agents` CLI dashboard loader to import `createJiti` from `jiti/static`
instead of `jiti`. The dynamic `jiti` entry lazy-requires its babel transform
via a relative path at runtime, which does not exist inside the compiled Bun
binary (only statically-declared imports get bundled into it), so every
attempt to load the agent-view module failed with `Cannot find module
'../dist/babel.cjs'` and was silently swallowed, surfacing as `pi agents`
requires the pi-agent-view package` even when the package was installed and
enabled. This is the third part of the fix (alongside the scoped package-name
resolver match and the shared jiti alias/virtualModules config) required for
`pi agents` to actually launch in a real installed-bundle environment.
