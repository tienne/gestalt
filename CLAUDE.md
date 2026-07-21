# Gestalt — AI Development Harness

## Overview
게슈탈트 지각이론을 요구사항 명확화 프로세스에 매핑한 TypeScript 기반 AI 개발 하네스.
"전체는 부분의 합보다 크다" — 흩어진 요구사항 조각들을 모아 완전한 스펙(Spec)으로 결정화.

## Architecture
- **Interview Engine**: 게슈탈트 원리 기반 Q&A로 해상도 점수를 0.8 이상으로 높임
- **Spec Generator**: 완료된 인터뷰에서 구조화된 프로젝트 스펙(Spec) 생성
- **Execute Engine**: Spec→ExecutionPlan 변환 (Figure-Ground→Closure→Proximity→Continuity). 설계상 **항상 Passthrough 모드** — Claude Code가 도구(Bash/Edit 등)로 실제 파일 수정·코드 실행을 수행하므로 LLM 주체가 됨 (API 키 유무 무관)
- **Resilience Engine**: Stagnation 감지 → Lateral Thinking Personas → Human Escalation
- **MCP Server**: stdio transport, API 키 없으면 Passthrough 모드 자동 활성화 (Execute는 항상 Passthrough)
- **Skill System**: SKILL.md 기반 확장, chokidar hot-reload
- **Code Knowledge Graph**: 정적 분석 → 의존성 그래프 → Blast-Radius 영향 파일 추출
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
- `ges_execute`: action=[start|plan_step|plan_complete|execute_start|execute_task|evaluate|status|evolve_fix|evolve|evolve_patch|evolve_re_execute|evolve_lateral|evolve_lateral_result|role_match|role_consensus|review_start|review_submit|review_consensus|review_fix]
- `ges_create_agent`: action=[start|submit]
- `ges_code_graph`: action=[build|blast_radius|diff_radius|query|stats|db_exists]
- `ges_status`: sessionId?

상세 플로우 → [`docs/mcp-reference.md`](./docs/mcp-reference.md)
설정 레퍼런스 → [`docs/configuration.md`](./docs/configuration.md)
코드 그래프 → [`docs/code-graph.md`](./docs/code-graph.md)

## Role Agent 자동 라우팅

아래 상황에서는 사용자가 명시적으로 에이전트를 지정하지 않아도 해당 에이전트를 proactively 사용한다. `/agent [이름] "태스크"` 또는 `ges_agent` MCP 도구로 호출한다.

| 상황 | 에이전트 |
|------|---------|
| 영상/비디오 URL이 포함되거나 "요약해줘" 요청 | `video-summarizer` |
| 번역투·AI 말투·어색한 한국어 교정 요청 | `humanize-monolith` |
| README, API 문서, 가이드, 개발자 문서 작성 | `technical-writer` |
| 슬라이드·발표자료·프레젠테이션 제작 | `presentation-designer` |
| 시스템 설계, 아키텍처 리뷰, 설계 패턴 | `architect` |
| 보안 취약점, 인증/인가, 시크릿 노출 검토 | `security-reviewer` |
| 성능 병목, N+1, 메모리 누수 분석 | `performance-reviewer` |
| 코드 가독성, SOLID, 에러 처리 리뷰 | `quality-reviewer` |
| 테스트 케이스, 엣지 케이스, QA | `qa-engineer` |
| UX 문구 작성·교정, 버튼 텍스트, 에러 메시지, 토스트, 온보딩 카피 | `ux-writer` |
| 슬랙·메신저 메시지 작성 또는 딱딱한/AI스러운 초안을 본인 말투로 다듬기 | `slack-messenger` |
| 슬랙 메시지 전송·예약 발송 요청 ("~라고 보내줘", "공지해줘", "예약 발송해줘") | `slack-send` 스킬 사용 (내부적으로 slack-messenger 다듬기 → 승인 게이트 → 전송) |
| UI, React, 접근성, 컴포넌트 설계 | `frontend-developer` |
| UI·React 코드 리뷰, 접근성·번들 최적화 검토 | `frontend-reviewer` |
| API, DB, 인증, 서버 로직 | `backend-developer` |
| CI/CD, 인프라, 모니터링 | `devops-engineer` |
| 요구사항 정리, 로드맵, 유저 스토리 | `product-planner` |
| 성과 분석·KPI 해석·분기 성과 보고·회고 리포트 | `impact-writer` |
| 제안서, RFC, 의사결정 메모 등 설득·합의용 기획 산문 | `impact-writer` |
| 성과 보고서·제안서·RFC·회고 작성 요청 ("성과 보고서 써줘", "제안서 작성", "RFC 써줘") | `brief` 스킬 사용 |
| 기술 분석, 벤치마크, 사례 조사 | `researcher` |
| PR·브랜치·커밋 코드 리뷰 요청 | `/review` 스킬 사용 |
| PR 작성·생성 요청 ("PR 만들어줘", "PR 작성해줘", "PR 올려줘") | `gestalt:pr` 스킬 사용 |

## Project Structure
```
src/core/        — types, errors, Result monad, config, constants
src/gestalt/     — 게슈탈트 원리 엔진
src/interview/   — InterviewEngine, ResolutionScorer
src/spec/        — SpecGenerator, SpecExtractor
src/execute/     — ExecuteEngine, DAG Validator
src/resilience/  — Stagnation Detector, Lateral Thinking Personas
src/code-graph/  — CodeGraphEngine, BlastRadius, 언어 플러그인 8개
src/agent/       — AgentRegistry, FiguralRouter, RoleAgentRegistry
src/mcp/         — MCP 서버 + 툴 핸들러
src/events/      — EventStore (SQLite)
src/cli/         — commander 기반 CLI
role-agents/     — 내장 Role Agent 8개
skills/          — build-graph, blast-radius, diff-radius
```

## Conventions
- MCP 서버에서 `console.log` 금지 → `log()` stderr 유틸 사용
- `noUncheckedIndexedAccess` 환경 → 배열 인덱스·regex 캡처그룹에 `!` 단언 필수
- `glob` 패키지 미사용 → `readdirSync({ recursive: true })` + `Dirent.parentPath`
- LLM 호출: temperature 0.3, JSON 응답 파싱 + fallback
- 해상도 점수 ≥ 0.8 = 요구사항 충분히 명확
- 테스트 DB: `.gestalt-test/xxx-${randomUUID()}.db` 고유 경로 (병렬 안전)
- 한글 산문에서 가운뎃점(·) 나열 절제 → 쉼표나 "A랑 B하고 C"로 (표·용어 목록은 예외). 룰은 `ai-tell-quick-rules.md` C-12, `style-guide.md`에 정의
