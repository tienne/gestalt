---
name: build-graph
version: "1.0.0"
description: "Build a code knowledge graph for the current repository to enable blast-radius analysis"
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
---

# Build Graph Skill

코드베이스를 정적 분석해 코드 지식 그래프를 빌드합니다. 이 그래프를 바탕으로 `/blast-radius` 스킬을 사용할 수 있습니다.

## 목적

코드 지식 그래프는 파일·함수·클래스 사이의 의존 관계를 SQLite DB(`.gestalt/code-graph.db`)에 저장합니다. 한 번 빌드해두면 `blast-radius` 분석으로 변경 영향 파일만 빠르게 조회할 수 있어 불필요한 파일 읽기를 크게 줄일 수 있습니다.

## 지원 언어

TypeScript / JavaScript, Python, Go, Java, Kotlin, Rust, Swift, Objective-C

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

## Skill Instructions

1. `repoRoot`가 주어지지 않으면 현재 작업 디렉토리(`cwd`)를 절대 경로로 사용합니다.
2. `ges_code_graph { action: "build", repoRoot: "<repoRoot>", mode: "<mode>" }`를 호출합니다.
3. 빌드 결과를 사용자에게 표시합니다.
4. "그래프 빌드 완료! 이제 `/blast-radius`로 변경 영향 파일을 분석할 수 있습니다." 안내를 포함합니다.
5. 오류가 발생하면 오류 내용을 표시하고 지원 언어인지 확인하도록 안내합니다.
