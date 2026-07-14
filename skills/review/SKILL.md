---
name: review
version: "1.0.0"
description: "PR·브랜치·커밋의 변경사항을 3종 리뷰 에이전트(보안·성능·품질)로 검토하고, humanize-monolith로 리포트를 다듬은 뒤, PR 대상이면 code-review-writer가 작성한 인라인 코멘트로 게시한다."
triggers:
  - "PR 리뷰"
  - "브랜치 리뷰"
  - "코드 리뷰"
  - "diff 리뷰"
  - "review PR"
  - "review branch"
  - "이 브랜치 리뷰"
  - "변경사항 리뷰"
  - "PR에 코멘트 남겨줘"
  - "리뷰 코멘트 달아줘"
  - "PR에 인라인 코멘트"
  - "리뷰 결과 PR에 게시"
inputs:
  target:
    type: string
    required: false
    description: "리뷰 대상: 브랜치명, 커밋 해시, 또는 범위(main..feature/auth). 생략 시 현재 브랜치 vs main"
  repoRoot:
    type: string
    required: false
    description: "Repository root (기본값: 현재 디렉토리)"
outputs:
  - reviewIntent
  - changeContext
  - reviewReport
  - verdict
  - continuityVerdict
  - postedReview
---

# Review Skill

execute 세션 없이 PR·브랜치·커밋의 변경사항을 직접 리뷰 파이프라인에 주입해 검토합니다.
변경 파일을 수집하고, 3종 리뷰 에이전트(보안·성능·품질)로 다각도 리뷰한 뒤(**결함 심급**), `continuity-judge`가 변경 전체의 목표 정합성과 일관성을 감독하고(**정합 심급**), Pass/Block 판정과 마크다운 리포트를 생성합니다. 리뷰 대상이 GitHub PR이면 `code-review-writer` 에이전트가 작성한 인라인 코멘트로 PR에 게시까지 이어집니다.

## 사용 방법

```
/review                        # 현재 브랜치 vs main
/review feature/auth           # 특정 브랜치 vs main
/review main..feature/auth     # 범위 지정
/review abc1234                # 특정 커밋
```

## 전제 조건

코드 지식 그래프가 빌드되어 있어야 변경 파일의 영향범위까지 수집할 수 있습니다:
```
/build-graph
```
그래프 DB가 없으면 `ges_code_graph { action: "db_exists", repoRoot: "<repoRoot>" }`로 확인 후 `/build-graph`를 먼저 안내합니다.

## Skill Instructions

`repoRoot`가 주어지지 않으면 현재 작업 디렉토리를 절대 경로로 사용합니다.
`target`이 주어지지 않으면 현재 브랜치 vs `main`을 기준으로 삼습니다.

### 0단계: 미니 인터뷰 (reviewIntent 수집)

본격 리뷰에 앞서 리뷰의 의도·중점 영역을 한 번에 가볍게 확인합니다. **세 질문을 단일 묶음으로 한 번에 제시**하고, 사용자의 한 번의 응답으로 처리합니다 (1턴 경량 인터뷰):

```
리뷰를 시작하기 전에 세 가지를 확인합니다. 모르거나 해당 없으면 Enter / "없음"으로 건너뛰어도 됩니다.

1. 이번 변경의 주요 목적/의도는? (한 줄)
2. 특별히 중점을 둬야 할 영역이 있나요? (보안·성능·품질·프론트엔드 등)
3. 리뷰어가 미리 알면 좋을 배경 정보가 있나요?
```

사용자 응답을 `reviewIntent = { purpose, focusAreas[], background }` 형태로 보관합니다.

- 각 항목별로 빈 응답·`"없음"`·`"스킵"`·`"바로 리뷰"` 등은 해당 항목을 `"(없음)"`으로 처리합니다.
- `focusAreas`는 2번 답변에서 언급된 영역(보안·성능·품질·프론트엔드 등)을 배열로 추출합니다. 없으면 빈 배열로 둡니다.
- **전체 건너뛰기**: 사용자가 `"스킵"` / `"그냥 리뷰"` / `"바로 시작"` 등으로 (개별 질문이 아닌) 0단계 자체를 건너뛰겠다는 의사를 보이면, 0단계 전체를 건너뛰고 `reviewIntent`의 모든 항목을 `"(없음)"`/빈 배열로 둔 채 1단계로 바로 진행합니다.

`reviewIntent`는 MCP 입력 파라미터로 전달되지 않습니다 — 이후 단계에서 **Claude의 추론 컨텍스트로만** 활용합니다.

### 1단계: 변경 파일 수집 (blast_radius)

`blast_radius`로 리뷰 대상의 변경 파일과 영향받는 파일을 수집합니다:

```
ges_code_graph {
  action: "blast_radius",
  repoRoot: "<repoRoot>",
  base: "<target>"
}
```

`changedFiles`와 `impactedFiles`를 합쳐 리뷰 대상 파일 목록을 구성합니다.

### 1.5단계: 기획 컨텍스트 분석

`blast_radius`로 수집한 `changedFiles`를 바탕으로 변경의 기획적 의도와 동작 변화를 분석한다.

`ges_agent { action: "get", name: "change-context-writer" }`로 에이전트 시스템 프롬프트를 가져온 뒤, 해당 관점에서 diff를 분석해 기획 컨텍스트 문서를 작성한다.

0단계에서 수집한 `reviewIntent.purpose`·`reviewIntent.background`가 `"(없음)"`이 아니라면, diff 분석 입력에 함께 전달해 더 정확한 기획 컨텍스트를 생성하도록 한다.

작성된 컨텍스트 문서를 **리뷰 결과보다 먼저** 사용자에게 표시한다.

### 2단계: 리뷰 시작 (review_start)

수집한 파일을 직접 주입해 리뷰 세션을 시작합니다 (execute 세션 불필요):

```
ges_execute {
  action: "review_start",
  changedFiles: [...수집한 파일...],
  repoRoot: "<repoRoot>"
}
```

응답의 `reviewSessionId`, `reviewStartContext.systemPrompt`, `reviewStartContext.matchContext`를 확보합니다.
`matchContext.matchingPrompt`를 참고해 이번 리뷰에 투입할 에이전트(보안·성능·품질 등)를 선택합니다.

0단계의 `reviewIntent.focusAreas`에 영역이 명시돼 있으면 해당 전문가를 **반드시 포함하고, 가장 먼저 제출**합니다:
- `"보안"` → security-reviewer 우선
- `"성능"` → performance-reviewer 우선
- `"품질"` → quality-reviewer 우선
- `"프론트엔드"` → frontend-reviewer 우선

`focusAreas`가 비어 있으면 기존 기본 순서(보안 → 성능 → 품질)를 유지합니다.

### 3단계: 에이전트별 리뷰 제출 (review_submit × 3)

선택한 각 에이전트의 관점으로 변경 파일을 직접 읽고 검토한 뒤, 에이전트마다 한 번씩 `review_submit`을 호출합니다 (보안 → 성능 → 품질 순으로 최소 3회):

```
ges_execute {
  action: "review_submit",
  reviewSessionId: "<reviewSessionId>",
  reviewAgentName: "<agent-name>",
  reviewResult: {
    issues: [
      {
        id: "...",
        severity: "critical" | "high" | "warning",
        category: "...",
        file: "path/to/file.ts",
        line: 42,
        message: "...",
        suggestion: "..."
      }
    ],
    approved: true | false,
    summary: "..."
  }
}
```

`systemPrompt`가 요구하는 JSON 스키마(severity·category·file·line·message·suggestion)를 준수합니다.

### 4단계: 합의 및 판정 (review_consensus)

모든 에이전트의 리뷰를 병합해 Pass/Block을 판정합니다:

```
ges_execute {
  action: "review_consensus",
  reviewSessionId: "<reviewSessionId>",
  reviewConsensus: {
    mergedIssues: [...전체 이슈 병합...],
    approvedBy: [...],
    blockedBy: [...],
    summary: "...",
    overallApproved: true | false
  }
}
```

`review_consensus`의 Pass/Block 판정은 **결함 심급**입니다 — 보안·성능·품질 에이전트가 검출한 국소 결함(critical/high)만 봅니다. 여기에 4.3단계의 **정합 심급**을 얹어, 변경이 목표를 향하는지·전체가 일관된지까지 판단한 뒤 4.5단계로 넘깁니다.

### 4.3단계: 정합 심급 감독 (continuity-judge)

결함 심급(4단계)이 "부분에 결함이 있나"를 봤다면, 정합 심급은 "부분의 합이 목표를 이루나"를 봅니다. 국소 결함으로는 안 잡히는 **목표 이탈(drift)과 전체 일관성**을 `continuity-judge` 관점으로 감독합니다.

`ges_agent { action: "get", name: "continuity-judge" }`로 에이전트 시스템 프롬프트를 가져온 뒤(원리 에이전트라도 `get`으로 조회됩니다), 그 관점에서 **개별 이슈가 아니라 변경 전체**를 아래 세 축으로 판단합니다. 판단 기준은 `reviewIntent.purpose`(0단계에서 수집), 없으면 `spec.goal`, 그것도 없으면 변경 파일에서 추론한 목표입니다.

- **목표 정합**: 이 변경(전체 diff)이 명시된 목적을 향해 가는가? 목적과 무관하거나 반하는 변경이 섞여 있지 않은가?
- **일관성**: 변경 파일 간 네이밍·API·패턴이 일관된가? 주변 코드의 기존 컨벤션과 이어지는가?
- **이탈(drift)**: 스펙 제약(`reviewContext.spec.constraints`)이나 원래 의도와 모순되는 지점이 있는가?

산출물은 `continuityVerdict`로 보관합니다:

```
continuityVerdict = {
  coherent: true | false,        // 정합 심급 통과 여부
  driftFindings: [               // 목표 이탈·불일치 항목 (없으면 빈 배열)
    { axis: "goal" | "consistency" | "drift", file?, message }
  ],
  escalate: true | false,        // 라인 수정으로 해결 불가 → 재설계 필요 신호
  summary: "..."
}
```

**v1에서 정합 심급은 자문(advisory)입니다** — 4단계의 Pass/Block(결함 기준)을 뒤집지 않습니다. 대신 두 가지로 이어집니다.

- `driftFindings`를 4단계 리포트 하단에 **"정합 심급" 섹션**으로 덧붙여 4.5단계로 함께 넘깁니다. 이 섹션도 humanize 대상입니다.
- `escalate: true`이면 결함 수정 루프(6단계 `review_fix`)로 보내지 않습니다. 라인 수정이 아니라 스펙·설계 이탈이므로, 사용자에게 **"이 변경은 목표에서 벗어나는 부분이 있어 라인 수정으로는 부족합니다. 스펙 재정리(similarity-crystallizer) 또는 결정 재확인이 필요해 보여요"** 라고 한 줄 알리고 판단을 넘깁니다.

정합 심급에서 아무 이탈도 없으면(`coherent: true`, `driftFindings` 비어 있음) 조용히 통과하고 별도 섹션을 붙이지 않습니다.

### 4.5단계: 리포트 워싱 (humanize-monolith)

`review_consensus`가 반환한 마크다운 리포트를 `humanize-monolith` 에이전트로 전달해 AI 말투·번역투를 제거합니다.

`ges_agent { action: "get", name: "humanize-monolith" }`로 에이전트 시스템 프롬프트를 가져온 뒤, 해당 관점에서 리포트를 윤문합니다. 이슈 내용(severity·file·line·message)은 수정하지 않고, 설명 문장의 어투만 자연스럽게 다듬습니다.

humanize-monolith는 두 룰북을 함께 적용합니다.
- **어투**: `../../role-agents/technical-writer/references/author-voice.md` — 제안형("~하는 게 좋을 것 같아요/어떨까요?"), 온기·물결·이모지(코멘트당 1개 안팎)는 보존하고, `c:`/`r:` 접두어·`[출처]` 태깅·"…권장." 체언 종지(Claude artifact)는 쓰지 않습니다.
- **음차·AI-tell**: `../../role-agents/technical-writer/references/ai-tell-quick-rules.md` — 안 굳어진 음차("소스 오브 트루스" 등)는 한글 의역하되, 굳어진 화이트리스트(컴포넌트·토큰·렌더링·트레이드오프 등)는 그대로 둡니다.

즉 리뷰 파이프라인 리포트도 인라인 코멘트와 동일하게 voice + 음차가 함께 처리됩니다.

윤문된 리포트를 사용자에게 표시합니다. 그다음 대상이 GitHub PR이면 4.7단계로, 아니면 결과 표시로 넘어갑니다.
- `approved: true` → 리뷰 통과. 리포트를 보여줍니다.
- `approved: false` → critical/high 이슈가 남아 Block 상태입니다.

### 4.7단계: 인라인 코멘트 게시 (code-review-writer)

리뷰 대상이 GitHub PR이면, 4단계에서 병합한 이슈를 **리포트로 끝내지 않고 PR에 인라인 코멘트로 게시**합니다. 이 단계의 코멘트 본문은 반드시 `code-review-writer` 에이전트가 작성합니다 — Claude가 즉흥으로 쓰지 않습니다. 그래야 어투가 매 리뷰마다 일정하게 유지됩니다.

#### 진입 경로 두 가지

이 단계는 `/review`를 처음부터 돌린 흐름뿐 아니라, **대화 도중 "이제 PR에 코멘트 남겨줘"처럼 게시만 따로 요청**받았을 때도 진입점이 됩니다 (위 triggers의 "PR에 코멘트 남겨줘" 등). 두 경우 모두 아래 **신선도 가드를 먼저 통과해야** 게시할 수 있습니다.

#### 신선도 가드 (stale consensus 게시 금지)

게시 직전에, 게시하려는 consensus가 **현재 diff와 일치하는지** 반드시 확인합니다. 리뷰를 끝낸 뒤 코드가 바뀌었거나(커밋 추가·로컬 수정), 애초에 활성 리뷰 세션이 없으면 그 consensus는 stale이므로 **그대로 올리지 않습니다.**

```bash
# 리뷰 시점 대비 PR head·작업트리가 바뀌었는지 확인
gh pr view <target> --json headRefOid
git rev-parse HEAD && git status --porcelain
```

판단 기준:

- **이번 세션에 방금 리뷰를 끝냈고 그 뒤 diff 변화가 없다** → consensus가 신선함. 곧장 게시 진행.
- **리뷰 후 코드가 바뀌었다 / 활성 리뷰 세션이 없다 / 다른 세션의 오래된 결과다** → consensus가 stale. **게시하지 말고**, 1단계(blast_radius)부터 현재 diff로 리뷰 파이프라인(1~4단계)을 다시 돌린 뒤, 새로 나온 consensus로 4.7을 진행합니다. 사용자에게 "변경이 있어 현재 코드로 다시 리뷰한 뒤 게시할게요"라고 한 줄 알립니다.

즉 인라인 코멘트는 **언제 요청받든 항상 "현재 diff 기준 consensus + code-review-writer voice"** 로만 게시됩니다. 옛 리뷰 메모리를 그대로 옮겨 적거나 Claude가 손으로 코멘트를 짜는 경로는 없습니다.

**PR 식별.** 먼저 대상이 PR인지 확인합니다.

```bash
gh pr view <target> --json number,headRefName,baseRefName,url 2>/dev/null
```

`target`이 브랜치면 그 브랜치의 PR을, 생략됐으면 현재 브랜치의 PR을 찾습니다. PR이 없으면(로컬 브랜치·커밋 범위 등) 이 단계를 통째로 건너뛰고 결과 표시로 갑니다.

**게시 확인.** PR이 식별되면 사용자에게 한 번 확인합니다: **"발견된 이슈 N건을 PR #<number>에 인라인 코멘트로 게시할까요?"** 동의하지 않으면 리포트만 보여주고 종료합니다.

**코멘트 본문 작성 (code-review-writer).** `ges_agent { action: "get", name: "code-review-writer" }`로 에이전트 시스템 프롬프트를 가져온 뒤, 그 관점에서 4단계 `mergedIssues`의 각 이슈를 인라인 코멘트 본문으로 작성합니다. 이슈의 `file`·`line`·`severity`는 그대로 두고, `message`·`suggestion`을 에이전트 voice로 다듬어 코멘트 본문을 만듭니다.

- code-review-writer는 `author-voice.md`(제안형·온기·물결·이모지)와 `ai-tell-quick-rules.md`(음차 교정)를 이미 내장하므로 **별도 humanize-monolith 패스를 거치지 않습니다.**
- 에이전트 룰에 따라 `c:`/`r:` 접두어, `[출처]` 태깅, "…권장." 체언 종지는 쓰지 않습니다. 이건 Claude artifact이지 실제 리뷰어 어투가 아닙니다.
- severity는 본문 첫 줄에 `[critical]`처럼 대괄호 라벨로만 표기합니다.

**게시 (gh api).** 작성한 코멘트를 한 번의 리뷰로 묶어 게시합니다. 이슈마다 개별 호출하지 않고 `comments` 배열로 모읍니다.

```bash
gh api repos/{owner}/{repo}/pulls/{number}/reviews \
  -f event=COMMENT \
  -f body="<요약 한 줄 — code-review-writer가 작성한 overall summary>" \
  --input <(jq -n '{ comments: [ { path: "...", line: 42, side: "RIGHT", body: "..." } ] }')
```

- `line`은 diff의 **우측(신규) 라인**을 기준으로 하고 `side: "RIGHT"`를 명시합니다. 삭제된 라인을 짚어야 하면 `side: "LEFT"`를 씁니다.
- 라인 매핑이 불확실한 이슈(파일 전반·구조적 지적 등)는 인라인 대신 리뷰 `body` 요약에 한 줄로 넣습니다. 임의 라인에 억지로 붙이지 않습니다.
- 게시 후 리뷰 URL을 사용자에게 보여줍니다.

JSON 제어문자가 깨지지 않도록 코멘트 본문은 셸 변수 echo 파이프 대신 `jq`로 직접 조립하거나 파일로 떨궈 `--input`으로 전달합니다.

### 5단계: 수정 확인 (review_fix, opt-in)

자동 수정은 기본 동작이 아닙니다. 4.7단계로 인라인 코멘트를 게시했거나 리포트를 보여준 뒤, 사용자가 **명시적으로 수정을 요청할 때만** 진행합니다 ("고쳐줘"·"수정해줘" 등). Block 상태라도 먼저 자동 수정을 들이밀지 않습니다.

요청을 받으면 `review_fix`로 수정 컨텍스트를 받아 critical/high 이슈를 수정합니다:

```
ges_execute {
  action: "review_fix",
  reviewSessionId: "<reviewSessionId>"
}
```

`fixContext.fixPrompt`에 따라 파일을 수정하고 구조 검사(lint·build·test)를 실행한 뒤, 2단계의 `review_start`부터 다시 반복해 재리뷰합니다.
`review_exhausted` 응답이 오면 최대 시도 횟수를 초과한 것이므로 리포트를 보여주고 남은 이슈는 수동 수정하도록 안내합니다.

## 결과 표시

0단계의 `reviewIntent`에 `purpose` 또는 `focusAreas`가 하나라도 있으면, 전체 출력 최상단에 리뷰 컨텍스트 블록을 표시합니다 (둘 다 `"(없음)"`/빈 배열이면 블록 전체를 생략):

```
## 리뷰 컨텍스트
**목적**: {purpose 또는 "(없음)"}
**중점 영역**: {focusAreas 또는 "(없음)"}

---
```

그다음 기획 컨텍스트 문서(1.5단계)를 리뷰 리포트 앞에 먼저 표시한 뒤, 코드 리뷰 결과를 표시합니다.

```
{1.5단계 기획 컨텍스트 마크다운}

---

## 코드 리뷰 결과

**대상**: <target>
**판정**: PASS / BLOCK

{report 마크다운}
```

4.7단계에서 인라인 코멘트를 게시했으면, 리포트 끝에 게시 결과를 한 줄로 덧붙입니다.

```
---

**인라인 코멘트**: PR #<number>에 <N>건 게시 완료 → <리뷰 URL>
```

PR이 아니거나 사용자가 게시를 거절했으면 이 블록을 생략합니다.
