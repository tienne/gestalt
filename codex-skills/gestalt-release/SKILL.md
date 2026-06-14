---
name: gestalt-release
description: Use this skill for Gestalt release, deploy, publish, npm 배포, version bump, or tag-based release requests. It delegates to the repository's canonical Claude release workflow and forbids direct local npm publishing.
---

# Gestalt Release

This is a Codex shim skill. Do not duplicate the release procedure here.

The canonical release workflow lives at:

```text
.claude/skills/gestalt-release/skill.md
```

When this skill is triggered:

1. Read `.claude/skills/gestalt-release/skill.md` before taking action.
2. Follow that workflow exactly unless the user explicitly overrides it.
3. Inspect `.github/workflows/release.yml` to confirm the active CI/CD path.
4. Never run `npm publish`, `pnpm publish`, or any direct local publish command.
5. Release by committing the prepared version changes, pushing the branch, then
   pushing the `vX.Y.Z` tag so GitHub Actions publishes to npm.

If the repository state already has a manually edited version, do not run
`npm version` again. Reconcile the version files against the canonical workflow,
then release the exact version already present after user confirmation.
