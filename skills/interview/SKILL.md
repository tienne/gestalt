---
name: interview
version: "1.2.0"
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
  - resolutionScore
---

# Interview Skill

This skill conducts a Gestalt psychology-driven interview to transform vague requirements into clear specifications.

## 0단계: 인텐트 라우팅 (인터뷰 시작 전)

인터뷰를 시작하기 전에 topic이 인터뷰 파이프라인에 적합한지 먼저 확인한다.

### PR 관련 키워드 감지
topic에 아래 키워드가 포함되면 `/pr` 스킬이 더 적합하다:
`PR`, `풀리퀘`, `풀 리퀘스트`, `pull request`, `PR 작성`, `PR 만들어`, `PR 써줘`, `PR 올려`

→ `ges_interview start`를 실행하지 않고 사용자에게 안내:
> "이 요청은 `/pr` 스킬이 더 적합합니다. PR 작성 전용 파이프라인(레포 규칙 탐색 → 미니 인터뷰 → diff 분석 → description 생성)으로 진행할까요?"
> 확인 시 `/pr` 스킬 즉시 실행.

### 코드 리뷰 관련 키워드 감지
topic에 아래 키워드가 포함되면 `/review` 스킬이 더 적합하다:
`코드리뷰`, `code review`, `리뷰해줘`, `리뷰 부탁`, `리뷰 요청`, `review`, `리뷰`

→ `ges_interview start`를 실행하지 않고 사용자에게 안내:
> "이 요청은 `/review` 스킬이 더 적합합니다. 코드 리뷰 전용 파이프라인(미니 인터뷰 → 기획 컨텍스트 분석 → 전문 리뷰어 검토)으로 진행할까요?"
> 확인 시 `/review` 스킬 즉시 실행.

### 라우팅 대상이 아닌 경우
위 키워드가 없으면 기존 인터뷰 파이프라인을 정상 진행한다.

## ⚠️ Critical Rule: Never Self-Answer

**You are the interviewer, not the interviewee.**

When Gestalt returns a question to ask, you MUST:
1. Present the question **to the human user** exactly as generated
2. **Wait** for the human's response
3. Submit the human's response back to Gestalt via `ges_interview respond`

You must **NEVER**:
- Answer the question yourself (even if you know a good answer)
- Make assumptions about what the user might want
- Skip asking and proceed with a hypothetical answer
- Suggest an answer while asking ("Would you like JWT? Most people use JWT")

The interview only has value if the human's actual intent is captured. A self-answered interview produces a Spec that reflects your assumptions, not the user's requirements.

## Process

1. **Start**: Create a session, detect project type (greenfield/brownfield), ask the first question
2. **Iterate**: Present each generated question to the user → wait for answer → submit answer to Gestalt
3. **Score**: Continuously assess resolution across multiple dimensions
4. **Complete**: When resolution score ≥ 0.8, the interview is ready for spec generation

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
| `resolutionScore` | object | 선택 | caller가 산출한 해상도 점수 |
| `resolutionScore.goalClarity` | number (0-1) | 필수* | 목표 명확도 |
| `resolutionScore.constraintClarity` | number (0-1) | 필수* | 제약조건 명확도 |
| `resolutionScore.successCriteria` | number (0-1) | 필수* | 성공 기준 명확도 |
| `resolutionScore.priorityClarity` | number (0-1) | 필수* | 우선순위 명확도 |
| `resolutionScore.contextClarity` | number (0-1) | 선택 | 컨텍스트 명확도 |
| `resolutionScore.contradictions` | string[] | 선택 | 발견된 모순 목록 |

\* resolutionScore 객체를 제공할 경우 필수

### Action별 응답 구조 (Passthrough)

**`start`** → `{ status, sessionId, projectType, detectedFiles, gestaltContext, roundNumber, message }`

**`respond`** → `{ status, sessionId, roundNumber, gestaltContext, resolutionScore, message }`

**`score`** (점수 미제공 시) → `{ status, resolutionScore, scoringPrompt, message }`
**`score`** (점수 제공 시) → `{ status, resolutionScore }`

**`complete`** → `{ status, sessionId, totalRounds, finalResolutionScore, message }`

### GestaltContext 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `systemPrompt` | string | 인터뷰어 시스템 프롬프트 |
| `currentPrinciple` | GestaltPrinciple | 현재 적용 중인 게슈탈트 원리 |
| `principleStrategy` | string | 해당 원리의 질문 전략 설명 |
| `phase` | string | 현재 인터뷰 단계 라벨 |
| `questionPrompt` | string | 다음 질문 생성용 프롬프트 |
| `scoringPrompt` | string? | 해상도 점수 산출용 프롬프트 (respond 후에만 포함) |
| `roundNumber` | number | 현재 라운드 번호 |

---

## 공통 진행 패널

인터뷰 진행 중 Claude Code Task 패널에 실시간 상태를 표시한다. 패널 업데이트는 best-effort — 업데이트 실패가 인터뷰 흐름을 중단시켜서는 안 된다.

### 시작 시 (`start` 응답 수신 직후)

`TaskCreate`를 호출해 진행 패널을 생성하고, 반환된 taskId를 세션 동안 보관한다.

```
subject: "Gestalt 인터뷰: {topic}"
description: "라운드 1/{maxRounds} | 해상도: 측정 전"
activeForm: "라운드 1 — {currentPrinciple}"
```

### 각 라운드 후 (`respond` 응답 수신 시마다)

`TaskUpdate`로 description과 activeForm을 최신 상태로 갱신한다. 해상도는 추이 형식으로 표시한다.

```
description: "라운드 {roundNumber}/{maxRounds} | 해상도: {score1} → {score2} → {latestScore}"
activeForm: "라운드 {roundNumber} — {currentPrinciple}"
```

resolutionScore.isReady === true 이면 description에 "✓ 준비 완료" 표시를 추가한다.

### 완료 시 (`complete` 응답 수신 후)

`TaskUpdate`로 status를 completed로 변경한다.

```
status: "completed"
description: "총 {totalRounds}라운드 완료 | 최종 해상도: {finalResolutionScore}"
```
