# Project Entry Point

Architecture, commands, conventions, and agent routing live in `CLAUDE.md`.
Grok and Claude load that file automatically. Other hosts should read it first.

## Repo-local development workflows

Canonical procedures live under `.claude/skills/`. Host shims only adapt tool
mechanics; they do not duplicate the procedure.

- Feature development, bug fixes, MCP action changes, tests, or code
  modifications:
  - Grok: `.grok/skills/gestalt-develop/SKILL.md`
  - Codex: `codex-skills/gestalt-develop/SKILL.md`
  - Claude Code: `.claude/skills/gestalt-develop/skill.md`
- Release, deploy, publish, version bump, or npm 배포:
  - Grok: `.grok/skills/gestalt-release/SKILL.md`
  - Codex: `codex-skills/gestalt-release/SKILL.md`
  - Claude Code: `.claude/skills/gestalt-release/skill.md`

Grok-specific execution constraints live in `.grok/rules/` and load
automatically in Grok.

## This repo's MCP

When developing this repository, do not start Gestalt via `npx @tienne/gestalt`
or `npx -y @tienne/gestalt serve`. That runs the published package, not this
checkout.

- Grok: `.grok/config.toml` starts `scripts/grok-mcp-serve.sh` (local `tsx`,
  Node >= 20).
- Other hosts: `pnpm run serve` or `pnpm exec tsx bin/gestalt.ts serve`.

Root `.mcp.json` goes through `scripts/mcp-serve.sh`, which resolves the
published package — it is not a pointer at this checkout. `plugin/.mcp.json`
stays on `npx @tienne/gestalt@<version>` for Codex and Grok. Do not retarget
either at this checkout; set `GESTALT_LAUNCHER` if you need a local launcher.

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
