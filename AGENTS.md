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

## Shipped skills live in `plugin/`

The skills this package distributes are separate from the two repo-local ones
above. They live in `plugin/skills/` and are shared by the Claude Code, Codex,
and Grok plugin manifests — no copies, no symlinks.

```
.claude-plugin/plugin.json        "skills": "./plugin/skills/"
.agents/plugins/marketplace.json  path: "./plugin"        ← Codex reads this
.grok-plugin/marketplace.json     source: "./plugin"      ← Grok reads this
plugin/.codex-plugin/plugin.json  "skills": "./skills/"
plugin/.mcp.json                  Grok MCP (same as plugin/mcp.json)
```

When changing anything under `plugin/`, keep these in mind.

- Codex only finds a marketplace manifest at `.agents/plugins/marketplace.json`.
- Grok marketplace is `.grok-plugin/marketplace.json`. Source must stay
  `./plugin`. Do not retarget `.claude-plugin/marketplace.json` (`source: "./"`).
- Grok reads `plugin/.mcp.json` (dotfile). Keep it identical to `plugin/mcp.json`.
- Codex copies the whole directory that `path` points at, so it must stay
  `./plugin` — pointing at the repo root drags in `.git` and `node_modules`.
- Codex does not follow symlinks. Assets have to be real files under `plugin/`.
- `plugin/skills/review/SKILL.md` reads `../../role-agents/`. Skills and agents
  must move together or that relative depth breaks.
- Asset directory defaults live in `src/core/config.ts` as `skillsDir`,
  `agentsDir`, `roleAgentsDir`, `reviewAgentsDir`, and `personasDir`. Changing a
  path means changing all five.

Never run `npm publish`, `pnpm publish`, or any direct local publish command for
this repository. Releases happen through `.github/workflows/release.yml` by
pushing a `v*` tag, which lets GitHub Actions publish to npm with `NPM_TOKEN`.

Do not edit generated `dist/` directly. Build scripts regenerate it.

Ignore `.claude/worktrees/` unless the user specifically asks about it.
