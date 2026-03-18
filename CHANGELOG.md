# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/tienne/gestalt/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tienne/gestalt/releases/tag/v0.1.0
