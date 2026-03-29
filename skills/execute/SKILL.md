---
name: execute
version: "1.2.0"
description: "Gestalt-driven execution planner that transforms a Spec into a validated ExecutionPlan"
triggers:
  - "execute"
  - "plan execution"
  - "create execution plan"
inputs:
  spec:
    type: object
    required: true
    description: "A validated Spec specification from the spec generation step"
outputs:
  - executionPlan
---

# Execute Skill

This skill transforms a validated Spec specification into a concrete, dependency-aware Execution Plan, executes it with multi-perspective Role Agent guidance, and validates the result through a 2-stage evaluation pipeline.

## Full Pipeline

```
Planning  →  Execution  →  Evaluate  →  (Evolve if needed)
```

### Phase 1 — Planning

1. **Figure-Ground** (Step 1): Classify acceptance criteria as essential (figure) or supplementary (ground), assign priority levels
2. **Closure** (Step 2): Decompose ACs into atomic tasks, including implicit sub-tasks
3. **Proximity** (Step 3): Group related tasks by domain into logical task groups
4. **Continuity** (Step 4): Validate the dependency DAG — no cycles, clear topological order

### Phase 2 — Execution

Run tasks in topological order. For each task:

1. **Role Match** (optional but recommended): identify which Role Agents are relevant to this task
2. **Role Consensus**: collect multi-perspective guidance from matched agents
3. **Execute Task**: perform the task using the role guidance

### Phase 3 — Evaluate

After all tasks complete, run a 2-stage evaluation:

- **Stage 1 (Structural)**: run lint → build → test — short-circuits if any fail
- **Stage 2 (Contextual)**: LLM validates each AC + goal alignment

Success condition: `score ≥ 0.85` AND `goalAlignment ≥ 0.80`

### Phase 4 — Evolve (when evaluation fails)

- **Flow A — Structural Fix**: fix lint/build/test failures → re-evaluate
- **Flow B — Contextual Evolution**: patch Spec ACs/constraints → re-execute impacted tasks → re-evaluate
- **Flow C — Lateral Thinking**: when stagnation detected, rotate through Multistability / Simplicity / Reification / Invariance personas

## Passthrough Mode

API 키 없이 MCP 서버 실행 시 자동 활성화. LLM 작업을 caller가 직접 수행한다.

### Action별 사용법

**`start`** — 실행 계획 세션 시작
```json
{ "action": "start", "spec": { ... } }
```
→ `{ status, sessionId, specId, executeContext, message }`

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
| `spec` | Spec | 원본 Spec 스펙 |
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

---

## Phase 2 — Execution

### `execute_start` — 실행 시작

`plan_complete` 이후 호출. 태스크 목록을 받아 실행 준비.

```json
{ "action": "execute_start", "sessionId": "..." }
```
→ `{ status, sessionId, executionPlan, message }`

---

### Role Agent 플로우 (태스크당, 선택적)

태스크 내용과 관련된 Role Agent가 있을 경우 role_match → role_consensus 순으로 호출해 guidance를 받는다. 문서 작성, 보안, 성능, 아키텍처 등 전문 영역이 필요한 태스크에 특히 유효하다.

**`role_match` — 관련 에이전트 매칭 (2-Call)**

```json
// Call 1: 매칭 컨텍스트 요청
{ "action": "role_match", "sessionId": "..." }
```
→ `{ matchContext }` — 어떤 에이전트가 적합한지 판단하기 위한 프롬프트

```json
// Call 2: 매칭 결과 제출
{
  "action": "role_match",
  "sessionId": "...",
  "matchResult": [
    { "agentName": "technical-writer", "domain": ["documentation"], "relevanceScore": 0.9, "reasoning": "..." },
    { "agentName": "architect", "domain": ["architecture"], "relevanceScore": 0.7, "reasoning": "..." }
  ]
}
```
→ `{ perspectivePrompts }` — 각 에이전트별 관점 생성 프롬프트

**`role_consensus` — 다중 관점 합의 (2-Call)**

```json
// Call 1: 각 에이전트 관점 수집 후 제출
{
  "action": "role_consensus",
  "sessionId": "...",
  "perspectives": [
    { "agentName": "technical-writer", "perspective": "...", "confidence": 0.9 },
    { "agentName": "architect", "perspective": "...", "confidence": 0.8 }
  ]
}
```
→ `{ synthesisContext }` — 관점 통합 프롬프트

```json
// Call 2: 합성된 합의 제출
{
  "action": "role_consensus",
  "sessionId": "...",
  "consensus": {
    "consensus": "통합된 가이드라인",
    "conflictResolutions": ["...", "..."],
    "perspectives": [...]
  }
}
```
→ `{ roleGuidance }` — execute_task 시 참조할 최종 guidance

---

### 병렬 그룹 실행 (parallelGroups 활용)

`plan_complete` 응답에 `parallelGroups: string[][]`가 포함되어 있으면 병렬 실행을 사용한다. 각 내부 배열은 동시에 실행할 수 있는 태스크 ID 묶음이다.

**병렬 그룹 실행 흐름:**

1. `parallelGroups[groupIndex]`의 taskId 목록을 확인한다.
2. **단일 메시지에서** 각 taskId마다 Agent 툴을 하나씩, 동시에 호출한다 (여러 Agent 툴 호출을 같은 메시지에 담는다).
3. 각 Agent는 독립적으로 해당 태스크를 수행하고, 완료되면 `execute_task`를 호출해 결과를 제출한다.
4. 그룹 내 일부 Agent가 실패해도 나머지는 계속 실행한다. 실패한 태스크는 `status: "failed"`로 제출한다.
5. 그룹 내 모든 Agent가 완료되면 다음 그룹으로 넘어간다.
6. 모든 그룹이 완료된 후 실패한 태스크가 있으면 기존 evolve 파이프라인으로 재처리한다.

**Agent 툴 호출 예시 (parallelGroups[0] = ["task-0", "task-1", "task-2"] 인 경우):**

단일 메시지에서 세 Agent를 동시에 실행한다.

```
// 같은 메시지에서 동시 호출 — Agent 1
Agent(task: "task-0 실행: {task-0 title}\n컨텍스트: {taskContext}\n완료 후 execute_task로 결과 제출")

// 같은 메시지에서 동시 호출 — Agent 2
Agent(task: "task-1 실행: {task-1 title}\n컨텍스트: {taskContext}\n완료 후 execute_task로 결과 제출")

// 같은 메시지에서 동시 호출 — Agent 3
Agent(task: "task-2 실행: {task-2 title}\n컨텍스트: {taskContext}\n완료 후 execute_task로 결과 제출")
```

**각 Agent의 execute_task 제출:**

```json
{
  "action": "execute_task",
  "sessionId": "...",
  "taskResult": {
    "taskId": "task-0",
    "status": "completed",
    "output": "태스크 수행 결과 요약",
    "artifacts": ["path/to/file.ts"]
  }
}
```

실패 시:
```json
{
  "action": "execute_task",
  "sessionId": "...",
  "taskResult": {
    "taskId": "task-1",
    "status": "failed",
    "output": "실패 원인 설명",
    "artifacts": []
  }
}
```

**parallelGroups가 없는 경우:** 기존 순차 실행 방식을 사용한다.

---

### `execute_task` — 태스크 실행 결과 제출

role_match/role_consensus로 얻은 `roleGuidance`를 참조해 태스크를 수행한 후 결과 제출.
`allTasksCompleted === true`가 될 때까지 반복.

```json
{
  "action": "execute_task",
  "sessionId": "...",
  "taskResult": {
    "taskId": "task-0",
    "status": "completed",
    "output": "태스크 수행 결과 요약",
    "artifacts": ["path/to/file.ts"]
  }
}
```
→ `{ status, nextTaskId?, allTasksCompleted, driftResult? }`

`driftResult`가 반환되면 Spec과의 drift 경고 — 계속 진행하되 다음 태스크에서 방향 보정.

---

## Phase 3 — Evaluate

모든 태스크 완료 후 3-Call 평가 진행.

**Call 1 — Structural 단계 시작**
```json
{ "action": "evaluate", "sessionId": "..." }
```
→ `{ stage: "structural", structuralContext }` — lint/build/test 실행 지시

**Call 2 — Structural 결과 제출**
```json
{
  "action": "evaluate",
  "sessionId": "...",
  "structuralResult": {
    "commands": [
      { "name": "lint", "command": "pnpm run lint", "exitCode": 0, "output": "" },
      { "name": "build", "command": "pnpm run build", "exitCode": 0, "output": "" },
      { "name": "test", "command": "pnpm run test", "exitCode": 0, "output": "360 tests passed" }
    ],
    "allPassed": true
  }
}
```
→ structural 실패 시 `{ stage: "structural_failed", evolveContext }` → Evolve Flow A 진입
→ structural 통과 시 `{ stage: "contextual", evaluationContext }` — AC별 LLM 검증 지시

**Call 3 — Contextual 결과 제출**
```json
{
  "action": "evaluate",
  "sessionId": "...",
  "evaluationResult": {
    "verifications": [
      { "acIndex": 0, "satisfied": true, "evidence": "...", "gaps": [] }
    ],
    "overallScore": 0.92,
    "goalAlignment": 0.88,
    "recommendations": []
  }
}
```
→ `{ status: "completed" }` (score ≥ 0.85, goalAlignment ≥ 0.80)
→ 미달 시 `{ evolveContext }` → Evolve Flow B 진입

---

## Phase 4 — Evolve

### Flow A — Structural Fix

```json
// 1. Fix context 요청
{ "action": "evolve_fix", "sessionId": "..." }
→ fixContext 반환

// 2. Fix 수행 후 결과 제출
{
  "action": "evolve_fix",
  "sessionId": "...",
  "fixTasks": [
    { "taskId": "fix-0", "failedCommand": "pnpm run lint", "errorOutput": "...", "fixDescription": "...", "artifacts": [] }
  ]
}

// 3. Re-evaluate (Phase 3 반복)
{ "action": "evaluate", "sessionId": "..." }
```

### Flow B — Contextual Evolution

```json
// 1. Evolution context 요청
{ "action": "evolve", "sessionId": "..." }
→ evolveContext (또는 terminateReason으로 종료)

// 2. Spec patch 제출 (AC/constraints 수정, goal 변경 불가)
{
  "action": "evolve_patch",
  "sessionId": "...",
  "specPatch": {
    "acceptanceCriteria": ["수정된 AC..."],
    "constraints": ["추가 제약조건..."]
  }
}
→ { impactedTaskIds, reExecuteContext }

// 3. 영향받은 태스크 재실행 (allTasksCompleted까지 반복)
{
  "action": "evolve_re_execute",
  "sessionId": "...",
  "reExecuteTaskResult": { "taskId": "task-3", "status": "completed", "output": "...", "artifacts": [] }
}

// 4. Re-evaluate
{ "action": "evaluate", "sessionId": "..." }
```

### Flow C — Lateral Thinking (stagnation 감지 시 자동 분기)

`evolve` 호출 시 stagnation/oscillation/hard_cap이 감지되면 자동으로 lateral thinking persona로 전환.

```json
// evolve 호출 → lateralContext 반환
{ "action": "evolve", "sessionId": "..." }
→ { status: "lateral_thinking", lateralContext: { persona, pattern, lateralPrompt, ... } }

// Lateral result 제출
{
  "action": "evolve_lateral_result",
  "sessionId": "...",
  "lateralResult": {
    "persona": "multistability",
    "specPatch": { "acceptanceCriteria": [...] },
    "description": "관점 전환으로 요구사항 재구성"
  }
}

// Re-execute + Re-evaluate (Flow B와 동일)

// 다음 persona 요청 (점수 미달 시)
{ "action": "evolve_lateral", "sessionId": "..." }
```

| Stagnation 패턴 | Persona | 전략 |
|---|---|---|
| hard_cap | Multistability | 다른 각도로 보기 |
| oscillation | Simplicity | 단순하게 줄이기 |
| no_drift | Reification | 빠진 조각 채우기 |
| diminishing_returns | Invariance | 성공 패턴 복제 |

4개 persona 소진 → `human_escalation` 반환으로 세션 종료.

### 종료 조건

| 조건 | 트리거 |
|------|--------|
| `success` | score ≥ 0.85 AND goalAlignment ≥ 0.80 |
| `stagnation` | 2회 연속 delta < 0.05 |
| `oscillation` | 2회 연속 점수 역전 |
| `hard_cap` | structural 3회 + contextual 3회 실패 |
| `caller` | `{ action: "evolve", terminateReason: "caller" }` |
| `human_escalation` | 4개 lateral persona 소진 |

---

## 공통 진행 패널

Execute 파이프라인 실행 중 Claude Code Task 패널에 실시간 상태를 표시한다. 패널 업데이트는 best-effort — 실패가 태스크 실행 흐름을 중단시켜서는 안 된다.

### Planning 단계 시작 시 (`start` 응답 수신 후)

`TaskCreate`로 실행 패널을 생성하고, 반환된 taskId를 세션 동안 보관한다.

```
subject: "Gestalt Execute: {spec.goal 앞 40자}"
description: "Planning 중 | 단계 1/4 | figure_ground"
activeForm: "실행 계획 수립 중"
```

### Planning 각 단계 후 (`plan_step` 응답 수신 시마다)

`TaskUpdate`로 현재 Planning 단계를 업데이트한다.

```
description: "Planning 중 | 단계 {stepsCompleted}/4 | {currentPrinciple}"
```

### Execution 시작 후 (`execute_start` 응답 수신 후)

Planning 패널 태스크를 완료하고, 새 Execution 패널 태스크를 생성한다.

```
subject: "Gestalt Execute: {spec.goal 앞 40자}"
description: "0/{totalTasks} 완료 | 실패: 0개 | 그룹 0/{parallelGroupCount}"
activeForm: "실행 중: {taskContext.currentTask.title}"
```

`plan_complete` 응답의 `planSummary.totalTasks`와 `planSummary.parallelGroupCount`를 활용한다.
`taskContext.currentTask.title`은 `execute_start` 응답에서 바로 꺼내 쓴다.

### 병렬 그룹 실행 시작 시 (Agent 툴 동시 호출 직전)

각 병렬 그룹 실행을 시작하기 전에 `TaskUpdate`로 병렬 실행 상태를 표시한다.

```
activeForm: "병렬 실행 중: 그룹 {groupIndex}/{totalGroups} — {agentCount}개 Agent 실행 중"
```

- `groupIndex`: 현재 병렬 그룹 번호 (1부터 시작)
- `totalGroups`: 전체 병렬 그룹 수 (`parallelGroups.length`)
- `agentCount`: 현재 그룹의 태스크 수 (`parallelGroups[groupIndex].length`)

### 각 태스크 완료 후 (`execute_task` 응답 수신 시마다)

`TaskUpdate`로 진행 상황과 현재 실행 태스크명을 업데이트한다.

순차 실행 중:
```
description: "{completedCount}/{totalTasks} 완료 | 실패: {failedCount}개 | 그룹 {groupIndex}/{totalGroups}"
activeForm: "실행 중: {taskContext.currentTask.title}"
```

병렬 그룹 실행 중 (각 Agent의 execute_task 완료 시):
```
description: "{completedCount}/{totalTasks} 완료 | 실패: {failedCount}개 | 그룹 {groupIndex}/{totalGroups}"
activeForm: "병렬 실행 중: 그룹 {groupIndex}/{totalGroups} — {agentCount}개 Agent 실행 중"
```

- `completedCount`: 지금까지 제출한 taskResult 수 (`response.completedTasks`)
- `failedCount`: status가 `failed`인 taskResult 수
- `groupIndex/totalGroups`: 현재 처리 중인 병렬 그룹 번호 / 전체 그룹 수
- `agentCount`: 해당 그룹에서 아직 실행 중인 Agent 수

`allTasksCompleted === true` 이면 `TaskUpdate({ status: "completed", activeForm: undefined, description: "전체 완료 ({totalTasks}개)" })`로 변경한다.

### 평가/진화 단계

- `evaluate` 시작: description에 "평가 중 — structural 검사" 추가
- structural 통과: "평가 중 — contextual 검사" 로 업데이트
- 평가 완료(success): `TaskUpdate({ status: "completed", description: "완료 | score: {overallScore} | alignment: {goalAlignment}" })`
- Evolve 진입: description에 "개선 중 (generation {N})" 추가

### 오류/에스컬레이션 시

```
status: "completed"
description: "종료: {terminationReason} | 최고 점수: {bestScore}"
```
