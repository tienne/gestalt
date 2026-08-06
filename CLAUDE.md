# Gestalt — AI Development Harness

## Overview
게슈탈트 지각이론을 요구사항 명확화 프로세스에 매핑한 TypeScript 기반 AI 개발 하네스.
"전체는 부분의 합보다 크다" — 흩어진 요구사항 조각들을 모아 완전한 스펙(Spec)으로 결정화.

## Architecture
- **Interview Engine**: 게슈탈트 원리 기반 Q&A로 해상도 점수를 0.8 이상으로 높임
- **Spec Generator**: 완료된 인터뷰에서 구조화된 프로젝트 스펙(Spec) 생성
- **Execute Engine**: Spec→ExecutionPlan 변환 (Figure-Ground→Closure→Proximity→Continuity). 설계상 **항상 Passthrough 모드** — Claude Code가 도구(Bash/Edit 등)로 실제 파일 수정·코드 실행을 수행하므로 LLM 주체가 됨 (API 키 유무 무관)
- **Resilience Engine**: Stagnation 감지 → Lateral Thinking Personas → Human Escalation
- **Review Pipeline**: Code Review 4종 에이전트(보안/성능/품질/프론트엔드) + consensus → 자동 수정 루프
- **MCP Server**: stdio transport, API 키 없으면 Passthrough 모드 자동 활성화 (Execute는 항상 Passthrough)
- **Skill System**: SKILL.md 기반 확장, chokidar hot-reload
- **Code Knowledge Graph**: 정적 분석 → 의존성 그래프 → Blast-Radius 영향 파일 추출, D3 시각화(`ges_graph_visualize`) 지원
- **Knowledge Base**: 코드 그래프·도메인 지식을 MD로 내보내고 로컬 임베딩으로 시맨틱 검색
- **Memory**: 이전 스펙·실행 이력을 `.gestalt/memory.json`에 축적, 신규 인터뷰에 자동 주입
- **Multi-Provider LLM**: frugal/standard/frontier 티어별로 Anthropic/OpenAI 호환 프로바이더 자유 조합
- **Event Store**: better-sqlite3 WAL 모드 이벤트 소싱

## Tech Stack
TypeScript 5.x / ESM / pnpm / vitest
Dependencies: @anthropic-ai/sdk, @modelcontextprotocol/sdk, better-sqlite3, zod, chokidar, commander, gray-matter, dotenv

## Key Commands
```bash
pnpm test          # 전체 테스트
pnpm run serve     # MCP 서버 시작
pnpm tsx bin/gestalt.ts interview "topic"
pnpm tsx bin/gestalt.ts spec <session-id>
pnpm tsx bin/gestalt.ts status
pnpm tsx bin/gestalt.ts init   # gestalt.json + code graph + post-commit hook
```

## MCP Tools
- `ges_interview`: action=[start|respond|score|complete]
- `ges_generate_spec`: sessionId?, text?, force?, spec?
- `ges_execute`: action=[start|plan_step|plan_complete|execute_start|execute_task|status|resume|audit|spawn|evaluate|evolve_fix|evolve|evolve_patch|evolve_re_execute|evolve_lateral|evolve_lateral_result|role_match|role_consensus|review_start|review_submit|review_consensus|review_fix]
- `ges_create_agent`: action=[start|submit]
- `ges_agent`: action=[list|get], name?
- `ges_status`: sessionId?, sessionType?, cwd?
- `ges_benchmark`: action=[start|respond|status], scenario?, benchmarkSessionId?, response?
- `ges_code_graph`: action=[build|blast_radius|diff_radius|query|stats|db_exists]
- `ges_graph_visualize`: repoRoot, port?
- `ges_generate_kb`: repoRoot?, outputPath?, types?
- `ges_search`: query, k?, kbPath?, types?
- `ges_sync`: sourcePath?, targetPath

상세 플로우 → [`docs/mcp-reference.md`](./docs/mcp-reference.md)
설정 레퍼런스 → [`docs/configuration.md`](./docs/configuration.md)
코드 그래프 → [`docs/code-graph.md`](./docs/code-graph.md)

## Role Agent 자동 라우팅

아래 상황에서는 사용자가 명시적으로 에이전트를 지정하지 않아도 해당 에이전트를 proactively 사용한다. `/agent [이름] "태스크"` 또는 `ges_agent` MCP 도구로 호출한다.

| 상황 | 에이전트 |
|------|---------|
| 영상/비디오 URL이 포함되거나 "요약해줘" 요청 | `video-summarizer` |
| 번역투·AI 말투·어색한 한국어 교정 요청 | `humanize-monolith` (윤문 모드) |
| 고치지 말고 AI 티만 짚어달라는 요청 ("이거 AI 같아?", "슬롭인지 봐줘", "패턴만 짚어줘") | `humanize-monolith` (탐지 모드 — 원문 무수정, 패턴 인용만, 저자 판정·등급 금지) |
| README, API 문서, 가이드, 개발자 문서 작성 | `technical-writer` |
| 발표 슬라이드 콘텐츠·문구·데이터 요약·발표 노트 작성 | `presentation-writer` |
| 슬라이드 Reveal.js 구조·템플릿·비주얼 디자인 자문 | `presentation-designer` |
| 발표자료·슬라이드·프레젠테이션 제작 요청 ("발표자료 만들어줘", "슬라이드 만들어줘", "피치덱") | `presentation` 스킬 사용 (presentation-writer 콘텐츠 → 승인 게이트 → presentation-designer 디자인 → Reveal.js HTML) |
| 시스템 설계, 아키텍처 리뷰, 설계 패턴 | `architect` |
| 보안 취약점, 인증/인가, 시크릿 노출 검토 | `security-reviewer` |
| 성능 병목, N+1, 메모리 누수 분석 | `performance-reviewer` |
| 코드 가독성, SOLID, 에러 처리 리뷰 | `quality-reviewer` |
| 테스트 케이스, 엣지 케이스, QA | `qa-engineer` |
| UX 문구 작성·교정, 버튼 텍스트, 에러 메시지, 토스트, 온보딩 카피 | `ux-writer` |
| 슬랙·메신저 메시지 작성 또는 딱딱한/AI스러운 초안을 본인 말투로 다듬기 | `slack-messenger` |
| 슬랙 메시지 전송·예약 발송 요청 ("~라고 보내줘", "공지해줘", "예약 발송해줘") | `slack-send` 스킬 사용 (내부적으로 slack-messenger 다듬기 → 승인 게이트 → 전송) |
| 지라 티켓 본문 작성·구조화 (제목, 설명, 인수조건, 이슈타입 추천) | `jira-writer` |
| 지라 티켓 생성 요청 ("티켓 만들어줘", "이슈 생성해줘", "지라에 올려줘") | `jira-create` 스킬 사용 (내부적으로 jira-writer 구조화 → 프로젝트·필드 확정 → 승인 게이트 → createJiraIssue) |
| UI, React, 접근성, 컴포넌트 설계 | `frontend-developer` |
| UI·React 코드 리뷰, 접근성·번들 최적화 검토 | `frontend-reviewer` |
| API, DB, 인증, 서버 로직 | `backend-developer` |
| CI/CD, 인프라, 모니터링 | `devops-engineer` |
| 요구사항 정리, 로드맵, 유저 스토리 | `product-planner` |
| 성과 분석·KPI 해석·분기 성과 보고·회고 리포트 | `impact-writer` |
| 제안서, RFC, 의사결정 메모 등 설득·합의용 기획 산문 | `impact-writer` |
| 성과 보고서·제안서·RFC·회고 작성 요청 ("성과 보고서 써줘", "제안서 작성", "RFC 써줘") | `brief` 스킬 사용 |
| 기술 분석, 벤치마크, 사례 조사 | `researcher` |
| 내 PR에 달린 리뷰 코멘트 답변 본문 작성 (반영·대안·보류·질문) | `code-review-responder` |
| PR·브랜치·커밋 코드 리뷰 요청 | `/review` 스킬 사용 |
| 받은 리뷰 반영·답글 게시 요청 ("리뷰 반영해줘", "리뷰 코멘트에 답해줘", "받은 리뷰 처리해줘") | `review-reply` 스킬 사용 (스레드 수집 → 유형 분류 승인 → 수정·커밋 → 답글 승인 → 게시) |
| PR 작성·생성 요청 ("PR 만들어줘", "PR 작성해줘", "PR 올려줘") | `gestalt:pr` 스킬 사용 |
| 실행 태스크를 외부 런타임 워커로 뿌리는 요청 ("orca로 실행", "codex로 실행", "워커 띄워서 실행") | `dispatch` 스킬 사용 (런타임 감지 → 같은 워크트리에 터미널 → worker_done 대기 → ready 재계산). 런타임 없으면 execute의 기본 병렬 경로 |

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
src/knowledge-base/— KB 생성·시맨틱 검색·동기화 (ges_generate_kb/ges_search/ges_sync 백엔드)
src/memory/        — Memory 피드백 루프 (ProjectMemoryStore, UserProfileStore)
src/llm/           — 멀티 프로바이더 LLM 어댑터 (frugal/standard/frontier 티어 라우팅)
src/review/        — Code Review 파이프라인 (agent-matcher, context-collector, report-generator)
src/agent/         — AgentRegistry, FiguralRouter, RoleAgentRegistry
src/mcp/           — MCP 서버 + 툴 핸들러
src/events/        — EventStore (SQLite)
src/skills/        — Skill System 엔진 (SKILL.md 파서·실행기, 최상위 skills/와는 별개)
src/registry/      — 레지스트리 공통 베이스 클래스
src/utils/         — 알림 등 공용 유틸
src/cli/           — commander 기반 CLI
plugin/            — 배포 자산 전부. Claude Code와 Codex 플러그인이 이 디렉토리 하나를 공유한다
plugin/role-agents/    — 내장 Role Agent 9개 (architect, frontend-developer, backend-developer, devops-engineer, qa-engineer, designer, product-planner, researcher, technical-writer) + 스킬 지원용 에이전트(jira-writer, slack-messenger, presentation-writer, code-review-writer, code-review-responder 등) 총 21개 + `_shared/references/` 공유 룰북(author-voice, ai-tell-quick-rules, style-guide — 에이전트 아님, 레지스트리가 건너뜀)
plugin/review-agents/  — 내장 Review Agent 4개 (security-reviewer, performance-reviewer, quality-reviewer, frontend-reviewer)
plugin/skills/         — SKILL.md 17개 (interview, spec, execute, dispatch, agent, review, review-reply, pr, build-graph, blast-radius, diff-radius, jira-create, slack-send, brief, presentation, solve, setup) + `_shared/` 공유 규칙(스킬 아님, 레지스트리가 건너뜀)
plugin/agents/         — 파이프라인 에이전트 5개
plugin/personas/       — Lateral Thinking 페르소나
```

## 플러그인 배포 구조

두 클라이언트가 같은 `plugin/`을 각자 매니페스트로 가리킨다. 복사도 심링크도 없다.

```
.claude-plugin/plugin.json        "skills": "./plugin/skills/"
.agents/plugins/marketplace.json  path: "./plugin"        ← Codex
plugin/.codex-plugin/plugin.json  "skills": "./skills/"
```

- Codex는 마켓플레이스 매니페스트를 `.agents/plugins/marketplace.json`에서만 찾는다. `.codex-plugin/marketplace.json`은 인식하지 않는다.
- Codex는 `path`가 가리킨 디렉토리를 통째로 복사한다. 레포 루트를 가리키면 `.git`과 `node_modules`까지 딸려가 1.6GB가 되므로 반드시 `plugin/`으로 좁힌다.
- Codex는 심링크를 따라가지 않는다. 자산은 실물 파일로 `plugin/` 안에 있어야 한다.
- `plugin/skills/review/SKILL.md`가 `../../role-agents/`를 참조한다. 스킬과 에이전트를 함께 옮겨야 이 상대 깊이가 유지된다.
- 자산 디렉토리 기본값은 `src/core/config.ts`에 `skillsDir`, `agentsDir`, `roleAgentsDir`, `reviewAgentsDir`, `personasDir` 다섯 개로 있다. 경로를 바꾸면 전부 함께 고친다.

## Conventions
- MCP 서버에서 `console.log` 금지 → `log()` stderr 유틸 사용
- `noUncheckedIndexedAccess` 환경 → 배열 인덱스·regex 캡처그룹에 `!` 단언 필수
- `glob` 패키지 미사용 → `readdirSync({ recursive: true })` + `Dirent.parentPath`
- LLM 호출: temperature 0.3, JSON 응답 파싱 + fallback
- 해상도 점수 ≥ 0.8 = 요구사항 충분히 명확
- 테스트 DB: `.gestalt-test/xxx-${randomUUID()}.db` 고유 경로 (병렬 안전)
- 한글 산문에서 가운뎃점(·) 나열 절제 → 쉼표나 "A랑 B하고 C"로 (표·용어 목록은 예외). 룰은 `ai-tell-quick-rules.md` C-12, `style-guide.md`에 정의
