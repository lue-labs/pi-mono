# Pi Mono Fork

This npm-workspace fork of Pi carries Luke's minimal, upstream-compatible extension seams and the packages used by `my-pi`.

- Prefer an extension or Pi package in `~/Projects/personal/my-pi` over changing `packages/coding-agent` core; record the missing seam before a core change.
- Use Node `>=24.14.0`. Before push, run `npm run check`; run targeted tests rather than `npm test`, which includes paid API/e2e coverage.
- Never edit generated model files directly; run the generators through `npm run generate:models`.

## Read when

| Task | Read |
|---|---|
| Pi behavior, extensions, hooks, filters, TypeScript, models, or setup registry | [Code conventions](docs/agents/code-conventions.md) and the relevant [coding-agent docs](packages/coding-agent/docs/index.md) |
| Installing dependencies, testing, typechecking, building, or interactive TUI checks | [Testing and dependency safety](docs/agents/testing-and-dependencies.md) |
| Branches, commits, PR review, issues/comments, or GitHub Actions | [GitHub and collaboration workflow](docs/agents/github-workflow.md) and [CONTRIBUTING.md](CONTRIBUTING.md) |
| Changesets, changelogs, package publication, binaries, or releases | [Releases and change records](docs/agents/releases-and-changes.md) |
| Opening, updating, or declaring a PR ready | `~/Projects/personal/my-pi/docs/review-guidelines.md` |

If a user request conflicts with a local rule, ask for explicit confirmation before overriding it.
