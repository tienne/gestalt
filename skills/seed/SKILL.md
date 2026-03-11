---
name: seed
version: "1.0.0"
description: "Generate a Seed specification from a completed interview"
triggers:
  - "generate seed"
  - "create spec"
  - "build seed"
inputs:
  sessionId:
    type: string
    required: true
    description: "The interview session ID to generate a seed from"
  force:
    type: boolean
    required: false
    description: "Force generation even if ambiguity threshold is not met"
outputs:
  - seed
---

# Seed Generation Skill

This skill transforms completed interview data into a structured project specification (Seed).

## Output Structure

- **Goal**: Clear project objective
- **Constraints**: Technical and business constraints
- **Acceptance Criteria**: Measurable success conditions
- **Ontology Schema**: Entity-relationship model
- **Gestalt Analysis**: Findings from each principle applied

## Requirements

- Interview session must be in `completed` status
- Ambiguity score must be ≤ 0.2 (unless `force` is true)

## Passthrough Mode

API 키 없이 MCP 서버 실행 시 자동 활성화. Seed 생성을 caller가 직접 수행한다.

### 추가 Input 파라미터

| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| `seed` | object | 2단계에서 필수 | caller가 생성한 Seed JSON |
| `seed.goal` | string | 필수 | 프로젝트 목표 |
| `seed.constraints` | string[] | 필수 | 기술/비즈니스 제약조건 |
| `seed.acceptanceCriteria` | string[] | 필수 | 수용 기준 |
| `seed.ontologySchema` | object | 필수 | 엔티티-관계 모델 |
| `seed.gestaltAnalysis` | array | 필수 | 게슈탈트 분석 결과 |

### 2단계 플로우

**1단계: SeedContext 요청**
```
ges_generate_seed({ sessionId: "<id>" })
```
→ `{ status: "prompt", seedContext, message }` 반환

SeedContext 필드:
- `systemPrompt`: Seed 생성용 시스템 프롬프트
- `seedPrompt`: 인터뷰 내용 기반 Seed 생성 프롬프트
- `allRounds[]`: `{ roundNumber, question, response, gestaltFocus }`

**2단계: Seed 제출 및 검증**
```
ges_generate_seed({
  sessionId: "<id>",
  seed: {
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
→ `{ status: "generated", seed }` (metadata 자동 생성 포함) 또는 `{ error }` 반환

### Seed 검증 스키마 (Zod)

- `gestaltAnalysis[].principle`: `closure | proximity | similarity | figure_ground | continuity`
- `gestaltAnalysis[].confidence`: 0.0 ~ 1.0
- `ontologySchema.entities[]`: `{ name: string(min 1), description: string, attributes: string[] }`
- `ontologySchema.relations[]`: `{ from: string(min 1), to: string(min 1), type: string(min 1) }`
