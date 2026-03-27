# 2단계: Spec — 흩어진 답변을 하나의 구조로

> 인터뷰가 끝나면 수십 개의 Q&A 라운드가 남는다. Spec 단계는 이 원시 데이터를 AI가 실행할 수 있는 정형화된 스키마로 결정화(crystallize)한다.

---

## 무엇을 하는가

완료된 인터뷰 세션에서 **Spec JSON**을 생성한다. Spec은 Execute 단계의 입력이 되며, Evaluate·Evolve 전 과정에서 기준점(ground truth)으로 사용된다.

---

## 게슈탈트 원리 적용

Spec 생성은 **유사성(Similarity)** 원리가 주도한다.

인터뷰 라운드들을 읽고 반복되는 패턴을 찾아 일관된 구조로 결정화한다. 도메인은 달라도 같은 패턴(예: "관리자만 가능")은 하나의 constraint로 통합한다. 인터뷰 전반을 읽고 게슈탈트 분석(gestaltAnalysis)에 각 원리별 발견 사항과 신뢰도를 기록한다.

---

## Spec 스키마

```typescript
interface Spec {
  goal: string;                        // 핵심 목표 (단일 문장)
  constraints: string[];               // 기술적·비즈니스 제약조건
  acceptanceCriteria: string[];        // 완료 기준 (검증 가능한 항목)
  ontologySchema: {
    entities: {                        // 도메인 주요 개체
      name: string;
      description: string;
      attributes: string[];
    }[];
    relations: {                       // 개체 간 관계
      from: string;
      to: string;
      type: string;
    }[];
  };
  gestaltAnalysis: {                   // 원리별 발견사항
    principle: 'closure' | 'proximity' | 'similarity' | 'figure_ground' | 'continuity';
    finding: string;
    confidence: number;               // 0~1
  }[];
  metadata: {
    specId: string;
    interviewSessionId: string;
    ambiguityScore: number;
    generatedAt: string;
  };
}
```

소스: `src/spec/schema.ts`

---

## 처리 흐름 (Passthrough Mode)

Passthrough 모드는 2-Call 패턴으로 동작한다.

```
// Call 1: Spec 생성 컨텍스트 요청
ges_generate_spec({ sessionId: "<id>" })
→ specContext 반환 (systemPrompt, specPrompt, allRounds)

// Call 2: caller가 Spec JSON 생성 후 제출
ges_generate_spec({
  sessionId: "<id>",
  spec: {
    goal: "...",
    constraints: ["..."],
    acceptanceCriteria: ["..."],
    ontologySchema: { entities: [...], relations: [...] },
    gestaltAnalysis: [{ principle: "closure", finding: "...", confidence: 0.9 }]
  }
})
→ Zod 검증 후 최종 Spec 반환
```

---

## 설계 결정

**왜 2단계 호출인가?**
Passthrough 모드에서 서버는 LLM을 직접 호출하지 않는다. Call 1에서 컨텍스트(인터뷰 전체 내용, 시스템 프롬프트)를 caller에게 전달하고, caller가 Spec JSON을 만들어 Call 2에서 제출한다. 서버는 Zod 스키마로 검증만 담당한다.

**왜 `goal`을 단일 문장으로 제한하는가?**
goal은 Evolve 단계에서 변경이 금지되는 L4 계층이다. 명확하고 단일한 목표가 있어야 실행과 평가 전 과정의 일관성을 보장할 수 있다. 모호한 목표는 드리프트 감지에서 오탐을 낳는다.

**왜 ontologySchema를 포함하는가?**
Execute 단계에서 태스크가 올바른 도메인 개념을 다루는지 확인하는 기준이 된다. Drift Detection의 Ontology Drift 측정에 사용되며, Evolve 단계에서 L3(ontology) 패치를 적용할 때도 현재 ontology를 기준점으로 삼는다.

**실패 시 재시도 정책**
Spec 생성 실패(JSON 파싱 오류, Zod 검증 실패) 시 최대 3회 재시도한다. 3회 모두 실패하면 `SpecGenerationError`를 반환한다.

**`force` 파라미터**
모호성 점수가 0.2를 초과해도 `force: true`를 전달하면 강제로 Spec을 생성한다. 인터뷰를 충분히 진행했으나 점수가 임계값을 간신히 못 넘는 경우에 사용한다.

---

## MCP 액션 요약

| 액션 | 설명 |
|:---|:---|
| `ges_generate_spec({ sessionId })` | Call 1: specContext 반환 |
| `ges_generate_spec({ sessionId, spec })` | Call 2: Spec 검증·저장 후 최종 Spec 반환 |
| `ges_generate_spec({ sessionId, force: true })` | 모호성 점수 미달이어도 강제 생성 |

---

## 소스 코드 참조

| 파일 | 역할 |
|:---|:---|
| `src/spec/schema.ts` | Zod 스키마 정의 |
| `src/spec/passthrough-generator.ts` | `PassthroughSpecGenerator` — 2-Call 패턴 |
| `src/spec/generator.ts` | Normal 모드 Spec 생성 (자체 LLM 호출) |
| `src/spec/extractor.ts` | LLM 응답에서 JSON 추출 + 파싱 |
| `src/mcp/tools/spec-passthrough.ts` | MCP 핸들러 |
