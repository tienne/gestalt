# Code Knowledge Graph

코드베이스를 정적 분석해 의존성 그래프를 빌드하고, 변경 영향 파일을 빠르게 추려 AI 컨텍스트를 절약한다.

저장소: `.gestalt/code-graph.db` (WAL SQLite, EventStore DB와 별도)

## ges_code_graph MCP 툴

```
// 그래프 빌드
ges_code_graph({ action: "build", repoRoot: "<절대경로>" })
→ { nodesBuilt, edgesBuilt, timeTakenMs, installedHook }

// Blast-Radius (커밋 기준 영향범위)
ges_code_graph({ action: "blast_radius", repoRoot, base?: "HEAD~1", changedFiles?: [...], maxDepth?: 2 })
→ { changedFiles, impactedFiles, riskScore, summary }

// Diff-Radius (미커밋 변경 기준)
ges_code_graph({ action: "diff_radius", repoRoot, diffMode?: "staged"|"unstaged"|"all", maxDepth?: 2 })
→ { changedFiles, impactedFiles, riskScore, summary }

// 관련 파일 검색
ges_code_graph({ action: "query", repoRoot, pattern: "callers_of"|"callees_of"|"tests_for"|"imports_of", target: "<노드명>" })
→ { nodes, edges }

// 통계
ges_code_graph({ action: "stats", repoRoot })
→ { totalFiles, totalNodes, totalEdges, lastBuiltAt, dbSizeBytes }

// DB 존재 여부
ges_code_graph({ action: "db_exists", repoRoot })
→ { exists: boolean }
```

## Execute 파이프라인 자동 컨텍스트 주입

`ges_execute({ action: "start", spec: {...}, codeGraphRepoRoot: "/path" })` 호출 시 활성화.

태스크 실행 시 자동으로:
1. 태스크 title + description에서 키워드 추출 (`extractKeywords()`, 최대 5개)
2. `searchByKeywords()`로 관련 파일 검색
3. `execute_task` 응답의 `suggestedFiles?: string[]`로 반환 (최대 10개)

code-graph.db 없거나 검색 실패 시 `suggestedFiles: undefined` (graceful fallback).

## 스킬

| 스킬 | 파일 | 설명 |
|------|------|------|
| `/build-graph` | `skills/build-graph/SKILL.md` | 코드 그래프 빌드 및 증분 갱신 |
| `/blast-radius` | `skills/blast-radius/SKILL.md` | 영향범위 분석 (커밋 기준), 23개 트리거 |
| `/diff-radius` | `skills/diff-radius/SKILL.md` | 영향범위 분석 (미커밋 기준) |

## 언어 플러그인 (8개)

TypeScript/JavaScript, Python, Go, Java, Kotlin, Rust, Swift, Objective-C

각 플러그인: `{ language, extensions[], parse(filePath) → {nodes, edges} }`
TypeScript 플러그인은 TypeScript Compiler API 사용 (Tree-sitter 불필요).
