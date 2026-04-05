---
name: diff-radius
version: "1.0.0"
description: "커밋 전 미저장·스테이징 변경의 영향범위를 분석한다. 작업 중인 코드가 어디까지 영향 주는지 바로 확인할 때 자동 발동한다."
triggers:
  # 작업 중 변경 확인
  - "지금 바꾼 거 영향범위"
  - "작업 중인 거 영향범위"
  - "저장한 거 영향범위"
  - "수정 중인 거 영향범위"
  - "아직 커밋 안 한 거 영향범위"
  - "미커밋 영향범위"
  # 스테이징 확인
  - "스테이징된 거 영향범위"
  - "staged 영향범위"
  - "git add 한 거 영향범위"
  # 커밋 전 안전 확인
  - "커밋 전에 영향범위"
  - "올리기 전에 영향범위"
  - "푸시 전에 영향범위"
inputs:
  repoRoot:
    type: string
    required: false
    description: "Repository root path (defaults to current working directory)"
  diffMode:
    type: string
    required: false
    description: "staged: git diff --cached, unstaged: git diff, all: staged+unstaged (default)"
  maxDepth:
    type: number
    required: false
    description: "BFS traversal depth (default: 2)"
outputs:
  - changedFiles
  - impactedFiles
  - riskScore
  - summary
---

# Diff Radius Skill

커밋하지 않은 변경의 영향범위를 분석합니다. `/blast-radius`가 커밋 기준이라면, 이 스킬은 **지금 작업 중인 변경** 기준으로 동작합니다.

## 전제 조건

코드 지식 그래프가 먼저 빌드되어 있어야 합니다:
```
/build-graph
```

## 실행 방법

### 기본 (staged + unstaged 전체)

```
ges_code_graph {
  action: "diff_radius",
  repoRoot: "<현재 디렉토리 절대 경로>"
}
```

### 스테이징된 변경만 (git add 한 것)

```
ges_code_graph {
  action: "diff_radius",
  repoRoot: "<경로>",
  diffMode: "staged"
}
```

### 아직 스테이징 안 된 변경만

```
ges_code_graph {
  action: "diff_radius",
  repoRoot: "<경로>",
  diffMode: "unstaged"
}
```

## blast-radius와 차이

| | `/blast-radius` | `/diff-radius` |
|---|---|---|
| 기준 | 마지막 커밋 (`HEAD~1`) | 현재 작업 중인 변경 |
| git 명령 | `git diff HEAD~1` | `git diff HEAD` / `git diff --cached` |
| 용도 | 배포된 변경 영향 확인 | 커밋 전 영향범위 사전 확인 |

## 결과 해석

| 필드 | 설명 |
|------|------|
| `changedFiles` | 변경된 파일 목록 |
| `impactedFiles` | 영향받는 파일 목록 (테스트 파일 우선 정렬) |
| `riskScore` | 위험도 점수 0~1 |
| `summary` | 한 줄 요약 |

## Skill Instructions

1. `repoRoot`가 주어지지 않으면 현재 작업 디렉토리를 절대 경로로 사용합니다.
2. 코드 그래프 DB가 없으면 먼저 `/build-graph`를 실행하도록 안내합니다:
   - `ges_code_graph { action: "db_exists", repoRoot: "<repoRoot>" }` 호출
   - `exists: false`이면 빌드 먼저 안내
3. `ges_code_graph { action: "diff_radius", repoRoot: "<repoRoot>", diffMode?: "staged"|"unstaged"|"all", maxDepth?: 2 }` 호출합니다.
4. 결과를 다음 형식으로 표시합니다:

```
## 영향범위 분석 결과 (미커밋 변경)

**변경된 파일** (N개):
- src/auth.ts
- src/middleware.ts

**영향받는 파일** (M개):
- src/auth.test.ts        ← 테스트 파일 우선
- src/api/routes.ts

**위험도**: 0.23 (낮음)
**요약**: {summary}
```

5. `impactedFiles` 목록을 컨텍스트로 활용합니다.
6. 변경된 파일이 없으면 "현재 미커밋 변경이 없습니다." 안내합니다.
