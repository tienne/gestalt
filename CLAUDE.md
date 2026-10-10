# Gestalt — AI Development Harness

## Overview
게슈탈트 지각이론을 요구사항 명확화 프로세스에 매핑한 TypeScript 기반 AI 개발 하네스.
"전체는 부분의 합보다 크다" — 흩어진 요구사항 조각들을 모아 완전한 스펙(Spec)으로 결정화.

## 설계 전제
- Execute Engine은 설계상 **항상 Passthrough 모드**다. Claude Code가 도구(Bash/Edit 등)로 실제 파일 수정과 코드 실행을 하므로 LLM 주체가 되고, API 키 유무와 무관하다. MCP 서버도 API 키가 없으면 Passthrough가 자동으로 켜진다.
- Local PR은 에이전트끼리 레포 안에서 PR을 만들고 리뷰하고 머지하는 자리라 원격에 안 나간다. 워크트리 여럿이 `.gestalt/reviews.db` 하나를 공유한다.
- 코드 그래프 훅 자동 주입은 기본 꺼짐이다.

## Key Commands
```bash
pnpm gate          # 커밋 전 게이트 — CI가 도는 것과 같다 (typecheck, verify:rules, lint, format:check, build, test)
                   # 강제하는 훅은 없다. 커밋 전에 사람이 부른다
pnpm build:output-style  # 룰북 → ~/.claude/output-styles/tienne-voice.md 생성
pnpm build:routing # SKILL.md triggers → proactive-routing.md 스킬 표 생성 (verify:routing이 gate에서 검사)
```
나머지 스크립트는 `package.json`에, CLI 서브커맨드는 `pnpm tsx bin/gestalt.ts --help`에 있다.

## 상세 문서
MCP 도구 목록과 액션 스키마는 `src/mcp/`의 툴 정의가 기준이다.

상세 플로우 → [`docs/mcp-reference.md`](./docs/mcp-reference.md)
설정 레퍼런스 → [`docs/configuration.md`](./docs/configuration.md)
코드 그래프 → [`docs/code-graph.md`](./docs/code-graph.md)
로컬 PR → [`docs/local-pr.md`](./docs/local-pr.md)
아키텍처 그림 → [`docs/architecture-view.md`](./docs/architecture-view.md)

## Role Agent 자동 라우팅

아래 상황에서는 사용자가 명시적으로 에이전트를 지정하지 않아도 해당 에이전트를 proactively 사용한다. 기준 표는 [`plugin/skills/_shared/proactive-routing.md`](./plugin/skills/_shared/proactive-routing.md)에 있다 — 이 파일은 플러그인과 함께 배포되므로 다른 레포에 설치된 세션도 같은 표를 본다. `/agent [이름] "태스크"` 또는 `ges_agent` MCP 도구로 호출한다.

## Project Structure
디렉토리 구성은 `ls src plugin`으로 본다. 코드만 봐선 헷갈리는 자리만 적는다.
- `src/skills/`는 Skill System 엔진(SKILL.md 파서와 실행기)이고 최상위 `skills/`와는 별개다.
- `src/agent/`의 레지스트리는 tier→모델 해석을 하지 않는다. 그건 MCP 핸들러가 담당한다.
- `src/explain/`은 판정 구조만 humanize에서 빌려 쓴다.
- `plugin/`은 배포 자산 전부다. Claude Code와 Codex 플러그인이 이 디렉토리 하나를 공유한다.
- `plugin/role-agents/_shared/references/`(룰북과 리뷰 절차 문서)와 `plugin/skills/_shared/`는 에이전트나 스킬이 아니다. 레지스트리가 건너뛴다.

## 플러그인 배포 구조

네 클라이언트가 같은 스킬을 본다. 실물은 `plugin/skills/` 한 곳에 있고 복사본은 없다. 루트 `skills`만 심링크다.

```
skills → plugin/skills            루트 심링크 — Claude와 Orca가 읽는다
.claude-plugin/plugin.json        skills 필드 없음 (다시 넣으면 스킬이 두 번 로드된다)
.agents/plugins/marketplace.json  path: "./plugin"        ← Codex
.grok-plugin/marketplace.json     source: "./plugin"      ← Grok
plugin/.codex-plugin/plugin.json  "skills": "./skills/"
plugin/.mcp.json                  Grok MCP (plugin/mcp.json과 동일)
hooks/hooks.json                  Claude 플러그인 훅 (코드 그래프 자동 주입). Claude만 읽는다
```

- Orca는 `plugin.json`을 안 읽는다. 설치 경로 뒤에 `skills`를 하드코딩해 붙이고 그 아래만 훑는다. 루트 `skills` 심링크를 지우면 Orca 채팅의 스킬 피커에서 gestalt 스킬이 하나도 안 뜬다.
- Claude는 `.claude-plugin/plugin.json`의 `skills` 필드와 루트 `skills/`를 둘 다 훑는다. 둘 다 있으면 같은 스킬을 두 번 로드한다 (스킬 목록에 같은 이름이 두 번씩 뜨고 상시 토큰이 3k 늘어난다). 그래서 필드는 비워두고 심링크 한 곳만 남긴다.
- 그 심링크는 `plugin/` 밖이라 Codex와 Grok이 복사하는 범위에 안 들어간다. 둘은 `plugin/skills/` 실물을 그대로 읽으므로 심링크와 무관하다.
- Codex는 마켓플레이스 매니페스트를 `.agents/plugins/marketplace.json`에서만 찾는다. `.codex-plugin/marketplace.json`은 인식하지 않는다.
- Grok은 `.grok-plugin/marketplace.json`만 읽는다. 마켓플레이스를 고칠 일이 있으면 여기를 고친다. source는 반드시 `./plugin`이다. Claude 매니페스트(`source: "./"`)를 바꾸지 말 것.
- Grok은 `plugin/.mcp.json`(점 파일)을 읽는다. `plugin/mcp.json`과 내용을 같게 유지한다.
- Codex는 `path`가 가리킨 디렉토리를 통째로 복사한다. 레포 루트를 가리키면 `.git`과 `node_modules`까지 딸려가 1.6GB가 되므로 반드시 `plugin/`으로 좁힌다.
- Codex는 심링크를 따라가지 않는다. 자산은 실물 파일로 `plugin/` 안에 있어야 한다.
- `plugin/skills/review/SKILL.md`가 `../../role-agents/`를 참조한다. 스킬과 에이전트를 함께 옮겨야 이 상대 깊이가 유지된다.
- 훅은 루트 `hooks/hooks.json` 하나만 두고 `plugin.json`에 `hooks` 필드를 넣지 않는다. 문서상 필드와 기본 파일은 merge된다. 같은 파일을 가리키면 실제로는 한 번만 걸리는 걸 확인했지만 그래도 한 곳만 둔다.
- Codex와 Grok 훅은 지원하지 않는다. 훅 자동 주입은 Claude 전용이다.
- 훅 런처는 `scripts/code-graph-hook.sh`다. Node 탐색은 `scripts/lib/pick-node.sh`를 `mcp-serve.sh`와 함께 쓴다. 자세한 동작은 [`docs/code-graph.md`](./docs/code-graph.md#claude-code-훅-자동-주입)에 있다.
- 자산 디렉토리 기본값은 `src/core/config.ts`에 `skillsDir`, `agentsDir`, `roleAgentsDir`, `reviewAgentsDir`, `personasDir` 다섯 개로 있다. 경로를 바꾸면 전부 함께 고친다.

### MCP 기동 경로

클라이언트별 서버 기동 방식과 매니페스트 버전 핀 규칙은 [`scripts/CLAUDE.md`](./scripts/CLAUDE.md)에 있다. `.mcp.json`, `.claude-plugin/.mcp.json`, `plugin/mcp.json`, `plugin/.mcp.json`, `.grok/config.toml`을 고치기 전에 먼저 읽는다. 매니페스트의 `GESTALT_LAUNCHER`는 **절대 경로만** 받는다. 상대 경로를 허용하면 남의 레포의 동명 실행 파일이 서버 대신 돈다.

### 버전이 뒤처졌을 때 알리는 자리

`ges_*` 도구를 처음 부를 때 붙는 버전 알림은 `src/mcp/server.ts`의 `toolReply()`가 만든다. 상세 규칙은 [`src/mcp/CLAUDE.md`](./src/mcp/CLAUDE.md)에 있고 `src/mcp/` 아래를 고칠 때 자동으로 로드된다.

## Conventions
- MCP 서버에서 `console.log` 금지 → `log()` stderr 유틸 사용
- `noUncheckedIndexedAccess` 환경 → 배열 인덱스·regex 캡처그룹에 `!` 단언 필수
- `glob` 패키지 미사용 → `readdirSync({ recursive: true })` + `Dirent.parentPath`
- LLM 호출: temperature 0.3, JSON 응답 파싱 + fallback
- 해상도 점수 ≥ 0.8 = 요구사항 충분히 명확
- 테스트 DB: `.gestalt-test/xxx-${randomUUID()}.db` 고유 경로 (병렬 안전)
- blast-radius 결과에서 테스트 러너 인자로 넘기는 건 `impactedFiles`다. `rankedFiles`에는 git 이력으로만 걸린 md나 json이 섞여 있어 그대로 넘기면 vitest 인자가 오염된다
- 한글 산문에서 가운뎃점(·) 나열 절제 → 쉼표나 "A랑 B하고 C"로 (표·용어 목록은 예외). 룰은 `ai-tell-quick-rules.md` C-12, `style-guide.md`에 정의

## 커밋 메시지, PR 제목

제목은 명사로 끝낸다. 목록에서 한 줄씩 훑는 자리라 서술형으로 끝내면 길어지고 덜 읽힌다. 본문은 반대로 서술체다.

| 자리 | 꼴 | 예 |
|---|---|---|
| 커밋 제목 | `type(scope): 명사구` | `refactor(chat): 이전 대화 목록의 세션 스토리지 이전` |
| PR 제목 (티켓 있음) | `[티켓ID] 명사구` | `[PROJ-123] 이전 대화 목록의 세션 스토리지 이전` |
| PR 제목 (티켓 없음) | `type(scope): 명사구` | `refactor(chat): 이전 대화 목록의 세션 스토리지 이전` |
| 본문 | 서술체 | 이전 대화 목록을 메모리 캐싱에서 세션 스토리지로 옮겼다. |

- 명사로 끝낸다고 조사까지 걷지는 않는다. "대화 목록 세션 스토리지 이전"처럼 조사를 다 빼면 무엇을 무엇으로 바꿨는지가 안 읽힌다 (ai-tell F-6).
- 명사구 종결을 막는 E-8은 본문에만 적용한다. 제목은 예외이고 근거는 `author-voice.md`의 "제목은 개조식, 본문은 서술체" 절에 있다.
- 기존 커밋과 PR 제목은 서술형이 섞여 있다. 소급해 안 고친다.
