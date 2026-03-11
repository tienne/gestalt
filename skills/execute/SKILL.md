---
name: execute
version: "1.0.0"
description: "Gestalt-driven execution planner that transforms a Seed into a validated ExecutionPlan"
triggers:
  - "execute"
  - "plan execution"
  - "create execution plan"
inputs:
  seed:
    type: object
    required: true
    description: "A validated Seed specification from the seed generation step"
outputs:
  - executionPlan
---

# Execute Skill

This skill transforms a validated Seed specification into a concrete, dependency-aware Execution Plan by applying Gestalt psychology principles as a structured planning framework.

## Process

1. **Figure-Ground** (Step 1): Classify acceptance criteria as essential (figure) or supplementary (ground), assign priority levels
2. **Closure** (Step 2): Decompose ACs into atomic tasks, identify implicit sub-tasks not explicitly stated
3. **Proximity** (Step 3): Group related atomic tasks into logical task groups by domain
4. **Continuity** (Step 4): Validate the dependency DAG — ensure no cycles, no conflicts, clear execution order

## Passthrough Mode

API 키 없이 MCP 서버 실행 시 자동 활성화. LLM 작업을 caller가 직접 수행한다.

### Action별 사용법

**`start`** — 실행 계획 세션 시작
```json
{ "action": "start", "seed": { ... } }
```
→ `{ status, sessionId, seedId, executeContext, message }`

**`plan_step`** — 각 계획 단계 결과 제출
```json
{ "action": "plan_step", "sessionId": "...", "stepResult": { "principle": "figure_ground", "classifiedACs": [...] } }
```
→ `{ status, sessionId, stepsCompleted, isLastStep, executeContext?, message }`

**`plan_complete`** — 최종 실행 계획 조립
```json
{ "action": "plan_complete", "sessionId": "..." }
```
→ `{ status, sessionId, executionPlan, message }`

**`status`** — 세션 상태 확인
```json
{ "action": "status", "sessionId": "..." }
```

### ExecuteContext 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `systemPrompt` | string | 실행 계획 시스템 프롬프트 |
| `planningPrompt` | string | 현재 단계의 계획 프롬프트 |
| `currentPrinciple` | string | 현재 적용 중인 게슈탈트 원리 |
| `principleStrategy` | string | 해당 원리의 전략 설명 |
| `phase` | string | 현재 단계 (`planning`) |
| `stepNumber` | number | 현재 스텝 번호 (1-4) |
| `totalSteps` | number | 전체 스텝 수 (4) |
| `seed` | Seed | 원본 Seed 스펙 |
| `previousSteps` | array | 이전 단계 결과들 |

### Planning Principle 순서

1. `figure_ground` → ClassifiedAC 배열
2. `closure` → AtomicTask 배열
3. `proximity` → TaskGroup 배열
4. `continuity` → DAGValidation 객체

### 검증 규칙

- 순서가 강제됨: figure_ground → closure → proximity → continuity
- 각 단계 결과는 이전 단계 데이터와 교차 검증됨
- Continuity 단계에서는 서버 측 DAG 검증이 추가로 수행됨
- 모든 AC가 분류되어야 하고, 모든 Task가 그룹에 포함되어야 함
