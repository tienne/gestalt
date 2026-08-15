---
name: blast-radius
version: "1.1.0"
description: "코드 변경 전 영향 범위를 파악해 읽어야 할 파일만 컨텍스트에 제공한다. 변경 범위가 불확실하거나 사이드 이펙트가 걱정될 때 자동 발동한다. 아직 고치지 않은 코드가 대상이다. 이미 고쳐서 미커밋이나 스테이징 상태인 변경의 영향범위는 diff-radius를 쓴다."
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

> **도구가 없을 때** → [`../_shared/tool-availability.md`](../_shared/tool-availability.md)
> `ges_*` 도구가 없거나 호출이 실패하면 직접 흉내내 진행하지 않고 무엇이 왜 안 되는지 말하고 멈춥니다.

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
| `riskScore` | 위험도 점수 0~1 (전체 대비 영향 노드 비율). `depthExhausted`면 하한이다 |
| `depthExhausted` | `maxDepth`에 걸려 탐색이 멈췄고 갈 곳이 남아 있었다 |
| `unexploredNodes` | 그때 다음 홉에서 기다리던 노드 수 |
| `summary` | 한 줄 요약 |

**`depthExhausted: true`면 결과는 전부가 아니라 하한이다.** 기본 `maxDepth`가 2라 3홉 이상 떨어진 호출부는 목록에 없다. 이걸 안 알리면 사용자는 "영향받는 파일 12개, 위험도 낮음"을 완전한 답으로 읽고 나머지를 안 읽는다 — 이 스킬을 쓰는 이유가 사이드 이펙트를 놓치지 않으려는 것이므로 그 오해가 가장 비싸다.

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

`depthExhausted: true`면 위 표시 바로 아래에 한 줄을 덧붙입니다. 빠뜨리지 않습니다.

```
⚠️ 깊이 {maxDepthUsed}에서 탐색이 멈췄고 {unexploredNodes}개 노드가 남았습니다.
   위 목록과 위험도는 하한이며 전부가 아닙니다. 전체를 보려면 maxDepth를 올려 다시 부르세요.
```

5. `impactedFiles` 목록을 컨텍스트로 활용합니다:
   - "아래 파일들이 영향을 받을 수 있습니다. 관련 작업 전 이 파일들을 먼저 읽어보겠습니다:" 형식으로 안내
   - 파일이 많으면 (10개 이상) 가장 중요한 파일(테스트 파일, 핵심 모듈)을 우선 읽도록 제안
6. 빌드된 그래프가 오래된 경우 `/build-graph --incremental` 실행을 권장합니다.
