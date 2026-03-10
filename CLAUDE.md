# Gestalt — AI Development Harness

## Overview
게슈탈트 심리학 원리를 요구사항 명확화 프로세스에 매핑한 TypeScript 기반 AI 개발 하네스.
"전체는 부분의 합보다 크다" — 흩어진 요구사항 조각들을 모아 완전한 스펙(Seed)으로 결정화.

## Architecture
- **Interview Engine**: 게슈탈트 원리 기반 Q&A로 모호성 점수를 0.2 이하로 낮춤
- **Seed Generator**: 완료된 인터뷰에서 구조화된 프로젝트 스펙(Seed) 생성
- **MCP Server**: stdio transport로 Claude Code 등 AI 에이전트와 통합
- **Skill System**: SKILL.md 기반 확장, chokidar hot-reload 지원
- **Event Store**: better-sqlite3 WAL 모드 이벤트 소싱

## Tech Stack
TypeScript 5.x / ESM / pnpm / vitest
Dependencies: @anthropic-ai/sdk, @modelcontextprotocol/sdk, better-sqlite3, zod, chokidar, commander, gray-matter

## Key Commands
```bash
pnpm test          # Run all tests (vitest)
pnpm run serve     # Start MCP server
pnpm tsx bin/gestalt.ts interview "topic"  # Interactive interview
pnpm tsx bin/gestalt.ts seed <session-id>  # Generate seed
pnpm tsx bin/gestalt.ts status             # Check sessions
```

## MCP Tools
- `gestalt_interview`: action=[start|respond|score|complete]
- `gestalt_generate_seed`: sessionId, force?
- `gestalt_status`: sessionId?

## Project Structure
- `src/core/` — types, errors, Result monad, config, constants
- `src/gestalt/` — 게슈탈트 원리 엔진 (핵심 차별점)
- `src/interview/` — InterviewEngine, AmbiguityScorer, SessionManager
- `src/seed/` — SeedGenerator, SeedExtractor
- `src/skills/` — SkillRegistry, parser
- `src/mcp/` — MCP 서버 + 툴 핸들러
- `src/events/` — EventStore (SQLite)
- `src/llm/` — Anthropic SDK adapter
- `src/cli/` — commander 기반 CLI

## Conventions
- MCP 서버에서 `console.log` 사용 금지 → stderr(`log()` 유틸)
- LLM 호출: temperature 0.3, JSON 응답 파싱 + fallback
- 모호성 점수 ≤ 0.2 = 요구사항 충분히 명확
- Seed 생성 실패 시 최대 3회 재시도
- 테스트: 각 test에서 고유 DB 경로 사용 (병렬 테스트 안전)
