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
`matchContext`를 참고해 이번 리뷰에 투입할 에이전트(보안·성능·품질 등)를 선택합니다.

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

```
## 코드 리뷰 결과

**대상**: <target>
**판정**: PASS / BLOCK

{report 마크다운}
```
