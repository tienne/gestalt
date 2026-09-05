# Gestalt — AI Development Harness

## Overview
게슈탈트 지각이론을 요구사항 명확화 프로세스에 매핑한 TypeScript 기반 AI 개발 하네스.
"전체는 부분의 합보다 크다" — 흩어진 요구사항 조각들을 모아 완전한 스펙(Spec)으로 결정화.

## Architecture
- **Interview Engine**: 게슈탈트 원리 기반 Q&A로 해상도 점수를 0.8 이상으로 높임
- **Spec Generator**: 완료된 인터뷰에서 구조화된 프로젝트 스펙(Spec) 생성
- **Execute Engine**: Spec→ExecutionPlan 변환 (Figure-Ground→Closure→Proximity→Continuity). 설계상 **항상 Passthrough 모드** — Claude Code가 도구(Bash/Edit 등)로 실제 파일 수정·코드 실행을 수행하므로 LLM 주체가 됨 (API 키 유무 무관)
- **Resilience Engine**: Stagnation 감지 → Lateral Thinking Personas → Human Escalation
- **Review Pipeline**: Code Review 6종 에이전트(보안/성능/품질/프론트엔드/주석/라이팅) + consensus → 자동 수정 루프
- **MCP Server**: stdio transport, API 키 없으면 Passthrough 모드 자동 활성화 (Execute는 항상 Passthrough)
- **Skill System**: SKILL.md 기반 확장, chokidar hot-reload
- **Code Knowledge Graph**: 정적 분석 → 의존성 그래프 → Blast-Radius 영향 파일 추출, D3 시각화(`ges_graph_visualize`) 지원
- **Knowledge Base**: 코드 그래프·도메인 지식을 MD로 내보내고 로컬 임베딩으로 시맨틱 검색
- **Memory**: 이전 스펙·실행 이력을 `.gestalt/memory.json`에 축적, 신규 인터뷰에 자동 주입
- **Multi-Provider LLM**: frugal/standard/frontier 티어별로 Anthropic/OpenAI 호환 프로바이더 자유 조합
- **Local PR**: 에이전트끼리 레포 안에서 PR을 만들고 리뷰하고 머지하는 자리 — 원격에 안 나간다. 워크트리 여럿이 `.gestalt/reviews.db` 하나를 공유한다
- **Event Store**: better-sqlite3 WAL 모드 이벤트 소싱

## Tech Stack
TypeScript 5.x / ESM / pnpm / vitest
Dependencies: @anthropic-ai/sdk, @modelcontextprotocol/sdk, better-sqlite3, zod, chokidar, commander, gray-matter, dotenv

## Key Commands
```bash
pnpm gate          # 커밋 전 게이트 — CI가 도는 것과 같다 (typecheck, verify:rules, lint, format:check, build, test)
                   # 강제하는 훅은 없다. 커밋 전에 사람이 부른다
pnpm test          # 전체 테스트
pnpm run serve     # MCP 서버 시작
pnpm tsx bin/gestalt.ts interview "topic"
pnpm tsx bin/gestalt.ts spec <session-id>
pnpm tsx bin/gestalt.ts status
pnpm tsx bin/gestalt.ts init   # gestalt.json + code graph + post-commit hook
pnpm verify:rules  # 룰북과 에이전트 문서의 룰 ID·심각도 정합 검사
pnpm build:output-style  # 룰북 → ~/.claude/output-styles/tienne-voice.md 생성
pnpm tsx bin/gestalt.ts humanize-scan --file a.md --register chat   # 걸린 룰만 추린다
pnpm tsx bin/gestalt.ts humanize-check --before a.md --after b.md --register report
```

## MCP Tools
- `ges_interview`: action=[start|respond|score|complete]
- `ges_generate_spec`: sessionId?, text?, force?, spec?
- `ges_execute`: action=[start|plan_step|plan_complete|execute_start|execute_task|status|resume|audit|spawn|evaluate|evolve_fix|evolve|evolve_patch|evolve_re_execute|evolve_lateral|evolve_lateral_result|role_match|role_consensus|review_start|review_submit|review_consensus|review_fix|review_publish]
- `ges_create_agent`: action=[start|submit]
- `ges_agent`: action=[list|get], name?
- `ges_status`: sessionId?, sessionType?, cwd?
- `ges_benchmark`: action=[start|respond|status], scenario?, benchmarkSessionId?, response?
- `ges_code_graph`: action=[build|blast_radius|diff_radius|query|stats|db_exists]
- `ges_graph_visualize`: repoRoot, port?
- `ges_generate_kb`: repoRoot?, outputPath?, types?, summarize?
- `ges_search`: query, k?, kbPath?, types?
- `ges_sync`: sourcePath?, targetPath
- `ges_pr`: action=[create|list|get|diff|comment|resolve|review|update|edit|merge|close|checkout|checkout_remove]

상세 플로우 → [`docs/mcp-reference.md`](./docs/mcp-reference.md)
설정 레퍼런스 → [`docs/configuration.md`](./docs/configuration.md)
코드 그래프 → [`docs/code-graph.md`](./docs/code-graph.md)
로컬 PR → [`docs/local-pr.md`](./docs/local-pr.md)

## Role Agent 자동 라우팅

아래 상황에서는 사용자가 명시적으로 에이전트를 지정하지 않아도 해당 에이전트를 proactively 사용한다. 기준 표는 [`plugin/skills/_shared/proactive-routing.md`](./plugin/skills/_shared/proactive-routing.md)에 있다 — 이 파일은 플러그인과 함께 배포되므로 다른 레포에 설치된 세션도 같은 표를 본다. `/agent [이름] "태스크"` 또는 `ges_agent` MCP 도구로 호출한다.

## Project Structure
```
src/core/          — types, errors, Result monad, config, constants
src/gestalt/       — 게슈탈트 원리 엔진
src/interview/     — InterviewEngine, ResolutionScorer
src/spec/          — SpecGenerator, SpecExtractor
src/execute/       — ExecuteEngine, DAG Validator
src/resilience/    — Stagnation Detector, Lateral Thinking Personas
src/code-graph/    — CodeGraphEngine, BlastRadius, 언어 플러그인 8개
src/graph-viz/     — 코드 그래프 D3 시각화 (ges_graph_visualize 백엔드)
src/local-pr/      — 로컬 PR 도메인 (이벤트 소싱, git 연산, gestalt pr·ges_pr 백엔드)
src/local-pr-web/  — 로컬 PR 읽기 전용 웹 UI (gestalt pr serve 백엔드)
src/knowledge-base/— KB 생성·시맨틱 검색·동기화 (ges_generate_kb/ges_search/ges_sync 백엔드)
src/memory/        — Memory 피드백 루프 (ProjectMemoryStore, UserProfileStore)
src/llm/           — 멀티 프로바이더 LLM 어댑터 (frugal/standard/frontier 티어 라우팅)
src/review/        — Code Review 파이프라인 (agent-matcher, context-collector, report-generator)
src/agent/         — AgentRegistry, RoleAgentRegistry (tier→모델 해석은 MCP 핸들러가 담당)
src/mcp/           — MCP 서버 + 툴 핸들러
src/events/        — EventStore (SQLite)
src/skills/        — Skill System 엔진 (SKILL.md 파서·실행기, 최상위 skills/와는 별개)
src/registry/      — 레지스트리 공통 베이스 클래스
src/humanize/      — 룰북 읽기 + AI-tell 탐지기 + 윤문 코드 검사 (`gestalt humanize-check` 백엔드)
src/utils/         — 알림 등 공용 유틸
src/cli/           — commander 기반 CLI
plugin/            — 배포 자산 전부. Claude Code와 Codex 플러그인이 이 디렉토리 하나를 공유한다
plugin/role-agents/    — 내장 Role Agent 9개 (architect, frontend-developer, backend-developer, devops-engineer, qa-engineer, designer, product-planner, researcher, technical-writer) + 스킬 지원용 에이전트(jira-writer, slack-messenger, presentation-writer, code-review-writer, code-review-responder, explainer 등) 총 22개 + `_shared/references/` 공유 룰북(author-voice, ai-tell-quick-rules, style-guide, comment-rules, truncation-rules — 에이전트 아님, 레지스트리가 건너뜀)
plugin/review-agents/  — 내장 Review Agent 6개 (security-reviewer, performance-reviewer, quality-reviewer, frontend-reviewer, comment-reviewer, writing-reviewer)
plugin/skills/         — SKILL.md 19개 (interview, spec, execute, dispatch, agent, review, review-reply, pr, local-pr, ship, build-graph, blast-radius, diff-radius, jira-create, slack-send, brief, presentation, solve, setup) + `_shared/` 공유 규칙(스킬 아님, 레지스트리가 건너뜀)
plugin/agents/         — 파이프라인 에이전트 5개
plugin/personas/       — Lateral Thinking 페르소나
```

## 플러그인 배포 구조

네 클라이언트가 같은 스킬을 본다. 실물은 `plugin/skills/` 한 곳에 있고 복사본은 없다. 루트 `skills`만 심링크다.

```
skills → plugin/skills            루트 심링크 — Claude와 Orca가 읽는다
.claude-plugin/plugin.json        skills 필드 없음 (다시 넣으면 스킬이 두 번 로드된다)
.agents/plugins/marketplace.json  path: "./plugin"        ← Codex
.grok-plugin/marketplace.json     source: "./plugin"      ← Grok
plugin/.codex-plugin/plugin.json  "skills": "./skills/"
plugin/.mcp.json                  Grok MCP (plugin/mcp.json과 동일)
```

- Orca는 `plugin.json`을 안 읽는다. 설치 경로 뒤에 `skills`를 하드코딩해 붙이고 그 아래만 훑는다. 루트 `skills` 심링크를 지우면 Orca 채팅의 스킬 피커에서 gestalt 스킬이 하나도 안 뜬다.
- Claude는 `.claude-plugin/plugin.json`의 `skills` 필드와 루트 `skills/`를 둘 다 훑는다. 둘 다 있으면 같은 스킬을 두 번 로드한다 (19개가 38개가 되고 상시 토큰이 3k 늘어난다). 그래서 필드는 비워두고 심링크 한 곳만 남긴다.
- 그 심링크는 `plugin/` 밖이라 Codex와 Grok이 복사하는 범위에 안 들어간다. 둘은 `plugin/skills/` 실물을 그대로 읽으므로 심링크와 무관하다.
- Codex는 마켓플레이스 매니페스트를 `.agents/plugins/marketplace.json`에서만 찾는다. `.codex-plugin/marketplace.json`은 인식하지 않는다.
- Grok은 `.grok-plugin/marketplace.json`만 읽는다. 마켓플레이스를 고칠 일이 있으면 여기를 고친다. source는 반드시 `./plugin`이다. Claude 매니페스트(`source: "./"`)를 바꾸지 말 것.
- Grok은 `plugin/.mcp.json`(점 파일)을 읽는다. `plugin/mcp.json`과 내용을 같게 유지한다.
- Codex는 `path`가 가리킨 디렉토리를 통째로 복사한다. 레포 루트를 가리키면 `.git`과 `node_modules`까지 딸려가 1.6GB가 되므로 반드시 `plugin/`으로 좁힌다.
- Codex는 심링크를 따라가지 않는다. 자산은 실물 파일로 `plugin/` 안에 있어야 한다.
- `plugin/skills/review/SKILL.md`가 `../../role-agents/`를 참조한다. 스킬과 에이전트를 함께 옮겨야 이 상대 깊이가 유지된다.
- 자산 디렉토리 기본값은 `src/core/config.ts`에 `skillsDir`, `agentsDir`, `roleAgentsDir`, `reviewAgentsDir`, `personasDir` 다섯 개로 있다. 경로를 바꾸면 전부 함께 고친다.

### MCP 기동 경로

클라이언트마다 서버를 띄우는 방식이 다르다.

```
.mcp.json                 Claude — sh로 scripts/mcp-serve.sh를 찾아 실행
.claude-plugin/.mcp.json  .mcp.json과 내용 동일 (해석 기준 디렉토리가 모호해 양쪽에 둔다)
plugin/mcp.json           Codex — npx, 버전 핀
plugin/.mcp.json          Grok(배포) — plugin/mcp.json과 동일
.grok/config.toml         Grok(이 레포 개발용) — scripts/grok-mcp-serve.sh
```

- `npx`는 버전을 박아도 기동할 때마다 레지스트리를 조회한다. 캐시가 비면 20초, 레지스트리에 못 닿으면 70초를 매달린다. Claude Code의 기동 제한은 30초라 둘 다 `Connection closed`로 끊긴다.
- `startup_timeout_sec`와 `tool_timeout_sec`는 Codex 키다. Claude Code는 안 읽고 `MCP_TIMEOUT` 환경변수만 본다. Claude 매니페스트에 넣어봐야 무시된다.
- `scripts/mcp-serve.sh`가 그 셋을 처리한다. nvm, fnm, Volta, Homebrew에서 Node >= 20을 찾는다 (GUI 세션은 PATH에 버전 매니저가 없다). 전역 `gestalt`가 있으면 그걸 쓰고 없으면 `npx --offline`으로 캐시에서 해석한다.
- 그 스크립트는 npx로 서버를 띄우지 않고 bin 경로만 받아와 직접 exec한다. npx가 cwd의 로컬 패키지를 먼저 보기 때문에, node_modules 없는 gestalt 체크아웃 안에서는 `gestalt: command not found`로 죽는다. 그래서 해석은 `cd /`에서 한다.
- 전역 `gestalt`가 깔려 있으면 핀보다 그게 이긴다. 누가 `npm i -g`를 했다는 건 이 체크아웃이 번들한 것보다 구체적인 선택이라서다. 대신 어느 쪽을 썼는지 stderr에 적어 버전이 어긋났을 때 로그에서 보이게 한다.
- 매니페스트의 `sh -c`는 `${CLAUDE_PLUGIN_ROOT}`를 먼저 본다. 거기서 스크립트를 찾으면 `GESTALT_LAUNCHER`는 아예 안 본다. 플러그인으로 설치된 상태에서는 그 변수가 안 걸린다는 뜻이다. 플러그인 없이 이 레포만 연 경우에만 차례가 온다. 그때도 **절대 경로만** 받는다 — 상대 경로를 허용하면 남의 레포를 열었을 때 거기 있는 동명 실행 파일이 서버 대신 도는 자리가 된다.
- 그 `sh -c`의 최후 폴백도 버전이 핀되어 있다. 거기까지 왔으면 스크립트를 못 찾은 것이다. 스크립트가 없으면 `package.json`도 없어 런타임에 버전을 못 읽는다. 그래서 그 자리만은 `sync-version.ts`가 문자열에 직접 박는다.
- 네 매니페스트의 버전 핀을 `scripts/sync-version.ts`가 릴리즈마다 함께 갱신한다. `plugin/*`는 인자 하나가 통째로 스펙이고 Claude 쪽은 `sh` 문자열 안에 박혀 있는데, 같은 정규식으로 둘 다 친다.
- `command: "sh"`라서 Windows 호스트에서는 안 뜬다. 그쪽은 전역 설치 후 `command: "gestalt"`로 안내한다.

## Conventions
- MCP 서버에서 `console.log` 금지 → `log()` stderr 유틸 사용
- `noUncheckedIndexedAccess` 환경 → 배열 인덱스·regex 캡처그룹에 `!` 단언 필수
- `glob` 패키지 미사용 → `readdirSync({ recursive: true })` + `Dirent.parentPath`
- LLM 호출: temperature 0.3, JSON 응답 파싱 + fallback
- 해상도 점수 ≥ 0.8 = 요구사항 충분히 명확
- 테스트 DB: `.gestalt-test/xxx-${randomUUID()}.db` 고유 경로 (병렬 안전)
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
