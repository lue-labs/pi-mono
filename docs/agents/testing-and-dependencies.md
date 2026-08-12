# Testing and dependency safety

Read when installing dependencies, running checks, or testing interactive Pi behavior.

## Commands

- Use npm. The root requires Node `>=24.14.0`.
- Run targeted tests for the touched surface. Do not run `npm test` unless the task explicitly requires the full suite; it includes paid API/e2e tests.
- Before push, run `npm run check`. It mutates formatting through Biome, so inspect the diff afterward.
- Use `npm run lint:fork-delta` for static fork-delta analysis; findings are advisory until explicitly promoted to a gate.
- Tests under `packages/ai/test/provider-capabilities.e2e.test.ts` spend real tokens. Never run them without explicit permission.
- Use `npm run test:build-gate` for the curated system-prompt, cache-stability, loader, e2e, and my-pi-extension gate.

## Dependency and install safety

- Pin dependency versions exactly; no `^`, `~`, tags, or loose ranges.
- Inspect a package before adding it: npm package page, repository, maintenance, and package contents.
- Do not run agent-initiated installs with lifecycle scripts enabled. Use `npm install --ignore-scripts`; run a required lifecycle step only after inspecting it and receiving explicit approval. CI/release-owned scripts follow their reviewed workflow.
- Never delete or recreate `node_modules` as a first troubleshooting step. Diagnose the exact package or artifact first and get approval before reinstalling.

## Interactive mode

Use the controlled tmux flow documented in [`packages/coding-agent/docs/tmux.md`](../../packages/coding-agent/docs/tmux.md). Start Pi through `./pi-test.sh`, capture startup and response output, and always close the test session.
