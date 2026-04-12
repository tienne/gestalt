# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.0] - 2026-04-12

### Added
- **멀티 프로바이더 LLM 지원**: `gestalt.json`에 `frugal`/`standard`/`frontier` tier별 provider 설정 추가
  - `provider: 'anthropic' | 'openai'`, `apiKey`, `baseURL`(Ollama 등), `model` 설정 가능
  - `src/llm/factory.ts`: `createAdapter()`, `createTierMapping()`, `hasLLMApiKey()` 팩토리 함수 신규 추가
  - 기존 `llm.apiKey` + `llm.model` 단일 구조와 완전 하위 호환
  - Ollama 로컬 모델(Gemma 4 등) 연결 지원
- **Prettier 설정**: `.prettierrc.json` 추가, `pnpm format` / `pnpm format:check` 스크립트 추가
- **CI 커버리지 수정**: `@vitest/coverage-v8` devDependency 추가로 `pnpm test --coverage` CI 실패 해결

### Changed
- `src/llm/openai-adapter.ts`: `baseURL` 옵션 파라미터 추가 (Ollama 호환)
- `src/mcp/server.ts`, CLI 커맨드: `new AnthropicAdapter(...)` 하드코딩 → `createAdapter(config.llm)` 팩토리 교체
- `gestalt.json`: `ambiguityThreshold` → `resolutionThreshold` 키 수정
- `skills/interview/SKILL.md`: 인터뷰 중 Claude가 스스로 질문에 답변하는 문제 방지 규칙 추가
- 전체 소스 파일 Prettier 포맷 일괄 적용

### Documentation
- `docs/configuration.md`: 멀티 프로바이더 설정 방법 및 Ollama 연결 가이드 추가
- `docs/code-graph.md`, `docs/configuration.md`: 신규 문서 추가
- `README.md` / `README.ko.md`: `ges_code_graph`, `ges_graph_visualize`, `ges_benchmark` 툴 추가, 멀티 프로바이더 설정 섹션 추가
- `schemas/gestalt.schema.json`: tier 구조 및 `llmTierConfig` 정의 추가

## [0.9.0] - 2026-03-29

### Added
- **공통 진행 패널**: `/interview`, `/spec`, `/execute` 스킬 실행 중 Claude Code Task 패널에 실시간 진행 상태 표시
  - Planning 시작 시 `TaskCreate`로 패널 생성, 각 단계(`plan_step`, `execute_task`, `evaluate`)마다 `TaskUpdate`로 갱신
  - Interview: 라운드 번호 / 현재 게슈탈트 원리 / 모호성 점수 추이 표시
  - Spec: 생성 중 → 완료(specId 포함) 상태 표시
  - Execute: `{완료}/{총합} 완료 | 현재: {태스크명} | 실패: {n}개 | 그룹 {x}/{y}` 형식 표시
  - best-effort — 패널 업데이트 실패가 파이프라인 실행을 중단하지 않음
  - 스킬 레벨(SKILL.md)에서 동작, MCP 서버 코드 변경 없음

### Changed
- `skills/interview/SKILL.md`: 버전 1.0.0 → 1.1.0, 공통 진행 패널 섹션 추가
- `skills/spec/SKILL.md`: 버전 1.0.0 → 1.1.0, 공통 진행 패널 섹션 추가
- `skills/execute/SKILL.md`: 버전 1.1.0 → 1.2.0, 공통 진행 패널 섹션 추가

### Documentation
- `docs/03-execute.md`: 공통 진행 패널 섹션 추가
- `docs/mcp-reference.md`: execute 섹션에 Progress Panel 설명 추가
- `README.md` / `README.ko.md`: Execute 섹션에 실행 진행 패널 언급 추가
- `CLAUDE.md`: Skill System 항목에 TaskCreate/TaskUpdate 진행 패널 설명 추가

## [0.8.0] - 2026-03-28

### Added
- **Execution Continuity (Resume)**: 중단된 실행 세션을 이어서 실행하는 `resume` MCP action 추가
  - `ges_execute({ action: "resume", sessionId })` — 완료된 태스크 목록 + 다음 태스크 컨텍스트 반환
  - `ResumeContext`: `completedTaskIds`, `nextTaskId`, `totalTasks`, `progressPercent` 포함
  - `ges_status` 응답에 `resumeContext` 자동 포함 (executing 상태 세션)
- **Context Compression**: 인터뷰 컨텍스트가 길어질 때 자동 압축하는 `compress` MCP action 추가
  - 5라운드 초과 시 `compress` 권장 (`needsCompression`, `compressionContext` 응답 포함)
  - `compress` action: 2-Call 패턴 — compressionContext 반환 → caller가 요약 생성 → 제출
  - 압축 요약은 세션에 저장(`compressedContext`)되어 이후 라운드에 자동 주입
  - `ProjectMemoryStore.addCompressedContext()` — `.gestalt/memory.json`에 압축 이력 영속화
- **Spec Template Library**: `ges_generate_spec`에 `template` 파라미터 추가
  - 3개 내장 템플릿: `rest-api`, `react-dashboard`, `cli-tool`
  - 템플릿 제약 조건과 완료 기준이 Spec 생성 프롬프트에 자동 주입
  - `SpecTemplateRegistry`: `list()`, `get()`, `has()`, `buildTemplateContext()`
- **Brownfield Audit**: 기존 코드베이스와 Spec 간 갭을 분석하는 `audit` MCP action 추가
  - 2-Call 패턴: `audit` (context 요청) → codebaseSnapshot + auditResult 제출
  - `AuditResult`: `implementedACs`, `partialACs`, `missingACs`, `gapAnalysis`, `auditedAt`
- **Parallel Task Groups**: 동시 실행 가능한 태스크 그룹 자동 계산
  - `computeParallelGroups()` — DAG 레이어 기반 병렬 그룹 배열 생성
  - `ExecutionPlan.parallelGroups: string[][]` 필드 추가 — `plan_complete` 응답에 포함
- **Sub-agent Spawning**: `spawn` MCP action으로 동적 하위 태스크 생성
  - `ges_execute({ action: "spawn", sessionId, parentTaskId, subTasks })` — SubTask[] 등록
  - `SubTask`: 부모 태스크 컨텍스트를 상속, 독립 실행 가능

### Changed
- `ges_execute` action enum에 `resume`, `audit`, `spawn` 추가
- `ges_interview` action enum에 `compress` 추가
- `ExecuteSession`에 `completedTaskIds`, `nextTaskId`, `subTasks` 필드 추가
- `InterviewSession`에 `compressedContext` 필드 추가

## [0.6.0] - 2026-03-27

### Added
- **Terminal Recording**: `gestalt interview --record` 플래그로 인터뷰 세션 전체를 GIF로 녹화
  - `TerminalRecorder`: `process.stdout.write` 인터셉션으로 NDJSON `.frames` 파일에 실시간 저장
  - `GifGenerator`: jimp(텍스트 렌더링) + gifencoder(GIF 인코딩) — 외부 바이너리 없음
  - `FilenameGenerator`: LLM이 인터뷰 주제 기반 kebab-case slug + YYYYMMDD 날짜로 파일명 자동 생성
  - `SegmentMerger`: 복수 세그먼트 병합 + 5초 이상 갭 3초 압축
  - `ResumeDetector`: `.frames` 파일 존재 시 `--record` 없이도 자동으로 이어서 녹화
  - GIF 생성 완료 후 임시 `.frames` 파일 자동 삭제

## [0.5.1] - 2026-03-20

### Added
- **Node.js 버전 체크**: 실행 시 Node.js >= 20.0.0 검증, 미달 시 업그레이드 안내 메시지 출력
- **README Prerequisites 섹션**: Node.js 최소 버전 요구사항 및 nvm 설치 가이드 추가

### Fixed
- `bin/gestalt.ts` TypeScript 컴파일 에러 수정 (`TS18048: 'major' is possibly undefined`)

## [0.5.0] - 2026-03-20

### Added
- **Code Review Pipeline**: Evolve 이후 최종 완료 직전에 PR 수준의 종합 코드리뷰 게이트 추가
  - `review_start`, `review_submit`, `review_consensus`, `review_fix` 4개 action (ges_execute 통합)
  - 카테고리별 리뷰 에이전트가 독립 리뷰 → 토론/병합 → 최종 합의
  - critical/high 이슈 0건이면 통과, warning 허용
  - 자동 수정 루프 최대 3회, 초과 시 마크다운 리포트로 사람에게 위임
  - 수정 후 Structural 재검증(lint/build/test)만 수행, Contextual 스킵
- **3개 코드리뷰 전용 에이전트**: security-reviewer, performance-reviewer, quality-reviewer
- **ReviewReportGenerator**: 리뷰 결과 JSON → 마크다운 리포트 변환 (severity별 그룹핑, 통계 테이블)
- **ReviewContextCollector**: 변경 파일 + import 의존성 분석으로 리뷰 범위 수집
- **ReviewAgentMatcher**: 기존 Role Agent + 코드리뷰 전용 에이전트 통합 매칭
- `REVIEW_*` 이벤트 7종 추가 (이벤트 소싱)
- **벤치마크 시스템**: `ges_benchmark` MCP 도구, 3개 시나리오 (auth-system, dashboard, api-gateway)
- **TUI 대시보드**: `gestalt monitor` CLI (ink 기반)
- **ges_status 확장**: execute 세션 조회 + sessionType 필터
- **GitHub Actions CI/CD** 워크플로우

### Changed
- `AgentPipeline` 타입에 `'review'` 추가
- `ges_execute` action enum에 `review_start`, `review_submit`, `review_consensus`, `review_fix` 추가
- `executeInputSchema`에 리뷰 관련 입력 필드 추가 (reviewResult, reviewConsensus, reviewSessionId 등)
- execute-passthrough.ts에 default case 추가 (TS exhaustiveness)

## [0.2.0] - 2026-03-14

### Added
- **Role Agent System**: 8개 내장 Role Agent (architect, backend-developer, designer, devops-engineer, frontend-developer, product-planner, qa-engineer, researcher)
- **`ges_create_agent` MCP 도구**: 인터뷰 기반 커스텀 Role Agent 자동 생성 (2-Call: start, submit)
- **Lateral Thinking Personas**: Multistability, Simplicity, Reification, Invariance — stagnation 패턴별 자동 분기
- **Human Escalation**: 4개 persona 소진 시 actionable suggestions 제공
- **Configuration System**: nested config (llm, interview, execute), gestalt.json + dotenv 지원, JSON Schema
- **`gestalt setup` CLI**: gestalt.json 초기 생성 명령어
- **업데이트 알림**: npm 최신 버전 자동 확인
- **Claude Plugin marketplace 매니페스트**: 플러그인 설치 지원
- **TUI Dashboard**: `gestalt monitor` 명령어 (ink 기반)
- **AgentCreationError** 에러 클래스 및 AGENT_CREATED 이벤트 타입

### Changed
- Evolution Loop 종료 시 즉시 종료 대신 lateral thinking으로 자동 분기
- Configuration: flat → nested 구조 (`config.llm.apiKey`, `config.interview.ambiguityThreshold` 등)
- `constants.ts`에서 `process.env` 의존 제거 → 순수 상수

### Fixed
- Claude Code 플러그인 설치 오류 (agents 필드 제거)
- postbuild에 package.json dist 복사 누락
- simulate-lateral TS 에러
- marketplace metadata.version sync
- bin 파일 실행 권한 누락

## [0.1.0] - 2026-03-11

### Added
- **Interview Engine**: 게슈탈트 5원리 기반 요구사항 인터뷰 (start, respond, score, complete)
- **Passthrough Mode**: API 키 없이 MCP 서버 운영, caller에게 LLM 호출 위임
- **Spec Generator**: 인터뷰 완료 후 구조화된 Spec 생성 (2-Call Passthrough 패턴)
- **Execute Engine**: 4단계 Planning (Figure-Ground → Closure → Proximity → Continuity)
- **Execution Phase**: 위상 정렬 기반 태스크 실행 + Similarity 원리 참조 컨텍스트
- **Evaluate 2-Stage Pipeline**: Structural (lint/build/test) → Contextual (LLM AC 검증)
- **Drift Detection**: 3차원 Jaccard (Goal 50%, Constraint 30%, Ontology 20%)
- **Evolution Loop**: Structural Fix + Contextual Evolution + Spec Patch 적용
- **Event Sourcing**: SQLite WAL 모드, Event Replay 기반 세션 재구성
- **Agent System**: 5개 Gestalt 에이전트, FiguralRouter, multi-provider LLM (Anthropic + OpenAI)
- **Skill System**: SKILL.md 파서, chokidar hot-reload
- **MCP Server**: stdio transport, 5개 도구 (ges_interview, ges_generate_spec, ges_execute, ges_create_agent, ges_status)
- **CLI**: interview, spec, status 명령어

### Changed
- Seed → Spec 전면 리네이밍 (타입, 클래스, 필드, MCP 도구, 이벤트, CLI, 문서)

[0.5.1]: https://github.com/tienne/gestalt/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/tienne/gestalt/compare/v0.2.0...v0.5.0
[0.2.0]: https://github.com/tienne/gestalt/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tienne/gestalt/releases/tag/v0.1.0
