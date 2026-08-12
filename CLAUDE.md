# Gestalt — AI Development Harness

## Overview
게슈탈트 지각이론을 요구사항 명확화 프로세스에 매핑한 TypeScript 기반 AI 개발 하네스.
"전체는 부분의 합보다 크다" — 흩어진 요구사항 조각들을 모아 완전한 스펙(Spec)으로 결정화.

## Architecture
- **Interview Engine**: 게슈탈트 원리 기반 Q&A로 해상도 점수를 0.8 이상으로 높임
- **Spec Generator**: 완료된 인터뷰에서 구조화된 프로젝트 스펙(Spec) 생성
- **Execute Engine**: Spec→ExecutionPlan 변환 (Figure-Ground→Closure→Proximity→Continuity). 설계상 **항상 Passthrough 모드** — Claude Code가 도구(Bash/Edit 등)로 실제 파일 수정·코드 실행을 수행하므로 LLM 주체가 됨 (API 키 유무 무관)
- **Resilience Engine**: Stagnation 감지 → Lateral Thinking Personas → Human Escalation
- **Review Pipeline**: Code Review 5종 에이전트(보안/성능/품질/프론트엔드/주석) + consensus → 자동 수정 루프
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
pnpm verify:rules  # 룰북과 에이전트 문서의 룰 ID·심각도 정합 검사
pnpm build:output-style  # 룰북 → ~/.claude/output-styles/tienne-voice.md 생성
pnpm tsx bin/gestalt.ts humanize-check --before a.md --after b.md --register report
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
plugin/role-agents/    — 내장 Role Agent 9개 (architect, frontend-developer, backend-developer, devops-engineer, qa-engineer, designer, product-planner, researcher, technical-writer) + 스킬 지원용 에이전트(jira-writer, slack-messenger, presentation-writer, code-review-writer, code-review-responder 등) 총 21개 + `_shared/references/` 공유 룰북(author-voice, ai-tell-quick-rules, style-guide, comment-rules — 에이전트 아님, 레지스트리가 건너뜀)
plugin/review-agents/  — 내장 Review Agent 5개 (security-reviewer, performance-reviewer, quality-reviewer, frontend-reviewer, comment-reviewer)
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
