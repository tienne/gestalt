---
name: interview
version: "1.0.0"
description: "Gestalt-driven interview to clarify project requirements"
triggers:
  - "interview"
  - "clarify requirements"
  - "start interview"
inputs:
  topic:
    type: string
    required: true
    description: "The topic or feature to interview about"
  cwd:
    type: string
    required: false
    description: "Working directory for brownfield detection"
outputs:
  - session
  - ambiguityScore
---

# Interview Skill

This skill conducts a Gestalt psychology-driven interview to transform vague requirements into clear specifications.

## Process

1. **Start**: Create a session, detect project type (greenfield/brownfield), ask the first question
2. **Iterate**: Ask questions guided by Gestalt principles (Closure → Proximity → Similarity → Figure-Ground)
3. **Score**: Continuously assess ambiguity across multiple dimensions
4. **Complete**: When ambiguity score ≤ 0.2, the interview is ready for seed generation

## Gestalt Principles Applied

- **Closure**: Fill missing requirements
- **Proximity**: Group related features
- **Similarity**: Identify patterns
- **Figure-Ground**: Separate MVP from nice-to-have
- **Continuity**: Detect contradictions

## Passthrough Mode

API 키 없이 MCP 서버 실행 시 자동 활성화. LLM 작업을 caller가 직접 수행한다.

### 추가 Input 파라미터

| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| `generatedQuestion` | string | respond 시 필수 | caller가 생성한 질문 텍스트 |
| `ambiguityScore` | object | 선택 | caller가 산출한 모호성 점수 |
| `ambiguityScore.goalClarity` | number (0-1) | 필수* | 목표 명확도 |
| `ambiguityScore.constraintClarity` | number (0-1) | 필수* | 제약조건 명확도 |
| `ambiguityScore.successCriteria` | number (0-1) | 필수* | 성공 기준 명확도 |
| `ambiguityScore.priorityClarity` | number (0-1) | 필수* | 우선순위 명확도 |
| `ambiguityScore.contextClarity` | number (0-1) | 선택 | 컨텍스트 명확도 |
| `ambiguityScore.contradictions` | string[] | 선택 | 발견된 모순 목록 |

\* ambiguityScore 객체를 제공할 경우 필수

### Action별 응답 구조 (Passthrough)

**`start`** → `{ status, sessionId, projectType, detectedFiles, gestaltContext, roundNumber, message }`

**`respond`** → `{ status, sessionId, roundNumber, gestaltContext, ambiguityScore, message }`

**`score`** (점수 미제공 시) → `{ status, ambiguityScore, scoringPrompt, message }`
**`score`** (점수 제공 시) → `{ status, ambiguityScore }`

**`complete`** → `{ status, sessionId, totalRounds, finalAmbiguityScore, message }`

### GestaltContext 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `systemPrompt` | string | 인터뷰어 시스템 프롬프트 |
| `currentPrinciple` | GestaltPrinciple | 현재 적용 중인 게슈탈트 원리 |
| `principleStrategy` | string | 해당 원리의 질문 전략 설명 |
| `phase` | string | 현재 인터뷰 단계 라벨 |
| `questionPrompt` | string | 다음 질문 생성용 프롬프트 |
| `scoringPrompt` | string? | 모호성 점수 산출용 프롬프트 (respond 후에만 포함) |
| `roundNumber` | number | 현재 라운드 번호 |
