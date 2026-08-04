# /gestalt-pr

Write and open a pull request for the current branch.

## Arguments

- `base`: base branch (optional — inferred from the repo default)
- `draft`: open as draft (optional)

## Workflow

Read `skills/pr/SKILL.md` in this plugin and follow it.

The short version:

1. Find the repo's PR rules — template, CONTRIBUTING, CODEOWNERS, recent merged PRs.
2. Ask a short set of questions to fill context the diff cannot supply (why now, ticket, risk).
3. Draft the description from the actual diff, not from the branch name.
4. Show it for approval, then submit through the GitHub CLI.

## Notes

- Never open a PR before the user approves the description.
- Follow the repo's own template over any default layout.
