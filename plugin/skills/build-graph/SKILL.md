---
name: build-graph
version: "1.1.0"
description: "Build a code knowledge graph for the current repository to enable blast-radius analysis. Graph build only. For first-time project setup — gestalt.json, the post-commit hook, and the graph together — use setup instead."
triggers:
  - "build graph"
  - "build-graph"
  - "index codebase"
  - "build code graph"
inputs:
  repoRoot:
    type: string
    required: false
    description: "Repository root path (defaults to current working directory)"
  include:
    type: string[]
    required: false
    description: "Glob patterns to include (default: **/*)"
  exclude:
    type: string[]
    required: false
    description: "Glob patterns to exclude"
  mode:
    type: string
    required: false
    description: "Build mode: 'full' (default) or 'incremental' (hash-based, skip unchanged files)"
outputs:
  - nodesBuilt
  - edgesBuilt
  - timeTakenMs
  - coChange
---

# Build Graph Skill

코드베이스를 정적 분석해 코드 지식 그래프를 빌드합니다. 이 그래프를 바탕으로 `/blast-radius` 스킬을 사용할 수 있습니다.

> **도구가 없을 때** → [`../_shared/tool-availability.md`](../_shared/tool-availability.md)
> `ges_*` 도구가 없거나 호출이 실패하면 직접 흉내내 진행하지 않고 무엇이 왜 안 되는지 말하고 멈춥니다.

## 목적

코드 지식 그래프는 파일, 함수, 클래스 사이의 의존 관계를 SQLite DB(`.gestalt/code-graph.db`)에 저장합니다. 한 번 빌드해두면 `blast-radius` 분석으로 변경 영향 파일만 빠르게 조회할 수 있어 불필요한 파일 읽기를 크게 줄일 수 있습니다.

빌드는 신호를 둘 만듭니다. 하나는 소스를 파싱해 얻는 import 그래프이고 다른 하나는 `git log`를 한 번 읽어 세는 co-change(함께 바뀐 파일)입니다. co-change는 파일 확장자를 가리지 않으므로 언어 플러그인이 못 읽는 JSON이나 Markdown도 신호에 잡힙니다. 매니페스트끼리의 약속이나 코드와 그 코드를 설명하는 문서처럼 서로 import하지 않는 관계가 여기서 드러납니다.

**co-change 수집은 `repoRoot`가 git 레포 최상위일 때만 돕니다.** 하위 디렉토리를 넘기면 `git log`가 부모 레포의 전체 이력을 끌어오므로 아예 건너뜁니다.

## 지원 언어

TypeScript / JavaScript, Python, Go, Java, Kotlin, Rust, Swift, Objective-C

co-change는 언어와 무관하게 git이 추적하는 모든 파일에 걸립니다.

## 실행 방법

### 기본 (전체 빌드)

```
ges_code_graph {
  action: "build",
  repoRoot: "<현재 디렉토리 절대 경로>"
}
```

### 증분 빌드 (변경 파일만 재파싱)

```
ges_code_graph {
  action: "build",
  repoRoot: "<현재 디렉토리 절대 경로>",
  mode: "incremental"
}
```

### 특정 디렉토리만 포함

```
ges_code_graph {
  action: "build",
  repoRoot: "<경로>",
  include: ["src/**", "lib/**"],
  exclude: ["**/*.test.ts", "dist/**"]
}
```

## 빌드 후 통계 확인

```
ges_code_graph {
  action: "stats",
  repoRoot: "<경로>"
}
```

## 결과 해석

| 필드 | 설명 |
|------|------|
| `nodesBuilt` | 인덱싱된 노드 수 (파일·함수·클래스·타입) |
| `edgesBuilt` | 인덱싱된 엣지 수 (호출·임포트·상속·포함 관계) |
| `timeTakenMs` | 소요 시간 (밀리초) |
| `skippedCount` | 읽거나 파싱하지 못해 그래프에서 빠진 파일 수 |
| `skippedFiles` | 그중 앞 20개의 경로와 사유 (진단용) |
| `coChange` | git 이력 co-change 수집 결과. `pairs`(페어 수), `commitsUsed`(필터를 통과해 실제로 센 커밋), `commitsScanned`(읽은 전체 커밋), `mode`(`full` 또는 `incremental`) |

**`coChange`가 응답에 아예 없으면 수집을 건너뛴 것이다.** 페어가 0건인 것과 다르다. `repoRoot`가 git 레포 최상위가 아니거나 git 레포가 아닌 경우다. 이대로 두면 이후 `/blast-radius`가 import 신호만 보고 `coChangeAvailable: false`를 계속 돌려준다.

`commitsUsed`가 `commitsScanned`보다 한참 작은 건 정상이다. 파일이 하나뿐인 커밋과 21개 이상을 건드린 커밋은 신호에서 빠진다 — 릴리즈나 일괄 포맷팅 커밋 하나가 그 안의 모든 파일을 서로 연결해버리는 걸 막기 위해서다. 자세한 임계는 게슈탈트 레포의 `docs/code-graph.md`에 있다.

**`skippedCount`가 0이 아니면 반드시 사용자에게 알린다.** 이 파일들은 그래프에 없으므로 이후 `/blast-radius`가 영향 범위에서 영영 누락한다. 깊이 상한과 달리 파라미터를 올려도 되살아나지 않는다 — 파싱이 실패한 원인을 고쳐 다시 빌드하는 수밖에 없다.

## Skill Instructions

1. `repoRoot`가 주어지지 않으면 현재 작업 디렉토리(`cwd`)를 절대 경로로 사용합니다.
2. `ges_code_graph { action: "build", repoRoot: "<repoRoot>", mode: "<mode>" }`를 호출합니다.
3. 빌드 결과를 사용자에게 표시합니다. `coChange`가 실려 있으면 한 줄로 함께 알립니다.

```
git 이력: {coChange.commitsUsed}개 커밋에서 {coChange.pairs}개 페어 ({coChange.mode})
```

`coChange`가 없으면 아래 줄을 덧붙입니다.

```
ℹ️ git 이력 신호를 수집하지 못했습니다. repoRoot가 git 레포 최상위인지 확인하세요.
   이대로면 /blast-radius가 import 관계만 봅니다.
```

`skippedCount`가 0이 아니면 아래 줄을 빠뜨리지 않고 덧붙입니다.

```
⚠️ {skippedCount}개 파일이 그래프에서 빠졌습니다 (읽기·파싱 실패).
   이 파일들은 영향범위 분석에 잡히지 않습니다: {skippedFiles의 경로와 사유}
```

4. "그래프 빌드 완료! 이제 `/blast-radius`로 변경 영향 파일을 분석할 수 있습니다." 안내를 포함합니다. `ges_code_graph { action: "co_change", repoRoot: "<repoRoot>", target: "<파일>" }`로 특정 파일과 늘 함께 바뀌어온 파일만 따로 볼 수도 있다는 것도 함께 알립니다.
5. 오류가 발생하면 오류 내용을 표시하고 지원 언어인지 확인하도록 안내합니다.
