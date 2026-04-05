---
name: gestalt-develop
description: "Gestalt TypeScript 프로젝트에서 기능 개발, 버그 수정, MCP Action 추가 등 모든 개발 작업을 분석→구현→테스트 파이프라인으로 자동화한다. '새 MCP 액션 추가', '버그 수정', '기능 구현', '이거 만들어줘' 등 Gestalt 프로젝트 개발 작업 요청이 오면 반드시 이 스킬을 사용할 것."
---

# Gestalt Develop — 피처 개발 오케스트레이터

Gestalt 프로젝트 개발 작업을 3개 서브에이전트 파이프라인으로 자동화한다.

## 파이프라인 구조

```
사용자 요청
    ↓
[준비] _workspace/ 생성 + task.md 작성
    ↓
[Analyst] → _workspace/analysis.md     (탐색 전용, 빠름)
    ↓
[Developer] → _workspace/implementation.md  (구현, 느림)
    ↓
[QA] → _workspace/test-results.md          (테스트 실행)
    ↓
[오케스트레이터] → 결과 확인 + 커밋
```

## 실행 전 준비

`_workspace/` 디렉토리를 생성하고 요청 내용을 저장한다:

```bash
mkdir -p _workspace
```

`_workspace/task.md` 작성:
```markdown
## 요청
[사용자의 원문 요청]

## 컨텍스트
[관련 파일, 에러 메시지, 배경 정보 — 있으면]
```

## Phase 1: 분석 (gestalt-analyst, Explore 타입)

```
Agent(
  subagent_type: "gestalt-analyst",
  model: "opus",
  prompt: """
    _workspace/task.md를 읽고 코드베이스를 탐색하여 구현 분석을 수행하라.
    결과를 _workspace/analysis.md에 저장한다.
    프로젝트 루트: /Users/kwon-david/dev/gestalt
  """
)
```

분석 결과를 읽고 영향 파일 목록과 구현 전략이 충분한지 확인한다.
불충분하면 analyst에게 보완 요청 후 Phase 2 진행.

## Phase 2: 구현 (gestalt-developer, general-purpose)

```
Agent(
  subagent_type: "gestalt-developer",
  model: "opus",
  prompt: """
    _workspace/analysis.md를 읽고 모든 영향 파일을 구현하라.
    완료 후 _workspace/implementation.md에 결과를 저장한다.
    프로젝트 루트: /Users/kwon-david/dev/gestalt
  """
)
```

## Phase 3: 테스트 (gestalt-qa, general-purpose)

```
Agent(
  subagent_type: "gestalt-qa",
  model: "opus",
  prompt: """
    _workspace/analysis.md와 _workspace/implementation.md를 읽고
    테스트를 작성하고 pnpm test를 실행하라.
    결과를 _workspace/test-results.md에 저장한다.
    프로젝트 루트: /Users/kwon-david/dev/gestalt
  """
)
```

테스트 실패 시 재시도 처리 (아래 에러 처리 섹션 참조).

## Phase 4: 완료 처리

1. `_workspace/test-results.md` 확인 — 모든 테스트 통과 여부
2. 통과했으면 변경 파일을 카테고리별로 분리 커밋:
   - `feat(types): ...` — 타입 변경
   - `feat(execute): ...` — 엔진 구현
   - `test(execute): ...` — 테스트 추가
3. 사용자에게 결과 보고

## 커밋 규칙

- `type(scope): subject` 형식, scope 필수
- 클로드 흔적(Co-Authored-By 등) 포함 금지
- 카테고리별로 분리 커밋 (타입/구현/테스트 각각)

## 에러 처리

| 상황 | 대응 |
|------|------|
| 분석 결과 불충분 | analyst 재실행 1회, 여전히 부족하면 사용자에게 질문 |
| 구현 후 lint 에러 | developer에게 수정 요청 (최대 2회) |
| 테스트 실패 (구현 버그) | developer에게 test-results.md 전달 후 수정 요청 (최대 2회) |
| 테스트 실패 (테스트 오류) | qa에게 재작성 요청 (최대 1회) |
| 3회 이상 실패 | 사용자에게 현재 상태 보고 후 에스컬레이션 |

## 테스트 시나리오

**정상 흐름 — MCP Action 추가:**
- 요청: "`spawn` action에 `maxDepth` 파라미터 추가"
- analyst → types.ts, session.ts, passthrough-engine.ts, execute-passthrough.ts, schemas.ts, 테스트 파일 식별
- developer → 각 파일 순서대로 구현, lint 통과
- qa → 2-Call 패턴 테스트 작성, `pnpm test` 통과
- 오케스트레이터 → 3개 커밋 생성

**에러 흐름 — 타입 충돌:**
- qa에서 타입 에러 발견 → test-results.md에 기록
- 오케스트레이터가 developer 재실행 (test-results.md 전달)
- developer 수정 → qa 재실행 → 통과
