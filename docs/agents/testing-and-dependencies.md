# Testing and dependency safety

Read this before you install dependencies, run the checks, or drive interactive Pi behavior by hand.

## Commands

- Use npm. The root requires Node `>=24.14.0`.
- Run targeted tests for the touched surface. Do not run `npm test` unless the task explicitly requires the full suite, which bills paid API and e2e tests.
- Before push, run `npm run check`. It mutates formatting through Biome, so inspect the diff afterward.
- Use `npm run lint:fork-delta` for static fork-delta analysis. Its findings stay advisory until someone promotes them to a gate.
- Tests under `packages/ai/test/provider-capabilities.e2e.test.ts` spend real tokens. Never run them without explicit permission.
- Use `npm run test:build-gate` for the curated gate, which covers:
	- the system prompt
	- cache stability
	- the loader
	- e2e coverage
	- the my-pi extension

## Dependency and install safety

- Pin every dependency version exactly, because `npm run check:pinned-deps` rejects anything looser than an exact semver.
- Inspect a package before you add it by reading its npm page, its repository, its maintenance history, and the contents it actually ships.
- Do not run agent-initiated installs with lifecycle scripts enabled. Use `npm install --ignore-scripts`, and run a required lifecycle step only after you have inspected it and been given explicit approval. CI/release-owned scripts follow their reviewed workflow.
- Never delete or recreate `node_modules` as a first troubleshooting step. Diagnose the exact package or artifact first and get approval before reinstalling.

## Interactive mode

Use the controlled tmux flow documented in [`packages/coding-agent/docs/tmux.md`](../../packages/coding-agent/docs/tmux.md). Start Pi through `./pi-test.sh` and capture both startup and response output. Always close the test session afterwards.
