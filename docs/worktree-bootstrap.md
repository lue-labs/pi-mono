# Fresh worktrees and non-fatal extension loading

Two things exist because of one incident. This note records the diagnosis so the
next person does not re-derive it.

## The incident

On 2026-08-18 an agent could not be started in a fresh `pi-mono-fork` worktree at
all. Six attempts, every one reporting the same single line:

```
{"error":{"code":"timeout","message":"timed out waiting for agent startup"}}
```

Underneath that one message were **four distinct failures**, each hidden by the
next. Fixing one only revealed the following one:

1. A fresh worktree has no `node_modules`, so pi died loading `.pi/extensions/*.ts`.
2. A bug in the launcher's install step swallowed the install output, so failure 1
   was invisible. (Fixed on the launcher's side.)
3. Dependencies installed, but the workspace packages were **unbuilt**. The repo's
   own dev extensions import `@valkyriweb/pi-tui/dist`, which npm links but never
   builds.
4. The build then failed: `packages/ai/src/providers/data/*.json` is generated and
   gitignored, and the manifest it needs is `.manifest.json` — a **dotfile**. A
   `*.json` copy silently misses it, so the directory looks fully populated and the
   build still reports "model data is missing or stale".

The root defect was in pi, not the launcher: **a repo-local extension that failed
to load took the whole process down.** Two dev conveniences in `.pi/extensions/`
therefore made this repo unusable for anyone until a full nine-package build had
run.

## 1. Extension load failures are non-fatal when auto-discovered

`packages/coding-agent/src/core/extensions/load-diagnostics.ts` holds the policy.

| How the extension got there | On load failure |
|---|---|
| Found by scanning `.pi/extensions/`, the agent dir, or a configured directory | **Warning, skipped, startup continues** |
| Named with `-e <path>` | **Fatal, exit 1** |
| Named in a settings entry (`extensions: [...]`) | **Fatal, exit 1** |
| Provided by a package manifest | **Fatal, exit 1** |

The split is deliberate. Auto-discovered extensions are conveniences that nobody
asked for by name, so one being broken should degrade rather than stop the
process. Anything the user *did* name should keep failing loudly — silently
dropping a requested extension is worse than exiting.

Non-fatal does not mean quiet. A skipped extension prints its path and the
original underlying error:

```
Warning: Skipped extension "/repo/.pi/extensions/redraws.ts": Failed to load extension: Cannot find module '@valkyriweb/pi-tui'
Hint: those extensions were auto-discovered and were skipped, not loaded. Set PI_STRICT_EXTENSIONS=1 to make this fatal.
```

and it stays listed in interactive mode's loaded-resources panel.

Set `PI_STRICT_EXTENSIONS=1` to restore the old behaviour where every load failure
is fatal. Use it in CI, where a skipped extension could otherwise hide a real
regression.

The flag travels as `discovered` on `ExtensionLoadRequest` and `ExtensionLoadError`,
set in `resource-loader.ts` from the resource's own metadata (`source: "auto"` plus
`origin: "top-level"` is the directory scan) and in `discoverAndLoadExtensions`.
When the same file is both auto-discovered and passed with `-e`, the explicit
request wins and the failure stays fatal.

Tests: `packages/coding-agent/test/extension-load-failure-severity.test.ts`.

## 2. `scripts/bootstrap-worktree.sh`

`git worktree add` gives you source only. Two required artifacts are absent and
neither is obvious from the failure they cause:

- `node_modules` (never committed)
- `packages/ai/src/providers/data/` (generated, gitignored)

Run:

```sh
./scripts/bootstrap-worktree.sh
```

It runs `npm install`, populates the model data, and runs `npm run build:offline`.
Each step is idempotent and re-running is safe; steps 2 and 3 are skipped when
their output already validates.

Model data is copied from a sibling checkout when one is available, because
regenerating it requires network access to the model catalogs:

```sh
./scripts/bootstrap-worktree.sh --from ~/Projects/personal/pi-mono-fork   # default
./scripts/bootstrap-worktree.sh --hydrate                                 # regenerate instead
```

The copy is validated after it lands. A sibling sitting on a different commit
produces a manifest whose `structureHash` does not match this worktree's provider
sources, and the script falls back to hydrating rather than leaving you with data
that fails at build time.

**A fifth layer, found by running the script.** `npm run build:offline` was not
offline. Its last leg was `cd ../coding-agent && npm run build`, and
coding-agent's `build` re-enters `npm --prefix ../ai run build`, whose first step
is `generate-models` — a network fetch of models.dev, NVIDIA NIM and OpenRouter.
The offline target therefore rebuilt the model data online, undoing the `ai`
offline build it had already done correctly earlier in the same chain. It now uses
coding-agent's `build:ts`, matching what the non-offline root `build` already did.
This surfaced on the first real run of the bootstrap script against a clean
worktree, not from reading the scripts.

**The dotfile trap.** The copy uses `cp -R "$src/." "$dst/"`, not a `*.json` glob.
`.manifest.json` is a dotfile; a glob misses it, and you then get "model data is
missing or stale" from a directory that looks complete. That is failure 4 above,
and it is commented in the script at the copy.

Every failure path in the script names the specific missing artifact rather than
reporting a generic bootstrap failure — the whole lesson of the incident is that
one generic message hid four separate problems.
