# Codex Entry Point

Read `CLAUDE.md` first for project architecture, commands, conventions, and
agent routing notes.

Claude-specific workflow docs live under `.claude/skills/`. When a user request
matches one of those workflows, read the relevant skill file before taking
action.

- For feature development, bug fixes, MCP action changes, implementation work,
  tests, or code modifications, use `codex-skills/gestalt-develop/SKILL.md`.
- For release, deploy, publish, version bump, or npm 배포 requests, use
  `codex-skills/gestalt-release/SKILL.md`.

Those Codex skills delegate to `.claude/skills/**/skill.md` as the canonical
source of truth.

Never run `npm publish`, `pnpm publish`, or any direct local publish command for
this repository. Releases happen through `.github/workflows/release.yml` by
pushing a `v*` tag, which lets GitHub Actions publish to npm with `NPM_TOKEN`.

Do not edit generated `dist/` directly. Build scripts regenerate it.

Ignore `.claude/worktrees/` unless the user specifically asks about it.
