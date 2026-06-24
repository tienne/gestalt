---
name: review
version: "1.0.0"
description: "PR·브랜치·커밋의 변경사항을 3종 리뷰 에이전트(보안·성능·품질)로 검토하고, humanize-monolith로 리포트를 자연스러운 한국어로 다듬는다."
triggers:
  - "PR 리뷰"
  - "브랜치 리뷰"
  - "코드 리뷰"
  - "diff 리뷰"
  - "review PR"
  - "review branch"
  - "이 브랜치 리뷰"
  - "변경사항 리뷰"
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
---

# Review Skill

execute 세션 없이 PR·브랜치·커밋의 변경사항을 직접 리뷰 파이프라인에 주입해 검토합니다.
변경 파일을 수집하고, 3종 리뷰 에이전트(보안·성능·품질)로 다각도 리뷰한 뒤, Pass/Block 판정과 마크다운 리포트를 생성합니다.

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

응답의 `report`(마크다운)를 4.5단계로 넘깁니다.

### 4.5단계: 리포트 워싱 (humanize-monolith)

`review_consensus`가 반환한 마크다운 리포트를 `humanize-monolith` 에이전트로 전달해 AI 말투·번역투를 제거합니다.

`ges_agent { action: "get", name: "humanize-monolith" }`로 에이전트 시스템 프롬프트를 가져온 뒤, 해당 관점에서 리포트를 윤문합니다. 이슈 내용(severity·file·line·message)은 수정하지 않고, 설명 문장의 어투만 자연스럽게 다듬습니다.

이때 윤문 대상은 리뷰어가 말하는 글이므로 `../../role-agents/technical-writer/references/author-voice.md`의 작성자 voice를 적용합니다. 제안형 어투("~하는 게 좋을 것 같아요/어떨까요?"), 온기·물결·이모지(코멘트당 1개 안팎)는 보존하고, `c:`/`r:` 접두어·`[출처]` 태깅·"…권장." 체언 종지(Claude artifact)는 쓰지 않습니다.

윤문된 리포트를 사용자에게 표시합니다:
- `approved: true` → 리뷰 통과. 리포트를 보여주고 종료합니다.
- `approved: false` → critical/high 이슈가 남아 Block 상태입니다. 5단계로 진행합니다.

### 5단계: 수정 확인 (review_fix)

Block일 때 사용자에게 **"수정하시겠습니까?"** 를 먼저 확인합니다.
동의하면 `review_fix`로 수정 컨텍스트를 받아 critical/high 이슈를 수정합니다:

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
