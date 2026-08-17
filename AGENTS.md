# Pi Mono Fork

This npm-workspace fork of Pi carries Luke's minimal, upstream-compatible extension seams and the packages used by `my-pi`.

- Reach for an extension or a Pi package in `~/Projects/personal/my-pi` before you change `packages/coding-agent` core, and record the missing seam whenever a core change turns out to be unavoidable.
- Build on Node `>=24.14.0` and run `npm run check` before every push, choosing targeted tests over `npm test` because the full suite bills paid API and e2e coverage.
- Regenerate model files through `npm run generate:models` rather than editing the generated output by hand.

## Read when

| Task | Read |
|---|---|
| Pi behavior, extensions, hooks, filters, TypeScript, models, or setup registry | [Code conventions](docs/agents/code-conventions.md) and the relevant [coding-agent docs](packages/coding-agent/docs/index.md) |
| Installing dependencies, testing, typechecking, building, or interactive TUI checks | [Testing and dependency safety](docs/agents/testing-and-dependencies.md) |
| Branches, commits, PR review, issues/comments, or GitHub Actions | [GitHub and collaboration workflow](docs/agents/github-workflow.md) and [CONTRIBUTING.md](CONTRIBUTING.md) |
| Changesets, changelogs, package publication, binaries, or releases | [Releases and change records](docs/agents/releases-and-changes.md) |
| Opening, updating, or declaring a PR ready | `~/Projects/personal/my-pi/docs/review-guidelines.md` |

If a user request conflicts with a local rule, ask for explicit confirmation before overriding it.
