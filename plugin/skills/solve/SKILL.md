---
name: solve
version: "1.0.0"
description: "제품 문제를 던지면 인터뷰 → 스펙 → 실행 루프를 자율로 드라이빙한다. 단계별로 멈춰 확인하고 싶으면 이 스킬이 아니다 — 요구사항만 정리하려면 interview, 스펙만 뽑으려면 spec, 이미 스펙이 있으면 execute를 쓴다."
triggers:
  - "solve"
  - "문제 해결"
  - "해결해줘"
  - "루프 돌려줘"
inputs:
  problem:
    type: string
    required: true
    description: "해결할 제품 문제 또는 목표"
outputs:
  - spec
  - executionResult
---

# Solve Skill

제품 문제를 입력받아 **인터뷰 → 스펙 → 실행 루프**를 하나의 흐름으로 자율 드라이빙한다.

> **도구가 없을 때** → [`../_shared/tool-availability.md`](../_shared/tool-availability.md)
> `ges_*` 도구가 없거나 호출이 실패하면 직접 흉내내 진행하지 않고 무엇이 왜 안 되는지 말하고 멈춥니다.

- **인터뷰**: 사람이 직접 답변 (큰 관점 정리 포함, 자동화하지 않음)
- **스펙 생성 이후**: AI가 자율로 드라이빙 — 사람 개입 없이 루프를 돌린다

---

## Phase 0 — 규칙 확보 (인터뷰 시작 전, 한 번만)

세 단계가 각자 규칙 소스를 읽는다. `interview` 0.5단계, `spec`의 규칙 확보, `execute` Phase 0이다. 따로 부르면 그게 맞다 — 스킬 런타임이 다르면 값이 안 넘어간다.

**`solve`는 셋을 한 런타임에서 돈다.** 여기서 한 번 읽어 `ruleContext`로 고정하고 세 Phase가 그 값을 쓴다. 각 Phase의 **레포 밖** 규칙 확보 절은 건너뛴다. `execute`의 0-1 레포 안 탐색은 그대로 한다 — 대상 파일이 정해진 뒤라야 가까운 `CLAUDE.md`를 고를 수 있다.

한 번만 읽는 이유는 비용이 아니라 **일관성**이다. 세 Phase가 각자 읽으면 같은 흐름 안에서 서로 다른 값을 쓸 여지가 생긴다 — 태그가 달라 읽는 소스가 갈리거나, 사이에 서버가 다시 떠서 스냅샷이 바뀌는 경우다. Spec에 굳은 제약과 실행이 따르는 기준은 같아야 한다.

읽는 방법은 [`../_shared/rule-sources.md`](../_shared/rule-sources.md)가 원본이다. **여기에 옮겨 적지 않는다.** `ges_status`(sessionId 없이)에서 읽고 `gestalt.json`을 직접 파싱하지 않는다.

### 멈출 거면 인터뷰 전에 멈춘다

`ruleSourceErrors`가 비어 있지 않거나 `onMissing: "stop"`인 소스를 못 읽었으면 **`ges_interview start`를 부르기 전에** 멈춘다.

사람이 스무 라운드를 답하고 나서 "기준을 못 읽어 Spec을 못 만듭니다"라고 하면 그 시간이 통째로 버려진다. Phase 1만 사람이 참여하는 구조라 더 그렇다. 판정을 맨 앞에 두는 게 이 스킬에서 특히 중요한 이유다.

```
gestalt.json의 ruleSources 선언에 문제가 있어 규칙 소스를 하나도 못 읽었습니다.
  ruleSources.1.kind: Invalid enum value. Expected 'mcp' | 'file' | 'skill', received 'http'
고치고 다시 부르시거나, 기준 없이 진행할지 알려주세요.
```

### 세 Phase가 쓰는 법

| Phase | `ruleContext`로 하는 일 |
|---|---|
| 1 인터뷰 | 이미 정해진 전제를 질문에서 뺀다. 빼면 뺐다고 사람에게 알린다 |
| 2 스펙 | 조직 제약을 `constraints`에 출처와 함께 넣는다 |
| 3 실행 | 만들 때 형식으로 따른다. 레포 안 규칙(`CLAUDE.md` 등)은 이때 따로 읽는다 |

Phase 3의 레포 안 탐색까지 앞당기지는 않는다. 그건 실행 대상 파일이 정해진 뒤라야 "대상에 가까운 `CLAUDE.md`"를 고를 수 있다.

---

## Phase 1 — Interview (사람 참여)

`ges_interview`로 인터뷰를 진행한다. interview 스킬과 동일한 규칙을 따른다. **단 0.5단계 규칙 확보는 Phase 0이 이미 했으므로 다시 하지 않는다.**

### ⚠️ Never Self-Answer

질문을 받으면 **반드시 사람에게 물어보고 답변을 기다린다.** 절대 스스로 답하지 않는다.

### 실행

```json
{ "action": "start", "topic": "{problem}", "cwd": "{현재 작업 디렉토리}" }
```

→ gestaltContext의 questionPrompt로 질문을 생성해 사람에게 제시한다.

사람의 답변을 받으면:

```json
{ "action": "respond", "sessionId": "...", "response": "{사람의 답변}", "generatedQuestion": "{생성한 질문}" }
```

→ resolutionScore.isReady === true 또는 overallScore ≥ 0.8이 될 때까지 반복한다.

완료:

```json
{ "action": "complete", "sessionId": "..." }
```

### 진행 패널

인터뷰 시작 시 `TaskCreate`로 패널 생성:
```
subject: "Solve: {problem 앞 40자}"
description: "Phase 1/3 — 인터뷰 중 | 라운드 1"
activeForm: "인터뷰 진행 중"
```

각 라운드 후 `TaskUpdate`:
```
description: "Phase 1/3 — 인터뷰 중 | 라운드 {N} | 해상도: {score}"
```

완료 시:
```
description: "Phase 1/3 — 인터뷰 완료 | 해상도: {finalScore}"
```

---

## Phase 2 — Spec 생성 (자율)

인터뷰 완료 직후 자동으로 스펙을 생성한다. 사람에게 묻지 않는다.

```json
{ "sessionId": "..." }
```

(`ges_generate_spec` MCP 도구 호출)

→ spec 객체를 받아 다음 단계로 전달한다.

### 진행 패널 업데이트

```
description: "Phase 2/3 — 스펙 생성 중"
activeForm: "스펙 생성 중..."
```

완료 시:
```
description: "Phase 2/3 — 스펙 완료 | AC {N}개"
```

---

## Phase 3 — Execute 루프 (자율)

스펙을 받아 실행 → 평가 → 개선 루프를 자율로 드라이빙한다. **사람 개입 없이 루프를 돈다.**

execute 스킬의 전체 파이프라인(Planning → Execution → Evaluate → Evolve)을 그대로 따른다. 단, 각 단계 사이에서 사람에게 확인을 구하지 않는다.

### 진행 패널 업데이트

Execute 시작 시:
```
description: "Phase 3/3 — 실행 루프 시작"
activeForm: "계획 수립 중..."
```

루프를 돌 때마다:
```
description: "Phase 3/3 — Generation {N} | 점수: {score}"
activeForm: "{현재 단계: 실행 중 / 평가 중 / 개선 중}"
```

### 종료 조건

| 조건 | 대응 |
|------|------|
| `success` (score ≥ 0.85, goalAlignment ≥ 0.80) | 루프 종료 → 완료 보고 |
| `human_escalation` (lateral 4개 소진) | 루프 종료 → 막힌 지점과 시도한 접근법 보고 |
| `caller` (사용자가 명시적으로 중단) | 즉시 종료 |

### 완료 보고

루프 종료 시 사람에게 결과를 보고한다:

**성공 시:**
- 달성한 AC 목록
- 최종 점수 (overallScore, goalAlignment)
- 생성된 아티팩트 목록

**에스컬레이션 시:**
- 막힌 지점
- 시도한 Lateral Persona 목록
- 현재까지의 최고 점수
- 사람이 힌트를 줄 수 있는 포인트 제시

### 진행 패널 최종 업데이트

```
status: "completed"
description: "완료 | score: {overallScore} | alignment: {goalAlignment} | generation: {N}"
```

에스컬레이션 시:
```
status: "completed"
description: "에스컬레이션 | 최고 점수: {bestScore} | {시도한 persona 목록}"
```

---

## 전체 흐름 요약

```
/solve "제품 문제"
    ↓
[Phase 0] 규칙 확보 — 한 번만, 멈출 거면 여기서
    ↓ 자동
[Phase 1] 인터뷰 — 사람이 답변, 해상도 ≥ 0.8까지
    ↓ 자동
[Phase 2] 스펙 생성 — AI 자율
    ↓ 자동
[Phase 3] 실행 루프 — AI 자율
  execute → evaluate → evolve → re-execute → evaluate → ...
    ↓
  success → 완료 보고
  human_escalation → 막힌 지점 보고
```

인터뷰에서 사람과 큰 관점을 충분히 정리한 뒤, 그 이후는 AI가 목표를 향해 스스로 루프를 돈다.
