# Grok — 이 레포 개발

## MCP

- Gestalt 도구는 `search_tool`로 스키마를 확인한 뒤 `use_tool`로 호출한다. `ges_*`를 호스트 도구처럼 직접 부르지 않는다.
- 이 체크아웃을 검증할 때는 `.grok/config.toml`이 띄운 로컬 서버만 쓴다. `npx @tienne/gestalt`와 `npx -y @tienne/gestalt serve`는 배포본이다.
- handshake가 실패하면 부모 PATH의 Node가 20 미만인지 본다. 래퍼는 `scripts/grok-mcp-serve.sh`다. 강제하려면 `GESTALT_NODE`에 Node 20+ 경로를 넣는다.

## 서브에이전트

- `Agent(...)`는 클로드 API다. `spawn_subagent`를 쓰고 `subagent_type`은 `gestalt-analyst`, `gestalt-developer`, `gestalt-qa`다.
- `model`에 `opus`, `sonnet`, `haiku`, `fable`을 넣지 않는다. 세션 모델을 상속한다.
- 서브에이전트는 1단만 가능하다. 오케스트레이션은 부모 세션이 한다.

## 스킬

- 개발 요청은 `.grok/skills/gestalt-develop/SKILL.md`를 먼저 읽는다.
- 릴리즈 요청은 `.grok/skills/gestalt-release/SKILL.md`를 먼저 읽는다.

## 플러그인

- 이 레포를 고칠 때 Gestalt 플러그인 MCP를 켜지 않는다. `plugin/.mcp.json`도 `npx @tienne/gestalt`다.
- `plugin/` 자산 규칙은 `AGENTS.md`를 따른다.
