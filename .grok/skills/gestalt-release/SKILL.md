---
name: gestalt-release
description: "Gestalt @tienne/gestalt 패키지를 npm에 배포한다. '릴리즈', 'npm 배포', 'version bump', '버전 올려줘', 'publish', '배포해줘' 요청 시 반드시 이 스킬을 사용할 것. 테스트 통과 및 빌드 성공을 보장한 뒤 배포한다."
---

# Gestalt Release

This is a Grok shim. Do not duplicate the release procedure here.

The canonical procedure lives at:

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
6. After a plugin-skill change, tell Grok users to run
   `grok plugin update gestalt` — not Claude's `/plugin install gestalt@gestalt`.

If the repository state already has a manually edited version, do not run
`npm version` again. Reconcile the version files against the canonical workflow,
then release the exact version already present after user confirmation.
