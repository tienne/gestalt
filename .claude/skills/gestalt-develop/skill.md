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
[정합 심급] → continuity-judge 감독          (목표 정합·일관성 검토)
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
    완료 후 반드시 아래 순서로 검증하고 모두 통과해야 한다:
      1. pnpm typecheck   (타입 에러 0)
      2. pnpm lint        (ESLint 에러 0)
      3. pnpm format      (Prettier 자동 적용 — check가 아닌 write)
    결과를 _workspace/implementation.md에 저장한다.
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
    테스트를 작성한 뒤 아래 순서로 실행하라:
      1. pnpm format   (테스트 파일 포맷 적용)
      2. pnpm lint     (에러 0 확인)
      3. pnpm test     (전체 테스트)
    결과를 _workspace/test-results.md에 저장한다.
    프로젝트 루트: /Users/kwon-david/dev/gestalt
  """
)
```

테스트 실패 시 재시도 처리 (아래 에러 처리 섹션 참조).

## Phase 3.5: 정합 심급 감독 (continuity-judge)

QA가 "테스트가 통과하나"(부분의 정확성)를 봤다면, 정합 심급은 "구현 전체가 요청 의도를 이루나"(부분의 합)를 본다. 테스트는 통과해도 요청과 어긋나거나 범위를 벗어난 구현을 커밋 전에 잡는 단계다. **서브에이전트가 아니라 오케스트레이터가 직접** 수행한다.

`ges_agent { action: "get", name: "continuity-judge" }`로 시스템 프롬프트를 가져온 뒤(원리 에이전트라도 `get`으로 조회된다), 그 관점에서 `_workspace/task.md`(원 요청·의도)를 기준으로 `_workspace/implementation.md`와 `_workspace/test-results.md`를 세 축으로 판단한다.

- **목표 정합(goal)**: 구현이 요청한 것을 하는가? 요청에 없던 범위를 임의로 늘리거나, 요청 핵심을 빠뜨리지 않았는가?
- **일관성(consistency)**: 변경한 파일 간, 그리고 기존 코드 컨벤션(MCP stderr 로깅·ESM·2-Call Passthrough 등)과 일관된가?
- **이탈(drift)**: task.md의 제약·의도와 모순되는 결정이 있는가?

판단 결과에 따라 분기한다:

- **정합(coherent)** → Phase 4로 진행. 커밋한다.
- **이탈 있으나 수정 가능(escalate 아님)** → developer에게 해당 정합 항목을 전달해 보완 요청(최대 1회) 후 Phase 3(QA)부터 재확인. 이후 다시 정합 심급.
- **재설계 필요(escalate)** → **커밋하지 않는다.** 라인 수정이 아니라 요청 자체의 해석·범위 문제이므로, 구현 요약과 이탈 내용을 사용자에게 보고하고 방향을 확인받는다.

## Phase 4: 완료 처리

1. `_workspace/test-results.md` 확인 — 모든 테스트 통과 여부
2. **Phase 3.5 정합 심급을 통과**(coherent, 또는 보완 후 통과)했는지 확인. escalate면 여기서 멈추고 사용자 확인.
3. 통과했으면 변경 파일을 카테고리별로 분리 커밋:
   - `feat(types): ...` — 타입 변경
   - `feat(execute): ...` — 엔진 구현
   - `test(execute): ...` — 테스트 추가
4. 사용자에게 결과 보고

## 커밋 규칙

- `type(scope): subject` 형식, scope 필수
- 클로드 흔적(Co-Authored-By 등) 포함 금지
- 카테고리별로 분리 커밋 (타입/구현/테스트 각각)

## 에러 처리

| 상황 | 대응 |
|------|------|
| 분석 결과 불충분 | analyst 재실행 1회, 여전히 부족하면 사용자에게 질문 |
| 구현 후 typecheck/lint 에러 | developer에게 수정 요청 (최대 2회) |
| 구현 후 format 미적용 | developer에게 `pnpm format` 실행 후 재확인 요청 (1회) |
| 테스트 실패 (구현 버그) | developer에게 test-results.md 전달 후 수정 요청 (최대 2회) |
| 테스트 실패 (테스트 오류) | qa에게 재작성 요청 (최대 1회) |
| 정합 심급 이탈 (수정 가능) | developer에게 정합 항목 전달 후 보완 요청 (최대 1회) → Phase 3부터 재확인 |
| 정합 심급 재설계 필요 (escalate) | 커밋 중단, 구현 요약과 이탈 내용 보고 후 사용자에게 방향 확인 |
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
