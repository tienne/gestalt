# 4단계: Evaluate — 실행 결과를 기준으로 검증

태스크가 완료됐다고 끝이 아니에요. Evaluate 단계는 두 가지 관점에서 결과를 검증해요. 빌드가 깨지지 않았는지(Structural), 그리고 원래 의도에 부합하는지(Contextual).

---

## 무엇을 하나요?

완료된 태스크 결과를 **2-Stage Pipeline**으로 평가해요. Structural Stage가 먼저 실행되고, 통과할 때만 Contextual Stage로 진행해요. 두 점수를 합산해서 성공 여부를 판정해요.

---

## 게슈탈트 원리는 어떻게 적용되나요?

Evaluate는 **연속성(Continuity)** 원리가 주도해요.

실행 결과가 Spec의 흐름과 일관성을 유지하는지 측정해요. Structural은 연속성의 기술적 측면(코드가 동작하는가)을 검증하고, Contextual은 의미적 측면(목표와 정렬되는가)을 검증해요.

---

## 2-Stage Pipeline

### Stage 1: Structural

코드가 실제로 동작하는지 자동 명령어로 검증해요.

```
lint → build → test
```

명령어는 Spec 또는 ExecutionPlan에서 파생돼요. 하나라도 실패하면 **Short-Circuit** — Contextual Stage를 건너뛰고 즉시 Evolve의 Structural Fix Flow로 전달해요.

```typescript
interface StructuralResult {
  commands: {
    name: string;       // "lint" | "build" | "test"
    command: string;    // 실행된 명령어
    exitCode: number;
    output: string;
  }[];
  allPassed: boolean;
}
```

### Stage 2: Contextual

LLM이 Spec의 AcceptanceCriteria를 하나씩 검증해요.

```typescript
interface EvaluationResult {
  verifications: {
    acIndex: number;
    satisfied: boolean;
    evidence: string;   // 충족 근거 또는 미충족 이유
    gaps: string[];
  }[];
  overallScore: number;         // 0~1 (AC 충족 비율)
  goalAlignment: number;        // 0~1 (Spec.goal과의 정렬도)
  recommendations: string[];
}
```

---

## 처리 흐름 (Passthrough Mode) — 3-Call 패턴

```
// Call 1: Evaluate 시작
ges_execute({ action: "evaluate", sessionId: "<id>" })
→ structuralContext 반환 (실행할 명령어 목록)

// Call 2: Structural 결과 제출
ges_execute({
  action: "evaluate",
  sessionId: "<id>",
  structuralResult: {
    commands: [
      { name: "lint", command: "pnpm lint", exitCode: 0, output: "..." },
      { name: "build", command: "pnpm build", exitCode: 0, output: "..." },
      { name: "test", command: "pnpm test", exitCode: 0, output: "..." }
    ],
    allPassed: true
  }
})
→ contextualContext 반환 (scoringPrompt, AC 목록)
  또는 allPassed === false 시 → evolveContext 반환 (Short-Circuit)

// Call 3: Contextual 결과 제출
ges_execute({
  action: "evaluate",
  sessionId: "<id>",
  evaluationResult: {
    verifications: [...],
    overallScore: 0.87,
    goalAlignment: 0.82,
    recommendations: [...]
  }
})
→ 최종 평가 결과 반환
```

---

## 성공 판정 기준

```
성공 조건: overallScore ≥ 0.85 AND goalAlignment ≥ 0.80
```

| 조건 | 값 | 환경변수 |
|:---|:---:|:---|
| `overallScore` (AC 충족 비율) | ≥ 0.85 | `GESTALT_EVOLVE_SUCCESS_THRESHOLD` |
| `goalAlignment` (목표 정렬도) | ≥ 0.80 | `GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD` |

두 조건을 모두 충족하면 `status: 'success'` — 다음 단계(Code Review)로 진행해요. 하나라도 미달이면 Evolve 단계로 전달해요.

소스: `src/core/constants.ts`

---

## 왜 이렇게 설계했나요?

### Structural을 먼저 실행하는 이유가 뭔가요?

빌드가 깨진 상태에서 LLM에게 코드를 평가시키는 건 낭비예요. 코드가 컴파일조차 안 된다면 AC 충족 여부를 따지기 전에 먼저 고쳐야 해요. Short-Circuit으로 불필요한 LLM 호출을 줄여요.

### overallScore와 goalAlignment를 따로 측정하는 이유가 뭔가요?

AC를 모두 충족해도 Spec의 핵심 목표와 어긋날 수 있어요. 예를 들어 "로그인 기능 구현"의 모든 AC를 통과했지만 실제 구현이 OAuth 대신 기본 인증을 사용해 보안 요구사항을 만족하지 못하는 경우예요. goalAlignment는 이런 의미적 드리프트를 잡아줘요.

### Structural 실패 시 바로 Evolve로 가는 이유가 뭔가요?

Structural 실패 원인은 명확해요 — 코드 오류, 누락된 의존성, 잘못된 명령어. LLM의 추가 평가 없이 오류 메시지만으로 Fix 컨텍스트를 만들 수 있어요. Contextual을 돌리면 불완전한 결과에 대해 잘못된 신뢰를 줄 수 있어요.

---

## MCP 액션 요약

| 액션 | 설명 |
|:---|:---|
| `evaluate` (Call 1) | Evaluate 시작 → structuralContext 반환 |
| `evaluate` + `structuralResult` (Call 2) | Structural 결과 제출 → contextualContext 또는 Short-Circuit |
| `evaluate` + `evaluationResult` (Call 3) | Contextual 결과 제출 → 최종 판정 |

---

## 소스 코드 참조

| 파일 | 역할 |
|:---|:---|
| `src/execute/passthrough-engine.ts` | Evaluate 3-Call 핸들러 |
| `src/execute/evaluate-context-builder.ts` | structuralContext, contextualContext 생성 |
| `src/execute/session-manager.ts` | EvaluateStage 상태 관리 |
| `src/core/constants.ts` | `EVOLVE_SUCCESS_THRESHOLD`, `EVOLVE_GOAL_ALIGNMENT_THRESHOLD` |
| `src/mcp/tools/execute-passthrough.ts` | MCP 핸들러 |
