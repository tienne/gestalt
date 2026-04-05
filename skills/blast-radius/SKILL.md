---
name: blast-radius
version: "1.1.0"
description: "코드 변경 전 영향 범위를 파악해 읽어야 할 파일만 컨텍스트에 제공한다. 변경 범위가 불확실하거나 사이드 이펙트가 걱정될 때 자동 발동한다."
triggers:
  # 영향범위 확인 의도
  - "영향범위"
  - "영향범위 확인"
  - "영향범위 얼마나 돼"
  - "어디까지 영향받아"
  - "어디 영향받아"
  - "뭐가 깨질 수 있어"
  - "어떤 파일 같이 봐야 해"
  - "관련 파일 뭐 있어"
  - "어디 의존하고 있어"
  - "어디서 쓰이고 있어"
  # 변경 전 안전 확인 의도
  - "건드리기 전에"
  - "수정 전에 확인"
  - "수정 범위"
  - "사이드 이펙트"
  # 범위가 큰 변경 작업
  - "시그니처 바꿔"
  - "인터페이스 변경"
  - "타입 바꿔"
  - "리팩토링"
  # 기존 영어 표현 유지
  - "blast radius"
  - "blast-radius"
  - "impact analysis"
inputs:
  repoRoot:
    type: string
    required: false
    description: "Repository root path (defaults to current working directory)"
  changedFiles:
    type: string[]
    required: false
    description: "Changed file paths (auto-detected from git diff HEAD~1 if omitted)"
  base:
    type: string
    required: false
    description: "Git base ref for diff detection (default: HEAD~1)"
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

# Blast Radius Skill

최근 코드 변경의 영향 범위를 분석해 **읽어야 할 파일만** 컨텍스트에 제공합니다. 불필요한 파일 읽기를 줄여 LLM 토큰 사용을 최소화합니다.

## 전제 조건

코드 지식 그래프가 먼저 빌드되어 있어야 합니다:
```
/build-graph
```

## 실행 방법

### 기본 (마지막 커밋 변경 파일 자동 감지)

```
ges_code_graph {
  action: "blast_radius",
  repoRoot: "<현재 디렉토리 절대 경로>"
}
```

### 변경 파일 직접 지정

```
ges_code_graph {
  action: "blast_radius",
  repoRoot: "<경로>",
  changedFiles: ["src/auth.ts", "src/middleware.ts"]
}
```

### Git base ref 지정

```
ges_code_graph {
  action: "blast_radius",
  repoRoot: "<경로>",
  base: "main"
}
```

## 결과 해석

| 필드 | 설명 |
|------|------|
| `changedFiles` | 변경된 파일 목록 |
| `impactedFiles` | 영향받는 파일 목록 (테스트 파일 우선 정렬) |
| `riskScore` | 위험도 점수 0~1 (전체 대비 영향 노드 비율) |
| `summary` | 한 줄 요약 |

## Skill Instructions

1. `repoRoot`가 주어지지 않으면 현재 작업 디렉토리를 절대 경로로 사용합니다.
2. 코드 그래프 DB가 없으면 먼저 `/build-graph`를 실행하도록 안내합니다:
   - `ges_code_graph { action: "db_exists", repoRoot: "<repoRoot>" }` 호출
   - `exists: false`이면 빌드 먼저 안내
3. `ges_code_graph { action: "blast_radius", repoRoot: "<repoRoot>", changedFiles?: [...], base?: "...", maxDepth?: 2 }` 호출합니다.
4. 결과를 다음 형식으로 표시합니다:

```
## 영향범위 분석 결과

**변경된 파일** (N개):
- src/auth.ts
- src/middleware.ts

**영향받는 파일** (M개):
- src/auth.test.ts        ← 테스트 파일 우선
- src/api/routes.ts
- src/api/middleware.ts

**위험도**: 0.23 (낮음)
**요약**: {summary}
```

5. `impactedFiles` 목록을 컨텍스트로 활용합니다:
   - "아래 파일들이 영향을 받을 수 있습니다. 관련 작업 전 이 파일들을 먼저 읽어보겠습니다:" 형식으로 안내
   - 파일이 많으면 (10개 이상) 가장 중요한 파일(테스트 파일, 핵심 모듈)을 우선 읽도록 제안
6. 빌드된 그래프가 오래된 경우 `/build-graph --incremental` 실행을 권장합니다.
