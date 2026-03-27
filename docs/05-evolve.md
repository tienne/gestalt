# 5단계: Evolve — 실패한 실행을 진화시키다

> Evaluate가 "아직 부족하다"고 판정했을 때 Evolve가 시작된다. 단순히 재실행하는 게 아니라, 무엇이 잘못됐는지를 진단하고 Spec 자체를 수술하거나 관점을 바꿔 새로운 해결책을 찾는다.

---

## 무엇을 하는가

Evaluate 점수가 성공 임계값 미달일 때 Evolve는 세 가지 흐름(Flow A/B/C) 중 하나로 분기한다. 각 흐름은 실패 원인에 맞는 처방을 적용한 뒤 re-evaluate를 통해 수렴을 시도한다.

---

## 게슈탈트 원리 적용

Evolve는 **전체 5원리의 동적 조합**으로 작동한다.

- **폐쇄성**: 미완성된 구현의 빈틈을 찾아 채운다 (Flow A — Structural Fix)
- **연속성**: Spec과 구현의 흐름 단절을 감지하고 수정한다 (Flow B — Spec Patch)
- **다중안정성(Multistability)**: 막혔을 때 다른 각도로 문제를 재구성한다 (Flow C — Lateral Thinking)

---

## Flow A: Structural Fix

Evaluate Structural Stage 실패 시 진입한다.

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

최대 **3회** 재시도. 초과 시 `terminationReason: 'hard_cap'`.

---

## Flow B: Contextual Evolution

Structural은 통과했지만 Contextual 점수 미달 시 진입한다.

### Spec Patch 범위 제한 (L1~L4 계층)

| 계층 | 대상 | 변경 가능 여부 |
|:---:|:---|:---|
| L1 | `acceptanceCriteria` | 자유 추가/수정/삭제 |
| L2 | `constraints` | 자유 추가/수정/삭제 |
| L3 | `ontologySchema` | 추가·변경만 허용, 삭제 금지 |
| L4 | `goal` | **변경 금지** |

소스: `src/execute/spec-patch-validator.ts`

```
// 1. Evolution 컨텍스트 요청
ges_execute({ action: "evolve", sessionId: "<id>" })
→ evolveContext 반환 (현재 점수, 미충족 AC, 드리프트 요약)
  또는 stagnation/oscillation 감지 시 → lateralContext 반환 (Flow C 자동 분기)
  또는 hard_cap/caller 종료 시 → terminateReason 반환

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

최대 **3회** 반복. 초과 시 Flow C로 자동 분기.

---

## Flow C: Lateral Thinking

Stagnation/Oscillation 감지 시 Evolve에서 자동 분기한다. 게슈탈트 심리학의 확장 개념 4가지 Persona가 각기 다른 관점으로 Spec을 재구성한다.

### Stagnation 패턴 → Persona 매핑

| 패턴 | 감지 조건 | Persona | 전략 |
|:---|:---|:---|:---|
| `spinning` | hard_cap 도달 | **Multistability** | 같은 요소를 다른 각도로 재해석 |
| `oscillation` | 점수가 up/down 반복 | **Simplicity** | 요구사항을 단순화해 핵심만 남기기 |
| `no_drift` | delta ≈ 0, 변화 없음 | **Reification** | 암묵적으로 빠진 조각을 명시적으로 채우기 |
| `diminishing_returns` | delta 점점 감소 | **Invariance** | 성공한 패턴을 다른 영역에 복제 |

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
      constraints: ["...]
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
  또는 모든 Persona 소진 시 → humanEscalation 반환
```

### Human Escalation

4개 Persona를 모두 소진해도 성공하지 못하면 `humanEscalation`을 반환하고 세션을 종료한다.

```typescript
interface EscalationContext {
  triedPersonas: LateralPersonaName[];
  bestScore: number;
  bestScoreGeneration: number;
  suggestions: string[];   // 사람이 개입해야 할 구체적 제안
}
```

세션 최종 상태: `status: 'failed'`, `terminationReason: 'human_escalation'`

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

### Caller 강제 종료

```
ges_execute({ action: "evolve", sessionId: "<id>", terminateReason: "caller" })
```

---

## Spec History

각 Evolution 세대마다 Spec snapshot과 delta를 기록한다.

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

## 설계 결정

**왜 L4(goal)를 절대 변경하지 못하게 하는가?**
goal은 Spec의 존재 이유다. 구현이 어렵다고 목표를 바꾸면 처음에 사용자가 원했던 것과 다른 결과물이 나온다. 모든 AC, constraint, ontology는 goal을 달성하기 위한 수단이므로 수단이 어렵다면 수단을 바꿔야지 목적을 바꿔선 안 된다.

**왜 Oscillation을 Stagnation과 구분하는가?**
Oscillation(점수 반복)과 Stagnation(점수 정체)은 원인이 다르다. Oscillation은 Spec이 서로 충돌하는 요구사항을 포함하고 있음을 시사하므로 단순화(Simplicity)가 처방이다. Stagnation은 빠진 요소가 있거나 방향이 틀렸음을 시사하므로 재해석(Multistability)이나 채우기(Reification)가 처방이다.

**왜 Caller 종료를 명시적으로 지원하는가?**
Gestalt는 Passthrough 모드에서 Caller가 전체 흐름을 제어한다. Caller(Claude Code 등)가 외부 판단으로 "이제 충분하다"거나 "사용자가 요청을 취소했다"고 판단할 때 강제 종료할 수 있어야 한다.

---

## MCP 액션 요약

| 액션 | 설명 |
|:---|:---|
| `evolve_fix` | Structural Fix context 요청 (Call 1) 또는 Fix 결과 제출 (Call 2) |
| `evolve` | Contextual Evolution context 요청 + Stagnation 감지 → 자동 분기 |
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
