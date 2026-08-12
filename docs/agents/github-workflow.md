# GitHub and collaboration workflow

Read when changing branches, reviewing a PR, editing GitHub Actions, or writing issues/comments.

## Git safety

- Check `git status` before and after edits. Assume unexpected changes belong to another agent; never revert them.
- Do not run destructive Git commands—`git reset --hard`, `git clean`, forced checkout/restore—or bypass hooks with `--no-verify`.
- Do not amend commits unless asked.
- Stage and commit only your own changed paths. Do not use `git add -A` or `git add .` in a shared worktree.
- If another agent touches the same file, inspect both diffs and preserve both intents. Prefer worktrees for parallel work.

## Reviewing PRs

Do not move the active worktree to a PR branch unless explicitly asked. Inspect with `gh pr view`, `gh pr diff`, `gh api`, fetched refs, and `git show <ref>:<path>`.

## Issues and comments

- Follow [`CONTRIBUTING.md`](../../CONTRIBUTING.md), including maintainer approval requirements and package-label conventions.
- Use all applicable `pkg:*` labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`.
- Post multiline issue/PR comments from a temporary file via `--body-file`.
- Keep AI-posted comments concise and technical, and include the disclaimer required by the originating workflow.
- To auto-close issues, repeat the keyword for each issue: `closes #1, closes #2`.

## GitHub Actions governance

- Treat recurring workflow failures, skipped required jobs, permission failures, and noisy notifications as product defects.
- Prefer checks that enforce real contracts over advisory checks with no owner.
- Disable inherited workflows that do not serve `valkyriweb/pi-mono`; verify branch-protection requirements first.
- Scheduled workflows must short-circuit before expensive or write operations when there is no work.
- Review workflow health from outside the workflow under review.
