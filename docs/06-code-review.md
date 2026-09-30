# 6단계: Code Review

이 단계를 마치면 여러 Role Agent가 각자의 전문 도메인 관점으로 코드를 검토하고, Critical/High 이슈가 없는 상태로 파이프라인을 완료할 수 있어요.

Evaluate 성공 후 자동으로 진입하는 최종 검증 단계예요. 여러 Agent가 독립적으로 코드를 리뷰하고, Consensus 과정에서 이슈를 취합해요. Critical 또는 High 이슈가 발견되면 자동으로 Fix를 시도해요. 최대 3회까지 재시도할 수 있어요.

---

## 게슈탈트 원리 적용

Code Review는 **유사성(Similarity)** 원리가 주도해요.

각 Role Agent는 동일한 코드를 보지만, 자신의 도메인 렌즈(보안, 성능, 접근성 등)로 서로 다른 패턴을 인식해요. Consensus 단계에서 여러 관점의 공통 이슈를 통합하고, 충돌하는 의견을 해결해요.

---

## 처리 흐름 (Passthrough 모드) — 4-Action 패턴

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

Fix가 완료되면 re-review 상태로 전환돼요. review_start부터 다시 반복해요.

---

## 전체 흐름

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

## 하네스 PR의 레포 간 참조 검사

스킬이나 에이전트 문서, 규칙 문서, 다른 레포가 이름으로 부르는 코드가 바뀐 PR은 문제가 diff 밖에서 나요. `agent-matcher`는 이런 변경 파일이 있으면 `harness-reviewer`를 항상 포함해요.

1. 스크립트가 diff 밖 후보를 모아요. 자기오염, 사본 어긋남, 자리표시자 풀이, 순방향 참조, 이 PR이 바꾼 이름을 부르는 역방향 검색이 여기에 들어가요. 역방향 검색은 관련 레포와 함께 이 레포의 diff 밖 하네스 파일도 찾아요.
2. 검색 대상 레포는 자동 탐지 결과와 `gestalt.json`의 `relatedRepos`를 합친 목록이에요. 탐지 결과는 `.gestalt/harness-refs-cache.json`에 캐시돼요. 갱신 조건은 [configuration.md](./configuration.md#관련-레포-relatedrepos)를 보세요.
3. `harness-reviewer`가 후보를 결함과 오탐으로 갈라요. 애매한 경로와 LLM이 읽는 문서로서의 문제(발동 조건 겹침, 상시 분량, 상대 경로 깊이, 파싱 계약)도 이 단계에서 봐요.
4. 레포를 넘는 참조는 main, 연관 PR head, 둘 다 머지된 뒤 세 상태에서 확인해요. main에서만 깨지고 연관 PR에서 풀리면 결함이 아니라 머지 순서 코멘트로 내려요.

`gh` 조회가 막혔거나 GitHub 원격이 없어 참조 검사를 못 돌린 라운드는 사용자에게 진행 여부를 묻고 비워둔 채 진행하면 리포트에 그 사실이 남아요. 그런 라운드에서 APPROVE가 나가는지는 [approve 게이트](#approve-게이트)가 정해요.

### 연관 PR 찾기

`gestalt harness-refs related-prs`가 이번 PR과 함께 움직이는 PR 후보를 찾아요. 아래 신호 중 하나라도 걸리면 후보가 돼요.

- 이번 PR 본문이 링크한 PR
- 제목, 본문, 브랜치 이름에 이번 PR과 같은 티켓 키가 있는 PR
- 참조 대상 파일을 건드리는 PR
- 같은 작성자가 이번 PR 생성일 앞뒤 14일 안에 만든 PR

검색은 열린 PR과 머지된 PR을 따로 해요. 머지된 PR은 이번 PR 생성일 30일 전부터 머지된 것만 봐요. 기준을 실행 시각 대신 생성일로 잡아서 오래 열린 PR을 리뷰하거나 지난 리뷰를 다시 돌려도 같은 시기 PR이 빠지지 않아요.

참조 대상을 건드리는 PR은 이번 PR보다 30일 넘게 먼저 열렸으면 후보에서 빼요. 이번 작업이 시작되기 전부터 열려 있던 PR은 파일이 겹쳐도 함께 진행한 작업이 아니라서요. 몇 달째 열린 PR 하나가 그 파일을 건드리는 모든 PR에 후보로 붙는 것도 이걸로 막아요. 머지된 쪽은 이번 PR 생성일 앞뒤 30일 안에 열린 PR만 봐요.

후보는 열린 PR이 먼저 오고 머지된 PR이 뒤에 와요. 같은 묶음 안에서는 신호 순서(본문 링크, 같은 티켓, 참조 대상 건드림, 나머지)로 세우고 신호가 같으면 생성일이 이번 PR과 가까운 순이에요. 순서만 바꾸고 거르지는 않아요. 신호가 약해도 진짜 연관인 PR이 있거든요.

### 연관 PR 확정 기준

후보마다 확정 수준(`confirmation`)이 붙어요. 세 상태 판정의 근거로는 `confirmed` 후보만 써요. ship은 내 PR이라 ⓐ 단계에서 사용자에게 확인받고 review-loop는 남의 PR이라 작성자에게 물어요.

| 신호 | ship | review-loop |
|:---|:---|:---|
| 본문 링크 | `confirmed` | `confirmed` |
| 같은 작성자와 같은 티켓 | `confirmed` | `confirmed` (근거를 리포트에 남겨요) |
| 같은 작성자와 같은 브랜치 이름 | `confirmed` | `needsAuthorAnswer` |
| 그 밖의 신호만 있음 | `needsShipConfirm` | `needsAuthorAnswer` |

확정 못 한 후보가 그 레포 기본 브랜치에 이미 머지됐으면 `inDefaultBranch`가 돼요. 그 변경은 세 상태 판정의 main 쪽에 벌써 들어 있어서 묻지 않아요. 기본 브랜치를 조회하지 못한 레포의 후보는 묻는 쪽에 남겨요. ship ⓐ에서 사용자가 확인한 후보는 다음 라운드에 `gestalt harness-refs three-state --confirm`으로 넘겨 확정으로 올려요.

### 세 상태 판정 결과

`gestalt harness-refs three-state`가 참조마다 `status`를 하나씩 내요.

| `status` | 뜻 | 리뷰가 하는 일 |
|:---|:---|:---|
| `ok` | 세 상태 어디서도 안 깨짐 | 올리지 않아요 |
| `mergeOrder` | main에서 깨지고 둘 다 머지되면 풀림 | 머지 순서 코멘트를 올려요 |
| `defect` | main에서도 둘 다 머지된 뒤에도 깨짐 | 결함 코멘트를 올려요 |
| `relatedRemovesUsed` | main에서는 멀쩡한데 연관 PR이 이번 PR이 쓰는 이름을 지움 | 이번 PR에 결함 코멘트를 올리고 연관 PR에도 알려요 |
| `blocked` | 상태를 못 봄 (로컬 클론 없음 등) | 문제 없음으로 읽지 않고 리포트에 재확인 줄을 남겨요 |

후보 PR이 있다는 이유만으로 판정에 넣은 레포도 있어요. 참조가 감지 안 된 레포라 그 main에 이번 PR의 식별자가 없는 건 당연해요. 그래서 연관 PR이 이번 PR이 쓰는 이름을 지우는지만 보고 `relatedRemovesUsed`일 때만 판정을 남겨요. 이런 레포에 클론이 없으면 `blocked` 대신 `limitations`에 한 줄만 적어요.

### 작성자에게 묻는 조건

미확정 후보를 전부 묻지는 않아요. 참조로 감지된 대상 레포의 main에서 참조가 깨졌거나 main을 못 봤을 때만 그 레포의 미확정 후보를 물어요. 그 목록이 `unconfirmedRelatedPrs`예요. 로컬 클론이 없어 main을 못 본 레포도 여기 들어가요.

main에서 이미 풀린 레포의 후보는 확정돼도 판정이 안 바뀌니 묻지 않고 approve도 막지 않아요. 참조 대상이 아닌 레포의 후보도 묻지 않아요. 묻지 않는 열린 후보는 `referenceOnlyRelatedPrs`로 모아 리포트 연관 PR 절의 "함께 보면 좋을 PR" 줄에 적어요.

### approve 게이트

approve를 낼지는 `gestalt review-loop approve-gate`가 정해요. 조회 막힘(`lookupBlocked`), 원격 없는 레포(`noGitHubRemote`), 연관 PR 미확정(`relatedPrUnconfirmed`)을 한 규칙으로 다뤄요.

- 이번 라운드에 새로 생긴 이슈가 있으면 사용자가 approve를 명시했어도 막아요. 사용자가 그 상태를 보고 명시한 게 아니라서요. 한 번 풀렸다가 다시 생긴 이슈도 새로 생긴 걸로 봐요.
- 이전 라운드부터 이어진 이슈만 있으면 사용자가 approve를 명시했을 때 허용해요. 명시가 없으면 막아요.
- 참조 검사를 비워둔 라운드는 이어졌는지와 상관없이 명시가 있어야 approve가 나가요.

명시는 처음부터 조건으로 건 지시("블로킹 이슈가 없으면 승인까지 해줘")와 이번 라운드에 한 지시를 모두 쳐요. review-loop의 자동 판정 동의(ⓢ)는 명시로 치지 않아요. 막히면 `APPROVE`를 `COMMENT`로 내려 게시해요. `REQUEST_CHANGES`로 바꾸지는 않고 다른 이벤트도 그대로 둬요.

연관 PR 미확정은 세 상태 판정의 `relatedPrUnconfirmed` 값만 넘겨요. `related-prs` 결과에도 같은 이름의 값이 있지만 main을 안 보고 낸 값이라 쓰지 않아요.

### 다음 PR로 미룬 작업

review-loop에서 작성자가 "다음 PR에서 할게요"라고 답한 스레드는 '다음 PR에서 한다'를 골라 이번 PR에서 해결 처리해요. 아직 없는 PR을 기다리면 루프가 끝나지 않아서요. 해결 처리 전에 `gestalt harness-refs followup build`가 만든 후속 표시를 스레드 답글로 달아요. 표시는 두 줄이에요. 첫 줄은 원래 PR과 작업할 레포, 할 일을 담은 HTML 주석이고 둘째 줄은 사람이 읽는 문장이에요. 답글이 올라간 뒤에만 스레드를 해결 처리해요.

후속 PR을 리뷰할 때는 `review` 스킬의 1.17단계가 이 표시를 이어받아요. `followup find`가 관련 레포에서 최근 30일 안에 머지된 PR 코멘트를 훑어 표시를 찾고 `followup check`가 이번 PR이 그 작업을 하는지 맞춰 봐요. 본문에 원래 PR이 안 적혔거나 작업이 안 보이거나 레포가 다르면 코멘트로 물어요.

표시는 믿는 작성자가 단 것만 읽어요. 기본은 원래 PR의 작성자와 지금 세션의 gh 로그인 사용자예요. 표시에 적힌 원래 PR이 코멘트가 달린 PR과 다르면 버려요. 버린 표시는 리포트에 개수만 남기고 내용은 옮기지 않아요.

---

## Severity 분류

| Severity | 의미 | 리뷰 통과 여부 |
|:---|:---|:---:|
| `critical` | 보안 취약점, 데이터 손실 위험, 런타임 크래시 | 차단 |
| `high` | 성능 심각 저하, 잘못된 비즈니스 로직 | 차단 |
| `warning` | 스타일, 개선 권장, 마이너 이슈 | 통과 (리포트에 기록) |

```
approved = criticalHighIssues.length === 0
```

---

## 재시도 규칙

```
currentAttempt ≤ maxAttempts(3) → Fix 가능
currentAttempt > maxAttempts(3) → exhausted: true, 최종 Report 반환
```

3회를 모두 소진하면 `status: 'failed_with_report'`로 세션이 종료돼요. 최종 ReviewReport에 잔여 이슈가 모두 기록돼요.

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

## MCP 액션 요약

| 액션 | 설명 |
|:---|:---|
| `review_start` | 리뷰 세션 시작, 컨텍스트 반환 |
| `review_submit` | Agent별 리뷰 결과 제출 |
| `review_consensus` | 합의된 이슈 목록 제출 → 통과/Fix 판정 |
| `review_fix` | Fix 컨텍스트 요청 → Fix 후 Re-review |
| `review_publish` | 합의 결과를 로컬 PR에 코멘트와 판정으로 기록 |

---

## 설계 결정

**`review_publish`의 판정은 어떻게 갈리나요?**

critical이나 high 이슈가 한 건이라도 있으면 `request_changes`, warning만 있으면 `approve`예요. 정합 심급(`continuity-judge`)이 `coherent: false`를 냈으면 결함이 하나도 없어도 `request_changes`예요.

이 경계는 `review_consensus`가 `approved`를 가르는 자리와 **일부러 같게** 뒀어요. 어긋나면 파이프라인은 통과인데 PR은 `request_changes`가 되는 상태가 생겨요. 어느 쪽을 믿어야 할지 알 수 없는 상태라 한쪽으로 맞춰야 해요.

**같은 합의를 두 번 게시하면요?**

두 번째는 아무것도 쓰지 않고 첫 번째 결과를 그대로 돌려줘요(`alreadyPublished: true`). PR은 이벤트 소싱이라 한 번 붙은 코멘트를 지울 수 없어요. 중복이 생기면 사람이 손으로 resolve하는 수밖에 없거든요.

막지 않고 멱등하게 만든 건 부르는 쪽이 호스트의 재시도이기 때문이에요. 오류로 접으면 호스트는 실패로 보고 다시 불러요. 그런데 PR에는 이미 다 쓰여 있어요.

코멘트 N건과 판정 하나를 따로 쓰는 다중 쓰기라 원자적으로는 못 묶어요. 대신 매 코멘트마다 어디까지 썼는지를 세션에 남겨 둬요. 중간에 끊긴 뒤 다시 부르면 그 다음부터 이어 써요. PR의 head가 옮겨갔으면 작성자가 고쳐 올린 새 라운드라 처음부터 다시 써요.

**Evaluate를 통과했는데 왜 Code Review를 또 하나요?**

Evaluate의 Contextual Stage는 LLM이 AC 충족 여부를 평가해요. LLM은 코드의 보안 취약점이나 성능 문제를 AC 검증 과정에서 놓칠 수 있어요. Code Review는 Evaluate가 통과시킨 코드를 도메인 전문 Agent가 다시 한번 검증하는 안전망이에요.

**왜 warning 이슈는 차단하지 않나요?**

Warning은 "있으면 좋지만 없어도 동작한다"는 의미예요. 이를 차단하면 스타일 이슈 때문에 배포가 막히는 상황이 생겨요. Warning은 리포트에 기록해 인지할 수 있게 하되, 최종 결정은 사람에게 맡겨요.

**왜 Fix 후 부분 재검토가 아닌 전체 Re-review를 하나요?**

Fix가 하나의 이슈를 고치면서 다른 이슈를 만들어낼 수 있어요. 부분 재검토는 이런 regression을 놓쳐요. Agent 수가 많지 않다면 비용 차이도 크지 않고, 전체 Re-review가 더 안전해요.

**왜 최대 3회인가요?**

2회는 너무 적어요. 첫 번째 Fix가 새 이슈를 만들면 두 번째 시도가 유일한 기회가 되거든요. 4회 이상은 수렴하지 않는 코드를 계속 수정하는 낭비예요. 3회가 "합리적인 노력"과 "무한 루프 방지" 사이의 균형점이에요.

---

## 소스 코드 참조

| 파일 | 역할 |
|:---|:---|
| `src/review/passthrough-engine.ts` | `PassthroughReviewEngine` — 4-Action 전체 |
| `src/review/context-collector.ts` | 변경 파일 + 의존성 파일 수집 |
| `src/review/agent-matcher.ts` | 리뷰 Agent 매칭 컨텍스트 생성 |
| `src/review/report-generator.ts` | ReviewReport 생성 |
| `src/mcp/tools/review-passthrough.ts` | MCP 핸들러 |
| `src/harness-review/related-pr.ts` | 연관 PR 탐색, 확정 수준 결정 |
| `src/harness-review/three-state.ts` | 레포 간 참조의 세 상태 판정 |
| `src/harness-review/approve-gate.ts` | approve 게이트 판정, 라운드 기록 |
| `src/harness-review/follow-up-marker.ts` | 후속 표시 만들기와 읽기 |
| `src/cli/commands/harness-refs-cross-pr.ts` | `gestalt harness-refs related-prs`, `three-state`, `followup` CLI |
| `src/core/types.ts` | `ReviewSession`, `ReviewResult`, `ReviewIssue`, `ReviewReport` |
