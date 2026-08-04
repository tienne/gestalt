# /gestalt-review

Review a PR, branch, or commit range with the Gestalt review pipeline.

## Arguments

- `target`: PR number or URL, branch name, or commit range (optional — defaults to the current branch against its base)
- `scope`: `security`, `performance`, `quality`, or `all` (optional; defaults to all three)

## Workflow

Read `skills/review/SKILL.md` in this plugin and follow it. It is the source of
truth for the pipeline; this file only routes you there.

The short version:

1. Collect the diff and blast radius for the target.
2. Run the security, performance, and quality review agents over it.
3. Reconcile their findings into one report, dropping duplicates and anything the diff does not support.
4. Rewrite the report in the author's voice using `role-agents/technical-writer/references/author-voice.md` and `ai-tell-quick-rules.md`.
5. If the target is a PR, post inline comments with `r:` / `c:` / `a:` prefixes. Otherwise print the report.

## Notes

- Verify every finding against the diff before reporting it. A plausible-but-wrong finding costs more than a missed one.
- Do not post to a PR without confirming the target with the user first.
