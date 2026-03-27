# 6단계: Code Review — 다중 관점으로 코드를 검증해요

Evolve가 "성공"을 선언해도 끝이 아니에요. 점수는 통과했지만 실제 코드에 잠재적인 보안 취약점이나 성능 문제가 숨어 있을 수 있거든요. Code Review 단계에서는 여러 Role Agent가 각자의 전문 도메인 관점으로 코드를 검토하고, 합의를 통해 최종 품질을 보장해요.

---

## Code Review는 어떤 역할을 하나요?

Evaluate 성공 후 자동으로 진입하는 최종 검증 단계예요.

여러 Agent가 동시에 코드를 리뷰하고, Consensus 과정에서 이슈를 취합해요. Critical 또는 High 이슈가 발견되면 자동으로 Fix를 시도해요. 최대 3회까지 재시도할 수 있어요.

---

## 게슈탈트 원리는 어떻게 적용되나요?

Code Review는 **유사성(Similarity)** 원리가 주도해요.

각 Role Agent는 동일한 코드를 보지만, 자신의 도메인 렌즈(보안, 성능, 접근성 등)로 서로 다른 패턴을 인식해요. Consensus 단계에서 여러 관점의 공통 이슈를 통합하고, 충돌하는 의견을 해결해요.

---

## 4-Action 패턴

### review_start

Execute 세션에서 변경된 파일과 의존성 파일을 수집해 리뷰 컨텍스트를 구성해요.

```
ges_execute({ action: "review_start", sessionId: "<executeSessionId>" })
→ reviewSessionId + reviewStartContext 반환
  - systemPrompt: 리뷰어 역할 정의
  - reviewPrompt: 변경 파일 목록, Spec goal, constraints 포함
  - matchContext: 추천 Agent 목록
  - reviewContext: changedFiles, dependencyFiles
```

### review_submit

각 Agent가 독립적으로 리뷰 결과를 제출해요. 여러 Agent가 같은 세션에 순차적으로 제출할 수 있어요.

```
ges_execute({
  action: "review_submit",
  sessionId: "<reviewSessionId>",
  agentName: "security-expert",
  result: {
    issues: [
      {
        id: "sec-001",
        severity: "critical",
        category: "authentication",
        file: "src/auth.ts",
        line: 42,
        message: "JWT 토큰 만료 시간 미설정",
        suggestion: "jwt.sign()에 expiresIn 옵션 추가"
      }
    ],
    approved: false,
    summary: "인증 토큰 보안 설정 누락"
  }
})
→ { submittedCount, expectedCount }
```

### review_consensus

모든 Agent의 리뷰가 완료되면, Caller가 이슈를 취합하고 중복을 제거해 최종 합의를 제출해요.

```
ges_execute({
  action: "review_consensus",
  sessionId: "<reviewSessionId>",
  consensus: {
    mergedIssues: [
      {
        id: "sec-001",
        severity: "critical",
        ...
        reportedBy: "security-expert"
      }
    ],
    approvedBy: [],
    blockedBy: ["security-expert"],
    summary: "critical 이슈 1건 발견"
  }
})
→ { approved, report, needsFix, canFix, criticalHighCount }
```

- `approved === true` (critical/high 이슈 0건) → Review 통과, 파이프라인 완료
- `approved === false` → review_fix 진행

### review_fix

Critical/High 이슈만 선별해 Fix 컨텍스트를 제공해요.

```
ges_execute({ action: "review_fix", sessionId: "<reviewSessionId>" })
→ fixContext 반환 (systemPrompt, fixPrompt, issues 목록, attempt/maxAttempts)
  또는 attempt > maxAttempts 시 → { report, exhausted: true }
```

Fix가 완료되면 자동으로 Re-review 상태로 전환돼요. review_start부터 다시 반복해요.

---

## Severity는 어떻게 분류되나요?

| Severity | 의미 | 리뷰 통과 여부 |
|:---|:---|:---:|
| `critical` | 보안 취약점, 데이터 손실 위험, 런타임 크래시 | 차단 |
| `high` | 성능 심각 저하, 잘못된 비즈니스 로직 | 차단 |
| `warning` | 스타일, 개선 권장, 마이너 이슈 | 통과 (리포트만) |

`approved = criticalHighIssues.length === 0`

---

## 최대 3회 재시도 규칙

```
currentAttempt ≤ maxAttempts(3) → Fix 가능
currentAttempt > maxAttempts(3) → exhausted: true, 최종 Report 반환
```

3회를 모두 소진하면 `status: 'failed_with_report'`로 세션이 종료돼요. 최종 ReviewReport에 잔여 이슈가 모두 기록돼요.

---

## 전체 처리 흐름

```
review_start
     ↓
review_submit (Agent 1)
review_submit (Agent 2)
...
review_submit (Agent N)
     ↓
review_consensus
     ↓
  approved?
  ├─ YES → 완료
  └─ NO  → review_fix
              ↓
           Re-review (review_start부터 반복)
              ↓
           최대 3회 → exhausted → 최종 Report
```

---

## ReviewReport 구조

각 시도마다 Report가 생성되고 세션에 누적돼요.

```typescript
interface ReviewReport {
  attempt: number;
  totalIssues: number;
  criticalCount: number;
  highCount: number;
  warningCount: number;
  issues: ReviewIssue[];
  approved: boolean;
  summary: string;
  generatedAt: string;
}
```

---

## 설계 결정 Q&A

### Evaluate를 통과했는데 왜 Code Review를 또 하나요?

Evaluate의 Contextual Stage는 LLM이 AC 충족 여부를 평가해요. 그런데 LLM은 코드의 보안 취약점이나 성능 문제를 AC 검증 과정에서 놓칠 수 있어요. Code Review는 Evaluate가 통과시킨 코드를 도메인 전문 Agent가 다시 한번 검증하는 안전망이에요.

### 왜 warning 이슈는 차단하지 않나요?

Warning은 "있으면 좋지만 없어도 동작한다"는 의미예요. 이를 차단하면 스타일 이슈 때문에 배포가 막히는 상황이 생겨요. Warning은 리포트에 기록해 인지할 수 있게 하되, 최종 결정은 사람에게 맡겨요.

### 왜 Fix 후 부분 재검토가 아닌 전체 Re-review를 하나요?

Fix가 하나의 이슈를 고치면서 다른 이슈를 만들어낼 수 있어요. 부분 재검토는 이런 regression을 놓쳐요. Agent 수가 많지 않다면 비용 차이도 크지 않고, 전체 Re-review가 더 안전해요.

### 왜 최대 3회인가요?

2회는 너무 적어요. 첫 번째 Fix가 새 이슈를 만들면 두 번째 시도가 유일한 기회가 되거든요. 4회 이상은 수렴하지 않는 코드를 계속 수정하는 낭비예요. 3회가 "합리적인 노력"과 "무한 루프 방지" 사이의 균형점이에요.

---

## MCP 액션 요약

| 액션 | 설명 |
|:---|:---|
| `review_start` | 리뷰 세션 시작, 컨텍스트 반환 |
| `review_submit` | Agent별 리뷰 결과 제출 |
| `review_consensus` | 합의된 이슈 목록 제출 → 통과/Fix 판정 |
| `review_fix` | Fix 컨텍스트 요청 → Fix 후 Re-review |

---

## 소스 코드 참조

| 파일 | 역할 |
|:---|:---|
| `src/review/passthrough-engine.ts` | `PassthroughReviewEngine` — 4-Action 전체 |
| `src/review/context-collector.ts` | 변경 파일 + 의존성 파일 수집 |
| `src/review/agent-matcher.ts` | 리뷰 Agent 매칭 컨텍스트 생성 |
| `src/review/report-generator.ts` | ReviewReport 생성 |
| `src/mcp/tools/review-passthrough.ts` | MCP 핸들러 |
| `src/core/types.ts` | `ReviewSession`, `ReviewResult`, `ReviewIssue`, `ReviewReport` |
