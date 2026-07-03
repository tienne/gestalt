---
name: spec
version: "1.2.0"
description: "Generate a Spec specification from a completed interview"
triggers:
  - "generate spec"
  - "create spec"
  - "build spec"
inputs:
  sessionId:
    type: string
    required: true
    description: "The interview session ID to generate a spec from"
  force:
    type: boolean
    required: false
    description: "Force generation even if resolution threshold is not met"
outputs:
  - spec
---

# Spec Generation Skill

This skill transforms completed interview data into a structured project specification (Spec).

## Output Structure

- **Goal**: Clear project objective
- **Constraints**: Technical and business constraints
- **Acceptance Criteria**: Measurable success conditions
- **Ontology Schema**: Entity-relationship model
- **Gestalt Analysis**: Findings from each principle applied

## Requirements

- Interview session must be in `completed` status
- Resolution score must be ≥ 0.8 (unless `force` is true)

## Passthrough Mode

API 키 없이 MCP 서버 실행 시 자동 활성화. Spec 생성을 caller가 직접 수행한다.

### 추가 Input 파라미터

| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| `spec` | object | 2단계에서 필수 | caller가 생성한 Spec JSON |
| `spec.goal` | string | 필수 | 프로젝트 목표 |
| `spec.constraints` | string[] | 필수 | 기술/비즈니스 제약조건 |
| `spec.acceptanceCriteria` | string[] | 필수 | 수용 기준 |
| `spec.ontologySchema` | object | 필수 | 엔티티-관계 모델 |
| `spec.gestaltAnalysis` | array | 필수 | 게슈탈트 분석 결과 |

### 2단계 플로우

**1단계: SpecContext 요청**
```
ges_generate_spec({ sessionId: "<id>" })
```
→ `{ status: "prompt", specContext, message }` 반환

SpecContext 필드:
- `systemPrompt`: Spec 생성용 시스템 프롬프트
- `specPrompt`: 인터뷰 내용 기반 Spec 생성 프롬프트
- `allRounds[]`: `{ roundNumber, question, response, gestaltFocus }`

**2단계: Spec 제출 및 검증**
```
ges_generate_spec({
  sessionId: "<id>",
  spec: {
    goal: "명확한 프로젝트 목표",
    constraints: ["TypeScript 사용", "REST API"],
    acceptanceCriteria: ["응답 시간 200ms 이하"],
    ontologySchema: {
      entities: [{ name: "User", description: "...", attributes: ["id", "email"] }],
      relations: [{ from: "User", to: "Order", type: "has_many" }]
    },
    gestaltAnalysis: [
      { principle: "closure", finding: "인증 요구사항 완전히 파악됨", confidence: 0.9 }
    ]
  }
})
```
→ `{ status: "generated", spec }` (metadata 자동 생성 포함) 또는 `{ error }` 반환

### Reasoning Model 서브에이전트로 Spec 추론

Spec 생성은 인터뷰 조각들을 하나의 완전한 구조로 결정화하는 깊은 one-shot 추론이라, 게슈탈트에서 상위 추론 모델이 진짜 값을 하는 지점이다. 1단계 SpecContext를 받은 뒤 2단계 Spec JSON을 만드는 추론은 현재 세션이 직접 하지 말고 별도 Agent 서브에이전트로 스폰한다.

**추론 모델 값 읽기.** `gestalt.json`을 직접 파싱하지 말고 `ges_status`(sessionId 없이 호출)의 응답에서 `reasoningModel`과 `reasoningModelFallback`을 읽는다. 서버가 config를 resolve해 노출하는 값이다.

```
ges_status()  →  { reasoningModel: "fable", reasoningModelFallback: "opus", ... }
```

**스폰.** Agent 도구로 서브에이전트를 띄우되 `model` 파라미터에 `reasoningModel` 값을 넘긴다. 서브에이전트에는 1단계에서 받은 `systemPrompt`, `specPrompt`, `allRounds[]`를 그대로 전달하고, 위 Spec 검증 스키마에 맞는 Spec JSON을 산출하게 한다. 서브에이전트 결과를 2단계 `ges_generate_spec({ sessionId, spec })`로 제출한다.

**폴백은 스킬 런타임에서 발동한다.** 서버는 폴백 대상(`reasoningModelFallback`)만 알려줄 뿐, 모델 가용성을 감지하거나 재시도하지 않는다. Agent 도구가 `reasoningModel`(예: `fable`)을 지원하지 않아 스폰이 거부/실패하면, 그때 스킬이 직접 `model`을 `reasoningModelFallback`(예: `opus`)로 바꿔 1회 재시도한다. 폴백 판단과 재시도는 전적으로 이 스킬 런타임의 책임이다.

### Spec 검증 스키마 (Zod)

- `gestaltAnalysis[].principle`: `closure | proximity | similarity | figure_ground | continuity`
- `gestaltAnalysis[].confidence`: 0.0 ~ 1.0
- `ontologySchema.entities[]`: `{ name: string(min 1), description: string, attributes: string[] }`
- `ontologySchema.relations[]`: `{ from: string(min 1), to: string(min 1), type: string(min 1) }`

---

## 공통 진행 패널

Spec 생성 중 Claude Code Task 패널에 상태를 표시한다. best-effort — 패널 실패가 Spec 생성을 막아서는 안 된다.

### 시작 시 (1단계 `ges_generate_spec` 호출 전)

`TaskCreate`로 패널을 생성한다.

```
subject: "Spec 생성 중"
description: "인터뷰 세션 {sessionId} 기반 Spec 구성 중..."
activeForm: "1/2 — 컨텍스트 요청 중"
```

1단계 응답(`status: "prompt"`) 수신 후 `TaskUpdate`로 갱신한다.

```
activeForm: "2/2 — Spec 검증 중"
```

### 완료 시 (2단계 `ges_generate_spec` 응답 수신 후)

`TaskUpdate`로 status를 completed로 변경한다.

```
status: "completed"
description: "Spec 생성 완료 | specId: {spec.metadata.specId}"
```

실패 시(error 반환):

```
status: "completed"
description: "Spec 생성 실패: {error}"
```
