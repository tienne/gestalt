# 1단계: Interview — 모호함을 수치로 만들다

> AI에게 "사용자 인증 시스템 만들어줘"라고 하면, AI는 당신이 원하는 게 JWT인지 세션인지, OAuth를 지원해야 하는지, 비밀번호 찾기는 있는지 모른다. Interview 단계는 이 모호함을 구조화된 질문으로 수치화한다.

---

## 무엇을 하는가

하나의 토픽(topic)으로 시작해 여러 라운드의 Q&A를 거쳐 **모호성 점수(Ambiguity Score)가 0.2 이하**가 될 때까지 질문을 이어간다. 각 라운드에서 어떤 원리로 어떤 질문을 해야 하는지를 게슈탈트 5원리가 동적으로 결정한다.

---

## 게슈탈트 원리 적용

인터뷰는 라운드 단계에 따라 적용 원리가 달라진다.

### 라운드별 기본 원리

| 라운드 | 페이즈 | 원리 | 목적 |
|:---:|:---:|:---:|:---|
| 1–3 | early | **폐쇄성** | 목표를 완전하게 정의 — 말하지 않은 부분 채우기 |
| 4 | mid | **근접성** | 관련 요구사항 그룹핑 |
| 5 | mid | **유사성** | 반복 패턴·공통 모듈 발견 |
| 6 | mid | **근접성** | 구조화 심화 |
| 7 | mid | **유사성** | 패턴 심화 |
| 8 | mid | **근접성** | 구조화 마무리 |
| 9+ | late | **전경과 배경** | MVP 범위·우선순위 결정 |
| 언제든 | — | **연속성** | 모순 감지 시 즉시 override |

### 동적 원리 선택 알고리즘 (`selectNextPrinciple`)

단순히 라운드 번호만 보지 않는다. **가중 영향도**를 계산해서 가장 취약한 차원을 먼저 공략한다.

```
1. 연속성 Override
   hasContradictions === true → 무조건 연속성 (모순 해결 우선)

2. Weakest Dimension
   impact = (1 - clarity) × weight
   clarity < 0.5인 차원 중 impact가 가장 큰 원리 선택

3. Phase Default
   위 두 조건에 해당 없으면 라운드 번호 기반 기본값
```

소스: `src/gestalt/principles.ts`

---

## 모호성 점수 (Ambiguity Score)

각 라운드 응답 후 LLM이 4개(Brownfield는 5개) 차원을 0~1로 평가한다.

### 차원별 원리 매핑

| 차원 | 매핑 원리 | Greenfield 가중치 | Brownfield 가중치 |
|:---|:---:|:---:|:---:|
| goalClarity | 폐쇄성 | 0.40 | 0.30 |
| constraintClarity | 근접성 | 0.25 | 0.20 |
| successCriteria | 유사성 | 0.20 | 0.15 |
| priorityClarity | 전경과 배경 | 0.15 | 0.15 |
| contextClarity | 연속성 | — | 0.20 |

### 점수 계산 공식

```
overall = 1.0 - Σ(clarity_i × weight_i) + continuityPenalty
```

- `overall ≤ 0.2` → `isReady = true` → 인터뷰 종료 가능
- `overall > 0.2` → 다음 라운드 계속

### Continuity 페널티

모순이 감지되면 overall에 페널티가 추가된다. 모순을 해소하지 않으면 점수가 임계값 아래로 내려가기 어렵다.

```
penalty = 0.05 + 0.10 × min(contradictions / 3, 1)

모순 0개 → 0
모순 1개 → ≈ 0.083
모순 3개+ → 0.15 (최대)
```

소스: `src/gestalt/analyzer.ts`, `src/interview/ambiguity.ts`

---

## 처리 흐름 (Passthrough Mode)

Passthrough 모드에서는 서버가 LLM을 직접 호출하지 않는다. 질문 생성과 점수 계산을 caller(Claude Code 등)가 담당한다.

```
1. ges_interview({ action: "start", topic: "..." })
   → gestaltContext 반환 (systemPrompt, questionPrompt, currentPrinciple)

2. caller가 systemPrompt + questionPrompt로 질문 생성

3. ges_interview({ action: "respond", generatedQuestion: "...", response: "...", ambiguityScore?: {...} })
   → 다음 gestaltContext + 현재 ambiguityScore 반환
   → isReady === true가 될 때까지 반복

4. ges_interview({ action: "complete", sessionId: "..." })
   → 세션 완료 처리
```

> `generatedQuestion`은 respond 시 **필수**다. 서버가 질문 히스토리를 기록하기 위해 필요하다.

---

## 설계 결정

**왜 라운드별 원리를 고정하지 않는가?**
가중 영향도(`(1 - clarity) × weight`)가 더 취약한 차원을 동적으로 공략한다. 예를 들어 라운드 6이어도 goalClarity가 아직 0.3이면 근접성 대신 폐쇄성을 우선한다. 라운드 기반 기본값은 어떤 차원이 취약한지 정보가 없을 때의 fallback이다.

**왜 모순을 최우선으로 처리하는가?**
모순이 있는 상태로 스펙을 생성하면 실행 단계에서 충돌이 발생한다. Continuity 페널티가 전체 점수를 높게 유지해 인터뷰가 강제로 계속되도록 설계했다.

**Brownfield vs Greenfield 가중치 차이?**
새 프로젝트(Greenfield)는 목표와 범위를 명확히 하는 게 최우선이라 폐쇄성(0.40)이 높다. 기존 시스템(Brownfield)은 기존 코드와의 일관성(연속성, 0.20)이 추가로 중요하다.

---

## MCP 액션 요약

| 액션 | 필수 파라미터 | 반환 |
|:---|:---|:---|
| `start` | topic, cwd? | sessionId, gestaltContext |
| `respond` | sessionId, generatedQuestion, response | gestaltContext, ambiguityScore |
| `score` | sessionId, ambiguityScore? | scoringPrompt 또는 점수 반영 |
| `complete` | sessionId | 완료 상태 |

---

## 소스 코드 참조

| 파일 | 역할 |
|:---|:---|
| `src/gestalt/principles.ts` | `selectNextPrinciple()`, `findWeakestDimension()` |
| `src/gestalt/analyzer.ts` | `computeAmbiguityScore()`, `computeContinuityPenalty()` |
| `src/interview/ambiguity.ts` | `AmbiguityScorer` — LLM 호출 및 점수 파싱 |
| `src/interview/passthrough-engine.ts` | Passthrough 모드 Interview 핸들러 |
| `src/interview/session.ts` | 세션 상태 관리 |
| `src/core/constants.ts` | 가중치, 페널티, 임계값 상수 |
