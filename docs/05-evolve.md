# 5단계: Evolve — 실패한 실행을 진화시키기

> Evaluate가 "아직 부족해요"라고 판정하면 Evolve가 시작돼요. 단순 재실행이 아니라, 실패 원인을 진단하고 Spec 자체를 수정하거나 관점을 바꿔 새 해결책을 찾아요.

---

## Evolve는 어떤 일을 하나요?

Evaluate 점수가 성공 임계값에 미달하면 Evolve가 실행돼요. 실패 원인에 따라 세 가지 흐름 중 하나로 분기해요.

- **Flow A — Structural Fix**: 빌드·린트·테스트가 실패한 경우
- **Flow B — Contextual Evolution**: 구조는 통과했지만 요구사항 충족이 부족한 경우
- **Flow C — Lateral Thinking**: 반복 시도에도 개선이 없는 경우

각 흐름은 처방을 적용한 뒤 re-evaluate로 수렴을 시도해요.

---

## 게슈탈트 원리 적용

Evolve는 전체 5원리를 동적으로 조합해서 작동해요.

- **폐쇄성**: 미완성 구현의 빈틈을 찾아 채워요 (Flow A)
- **연속성**: Spec과 구현의 흐름 단절을 감지하고 수정해요 (Flow B)
- **다중안정성(Multistability)**: 막혔을 때 다른 각도로 문제를 재구성해요 (Flow C)

---

## Flow A: Structural Fix

Evaluate Structural Stage가 실패하면 진입해요.

```
// 1. Fix 컨텍스트 요청
ges_execute({ action: "evolve_fix", sessionId: "<id>" })
→ fixContext 반환 (systemPrompt, fixPrompt, 실패한 명령어 목록)

// 2. Fix 결과 제출
ges_execute({
  action: "evolve_fix",
  sessionId: "<id>",
  fixTasks: [
    {
      taskId: "fix-001",
      failedCommand: "pnpm build",
      errorOutput: "Cannot find module 'zod'",
      fixDescription: "pnpm add zod 실행으로 의존성 추가",
      artifacts: ["package.json", "pnpm-lock.yaml"]
    }
  ]
})
→ re-evaluate 준비 완료

// 3. Re-evaluate
ges_execute({ action: "evaluate", sessionId: "<id>" })
```

최대 **3회** 재시도할 수 있어요. 초과하면 `terminationReason: 'hard_cap'`으로 종료돼요.

---

## Flow B: Contextual Evolution

Structural은 통과했지만 Contextual 점수가 미달이면 진입해요.

### Spec Patch는 어느 범위까지 수정할 수 있나요?

Spec은 4개 계층으로 나뉘어요. 계층마다 수정 가능 범위가 달라요.

| 계층 | 대상 | 수정 범위 |
|:---:|:---|:---|
| **L1** | `acceptanceCriteria` | 추가 · 수정 · 삭제 모두 가능 |
| **L2** | `constraints` | 추가 · 수정 · 삭제 모두 가능 |
| **L3** | `ontologySchema` | 추가 · 변경만 허용, **삭제 금지** |
| **L4** | `goal` | **변경 금지** |

소스: `src/execute/spec-patch-validator.ts`

```
// 1. Evolution 컨텍스트 요청
ges_execute({ action: "evolve", sessionId: "<id>" })
→ evolveContext 반환 (현재 점수, 미충족 AC, 드리프트 요약)
  stagnation/oscillation 감지 시 → lateralContext 반환 (Flow C 자동 분기)
  hard_cap/caller 종료 시 → terminateReason 반환

// 2. Spec Patch 제출
ges_execute({
  action: "evolve_patch",
  sessionId: "<id>",
  specPatch: {
    acceptanceCriteria: ["새로운 AC 추가"],
    constraints: ["성능 요구사항 추가"],
    ontologySchema: { entities: [...], relations: [...] }  // 선택
  }
})
→ impactedTaskIds + reExecuteContext 반환

// 3. 영향받은 태스크 재실행 (반복)
ges_execute({
  action: "evolve_re_execute",
  sessionId: "<id>",
  reExecuteTaskResult: {
    taskId: "task-003",
    status: "completed",
    output: "...",
    artifacts: ["src/auth.ts"]
  }
})
→ allTasksCompleted === true까지 반복

// 4. Re-evaluate
ges_execute({ action: "evaluate", sessionId: "<id>" })
```

최대 **3회** 반복할 수 있어요. 초과하면 Flow C로 자동 분기돼요.

---

## Flow C: Lateral Thinking

Stagnation 또는 Oscillation이 감지되면 Evolve에서 자동 분기해요. 게슈탈트 심리학의 확장 개념에서 가져온 4가지 Persona가 각기 다른 관점으로 Spec을 재구성해요.

### 어떤 패턴에 어떤 Persona가 매핑되나요?

| 패턴 | 감지 조건 | Persona | 전략 |
|:---|:---|:---|:---|
| `spinning` | hard_cap 도달 | **Multistability** | 같은 요소를 다른 각도로 재해석해요 |
| `oscillation` | 점수가 up/down 반복 | **Simplicity** | 요구사항을 단순화해 핵심만 남겨요 |
| `no_drift` | delta ≈ 0, 변화 없음 | **Reification** | 암묵적으로 빠진 조각을 명시적으로 채워요 |
| `diminishing_returns` | delta 점점 감소 | **Invariance** | 성공한 패턴을 다른 영역에 복제해요 |

소스: `src/resilience/types.ts`, `src/resilience/lateral.ts`

### Lateral Thinking 흐름

```
// Flow B의 evolve 호출에서 stagnation 감지 시 자동 반환
ges_execute({ action: "evolve", sessionId: "<id>" })
→ { status: "lateral_thinking", lateralContext: { persona, pattern, systemPrompt, lateralPrompt } }

// Lateral Result 제출 (Persona 관점으로 specPatch 생성)
ges_execute({
  action: "evolve_lateral_result",
  sessionId: "<id>",
  lateralResult: {
    persona: "multistability",
    specPatch: {
      acceptanceCriteria: ["재구성된 AC"],
      constraints: ["..."]
    },
    description: "관점 전환 설명"
  }
})
→ impactedTaskIds + reExecuteContext 반환

// 재실행 (기존 evolve_re_execute 재사용)
// Re-evaluate (기존 evaluate 재사용)

// 점수 미달 시 다음 Persona 요청
ges_execute({ action: "evolve_lateral", sessionId: "<id>" })
→ 다음 lateralContext 반환
  모든 Persona 소진 시 → humanEscalation 반환
```

### Human Escalation

4개 Persona를 모두 소진해도 성공하지 못하면 `humanEscalation`을 반환하고 세션을 종료해요.

```typescript
interface EscalationContext {
  triedPersonas: LateralPersonaName[];
  bestScore: number;
  bestScoreGeneration: number;
  suggestions: string[];   // 사람이 개입해야 할 구체적 제안
}
```

세션 최종 상태는 `status: 'failed'`, `terminationReason: 'human_escalation'`이에요.

---

## 종료 조건

| 조건 | 트리거 |
|:---|:---|
| `success` | overallScore ≥ 0.85 AND goalAlignment ≥ 0.80 |
| `stagnation` | 연속 2회 delta < 0.05 |
| `oscillation` | 연속 2회 점수 up/down 반복 |
| `hard_cap` | Structural Fix 3회 OR Contextual Evolution 3회 초과 |
| `caller` | Caller가 직접 종료 요청 |
| `human_escalation` | Lateral 4개 Persona 소진 |

소스: `src/execute/termination-detector.ts`

### Caller가 직접 종료하려면?

```
ges_execute({ action: "evolve", sessionId: "<id>", terminateReason: "caller" })
```

---

## Spec History

각 Evolution 세대마다 Spec snapshot과 delta를 기록해요.

```typescript
interface EvolutionGeneration {
  generation: number;
  specSnapshot: Spec;
  specDelta: SpecDelta;    // 이전 세대와의 차이
  evaluationResult: EvaluationResult;
  terminationReason?: TerminationReason;
}
```

---

## 왜 이렇게 설계했나요?

### 왜 L4(goal)는 절대 변경하지 못하나요?

goal은 Spec의 존재 이유예요. 구현이 어렵다고 목표를 바꾸면 사용자가 처음에 원했던 것과 다른 결과물이 나와요. AC, constraint, ontology는 모두 goal을 달성하기 위한 수단이에요. 수단이 어렵다면 수단을 바꿔야지, 목적을 바꾸면 안 돼요.

### 왜 Oscillation을 Stagnation과 구분하나요?

두 패턴은 원인이 달라요.

Oscillation(점수 반복)은 Spec 안에 서로 충돌하는 요구사항이 있다는 신호예요. 이 경우 단순화(Simplicity)가 처방이에요. Stagnation(점수 정체)은 빠진 요소가 있거나 방향이 틀렸다는 신호예요. 이 경우 재해석(Multistability)이나 빈틈 채우기(Reification)가 처방이에요.

### 왜 Caller 종료를 명시적으로 지원하나요?

Gestalt는 Passthrough 모드에서 Caller가 전체 흐름을 제어해요. Caller(Claude Code 등)가 "이제 충분해요" 또는 "사용자가 요청을 취소했어요"라고 판단할 때 강제 종료할 수 있어야 해요.

---

## MCP 액션 요약

| 액션 | 설명 |
|:---|:---|
| `evolve_fix` | Structural Fix 컨텍스트 요청 (Call 1) 또는 Fix 결과 제출 (Call 2) |
| `evolve` | Contextual Evolution 컨텍스트 요청 + Stagnation 감지 시 자동 분기 |
| `evolve_patch` | Spec Patch 제출 → 영향 태스크 식별 |
| `evolve_re_execute` | 영향받은 태스크 재실행 결과 제출 |
| `evolve_lateral` | 다음 Lateral Persona 요청 |
| `evolve_lateral_result` | Lateral Spec Patch 제출 |

---

## 소스 코드 참조

| 파일 | 역할 |
|:---|:---|
| `src/execute/passthrough-engine.ts` | Evolve 전체 흐름 핸들러 |
| `src/execute/spec-patch-validator.ts` | L1~L4 계층 검증 |
| `src/execute/spec-patch-applier.ts` | Spec 패치 적용 + Jaccard delta 계산 |
| `src/execute/impact-identifier.ts` | 영향받은 태스크 식별 |
| `src/execute/termination-detector.ts` | 종료 조건 감지 (success/stagnation/oscillation/hard_cap) |
| `src/resilience/lateral.ts` | Lateral Thinking persona 시스템 |
| `src/resilience/stagnation-detector.ts` | Stagnation 패턴 분류 |
| `src/resilience/types.ts` | `STAGNATION_PERSONA_MAP`, `LateralPersonaName` |
| `src/core/constants.ts` | `EVOLVE_MAX_STRUCTURAL_FIX`, `EVOLVE_MAX_CONTEXTUAL`, 임계값 |
