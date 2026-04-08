# Gestalt — AI Development Harness

## Overview
게슈탈트 지각이론을 요구사항 명확화 프로세스에 매핑한 TypeScript 기반 AI 개발 하네스.
"전체는 부분의 합보다 크다" — 흩어진 요구사항 조각들을 모아 완전한 스펙(Spec)으로 결정화.

## Architecture
- **Interview Engine**: 게슈탈트 원리 기반 Q&A로 해상도 점수를 0.8 이상으로 높임
- **Spec Generator**: 완료된 인터뷰에서 구조화된 프로젝트 스펙(Spec) 생성
- **Execute Engine**: Spec→ExecutionPlan 변환 (Figure-Ground→Closure→Proximity→Continuity)
- **Resilience Engine**: Stagnation 감지 → Lateral Thinking Personas → Human Escalation
- **MCP Server**: stdio transport, API 키 없으면 Passthrough 모드 자동 활성화
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
