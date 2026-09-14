---
name: diff-radius
version: "1.1.0"
description: "커밋 전 미저장 변경과 스테이징 변경의 영향범위를 분석한다. 작업 중인 코드가 어디까지 영향 주는지 바로 확인할 때 자동 발동한다. 이미 고친 변경이 대상이다. 아직 손대지 않은 코드의 영향범위를 미리 보려면 blast-radius를 쓴다."
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
  - rankedFiles
  - coChangeAvailable
  - coChangeReason
  - riskScore
  - summary
---

# Diff Radius Skill

커밋하지 않은 변경의 영향범위를 분석합니다. `/blast-radius`가 커밋 기준이라면, 이 스킬은 **지금 작업 중인 변경** 기준으로 동작합니다.

> **도구가 없을 때** → [`../_shared/tool-availability.md`](../_shared/tool-availability.md)
> `ges_*` 도구가 없거나 호출이 실패하면 직접 흉내내 진행하지 않고 무엇이 왜 안 되는지 말하고 멈춥니다.

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
| `impactedFiles` | import 그래프로만 뽑은 영향 파일 (테스트 파일 우선 정렬) |
| `rankedFiles` | import 신호와 git 이력 신호를 합쳐 출처를 붙인 목록 |
| `coChangeAvailable` | git 이력 신호가 실제로 실렸는지 |
| `coChangeReason` | 이력 신호가 없거나 이웃이 0건일 때 그 사유 |
| `riskScore` | 위험도 점수 0~1 |
| `summary` | 한 줄 요약 |

`rankedFiles` 각 항목의 `origin`은 `both`(import와 이력 양쪽), `history`(이력 전용), `import`(import 전용) 셋이다. `history`는 매니페스트끼리의 약속이나 코드와 그 문서처럼 서로 import하지 않아 파싱으로는 영영 안 잡히는 관계다. 커밋 직전에 "이것도 같이 고쳐야 하지 않나"를 잡아주는 자리라 이 스킬에서 특히 쓸모가 있다.

읽는 규칙은 `/blast-radius`와 같다. 사용자에게 보여줄 목록은 `rankedFiles`다. 테스트 러너 인자처럼 실행 명령에 그대로 넣는 자리에는 `impactedFiles`를 쓴다. 자세한 설명은 [`../blast-radius/SKILL.md`](../blast-radius/SKILL.md)의 "rankedFiles의 출처 표시" 절에 있다.

**`coChangeAvailable: false`면 이력 신호 자체가 안 실린 것이다.** 함께 바뀐 파일이 없다는 뜻이 아니다.

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

**같이 봐야 할 파일** (M개):
- [둘 다]   src/auth.test.ts       import 1홉 + 함께 바뀜 12회
- [이력]    docs/auth-flow.md      함께 바뀜 7회 (import 관계 없음)
- [import]  src/api/routes.ts      2홉

**위험도**: 0.23 (낮음)
**요약**: {summary}
```

`rankedFiles`가 온 순서를 그대로 씁니다. `coChangeAvailable: false`면 목록 아래에 한 줄을 덧붙입니다.

```
ℹ️ git 이력 신호 없이 import 그래프만 본 결과입니다 ({coChangeReason}).
   레포 최상위에서 /build-graph를 다시 돌리면 함께 바뀐 파일까지 잡습니다.
```

`depthExhausted: true`면 위 표시 바로 아래에 한 줄을 덧붙입니다. 빠뜨리지 않습니다.

```
⚠️ 깊이 {maxDepthUsed}에서 탐색이 멈췄고 {unexploredNodes}개 노드가 남았습니다.
   위 목록과 위험도는 하한이며 전부가 아닙니다. 전체를 보려면 maxDepth를 올려 다시 부르세요.
```

5. `rankedFiles` 목록을 컨텍스트로 활용합니다. 20개를 넘으면 읽는 순서를 서브에이전트에 맡깁니다 — 방식은 [`../blast-radius/SKILL.md`](../blast-radius/SKILL.md) 5번과 같습니다. 우선순위를 정하겠다고 세션이 20개 파일을 다 열면 이 스킬을 쓰는 이유가 없어집니다.
6. 변경된 파일이 없으면 "현재 미커밋 변경이 없습니다." 안내합니다.
