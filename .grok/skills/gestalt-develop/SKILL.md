---
name: gestalt-develop
description: "Gestalt TypeScript 프로젝트에서 기능 개발, 버그 수정, MCP Action 추가 등 모든 개발 작업을 분석→구현→테스트 파이프라인으로 자동화한다. '새 MCP 액션 추가', '버그 수정', '기능 구현', '이거 만들어줘' 등 Gestalt 프로젝트 개발 작업 요청이 오면 반드시 이 스킬을 사용할 것."
---

# Gestalt Develop

This is a Grok shim. Do not duplicate the development workflow here.

The canonical procedure lives at:

```text
.claude/skills/gestalt-develop/SKILL.md
```

When this skill is triggered:

1. Read `.claude/skills/gestalt-develop/SKILL.md` before taking action.
2. Follow the workflow intent: analyze first, implement narrowly, verify with
   relevant tests, and write `_workspace/` artifacts.
3. Adapt Claude-only mechanics to Grok:
   - `Agent(...)` → `spawn_subagent` with the same `subagent_type`
     (`gestalt-analyst`, `gestalt-developer`, `gestalt-qa`).
   - Do not pass `model`. Do not send `opus`, `sonnet`, `haiku`, or `fable`.
     Inherit the session model.
   - Project root is the current git root. Never paste a hardcoded home path
     into a subagent prompt.
   - Call Gestalt MCP through `search_tool` then `use_tool`. If the server is
     down, say so. For continuity-judge, read
     `plugin/agents/continuity-judge/AGENT.md` instead of inventing a `ges_*`
     call.
   - Do not commit unless the user asked to commit.
4. Respect `AGENTS.md`, `CLAUDE.md`, and `.grok/rules/`.

The Claude workflow is the source of truth for project-specific development
expectations. This file only makes that workflow runnable from Grok.
