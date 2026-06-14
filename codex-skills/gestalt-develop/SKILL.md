---
name: gestalt-develop
description: Use this skill for Gestalt feature development, bug fixes, MCP action changes, implementation work, tests, or code modifications. It delegates to the repository's canonical Claude development workflow.
---

# Gestalt Develop

This is a Codex shim skill. Do not duplicate the development workflow here.

The canonical development workflow lives at:

```text
.claude/skills/gestalt-develop/skill.md
```

When this skill is triggered:

1. Read `.claude/skills/gestalt-develop/skill.md` before taking action.
2. Follow the workflow intent: analyze first, implement narrowly, verify with
   relevant tests, and report changed files plus remaining risks.
3. Adapt Claude-only mechanics such as `Agent(...)` calls to Codex-native work:
   inspect files directly, use available tools, and keep `_workspace/` artifacts
   only when they help the task.
4. Respect `AGENTS.md`, `CLAUDE.md`, and repository conventions.

The Claude workflow is the source of truth for project-specific development
expectations. This file only makes that workflow discoverable from Codex.
