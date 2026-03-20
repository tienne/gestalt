# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
