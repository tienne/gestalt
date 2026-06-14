# Code Knowledge Graph

코드베이스를 정적 분석해 의존성 그래프를 빌드하고, 변경 영향 파일을 빠르게 추출해 AI 컨텍스트를 절약한다.

저장소: `.gestalt/code-graph.db` (WAL SQLite, EventStore DB와 별도)

---

## `ges_code_graph` MCP 툴

### Actions

| Action | Description |
|--------|-------------|
| `build` | 코드 그래프 빌드 또는 증분 갱신 |
| `blast_radius` | 커밋 기준 영향 파일 분석 |
| `diff_radius` | 미커밋 변경 기준 영향 파일 분석 |
| `query` | 관련 파일 패턴 검색 |
| `stats` | 그래프 통계 조회 |
| `db_exists` | DB 존재 여부 확인 |

### Common Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `action` | `string` | Y | — | 수행할 액션 (위 테이블 참고) |
| `repoRoot` | `string` | Y | — | 저장소 절대 경로 |

---

### `build`

코드 그래프를 빌드한다. 이미 DB가 존재하면 변경된 파일만 증분 갱신한다. `gestalt init` 실행 시 post-commit hook이 설치되어 이후 커밋마다 자동 갱신된다.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `repoRoot` | `string` | Y | — | 저장소 절대 경로 |

#### Example

```javascript
ges_code_graph({ action: "build", repoRoot: "/path/to/repo" })
```

```json
{
  "nodesBuilt": 342,
  "edgesBuilt": 1204,
  "timeTakenMs": 1820,
  "installedHook": true
}
```

---

### `blast_radius`

지정된 커밋 기준으로 변경된 파일과 그 영향을 받는 파일을 분석한다.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `repoRoot` | `string` | Y | — | 저장소 절대 경로 |
| `base` | `string` | N | `"HEAD~1"` | 비교 기준 커밋 참조 |
| `changedFiles` | `string[]` | N | git diff에서 자동 추출 | 분석할 변경 파일 목록 (직접 지정 시 git diff 생략) |
| `maxDepth` | `number` | N | `2` | 의존성 탐색 최대 깊이 |

#### Example

```javascript
ges_code_graph({
  action: "blast_radius",
  repoRoot: "/path/to/repo",
  base: "HEAD~1",
  maxDepth: 2
})
```

```json
{
  "changedFiles": ["src/auth/oauth.ts"],
  "impactedFiles": [
    "src/middleware/auth.ts",
    "src/routes/user.ts",
    "tests/auth.test.ts"
  ],
  "riskScore": 0.62,
  "summary": "1 changed file impacts 3 files. Medium risk."
}
```

---

### `diff_radius`

아직 커밋되지 않은 변경을 기준으로 영향 파일을 분석한다.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `repoRoot` | `string` | Y | — | 저장소 절대 경로 |
| `diffMode` | `"staged" \| "unstaged" \| "all"` | N | `"all"` | 분석 대상 diff 범위 |
| `maxDepth` | `number` | N | `2` | 의존성 탐색 최대 깊이 |

#### Example

```javascript
ges_code_graph({
  action: "diff_radius",
  repoRoot: "/path/to/repo",
  diffMode: "staged"
})
```

```json
{
  "changedFiles": ["src/auth/oauth.ts", "src/config.ts"],
  "impactedFiles": ["src/middleware/auth.ts", "src/app.ts"],
  "riskScore": 0.45,
  "summary": "2 staged files impact 2 files. Low-medium risk."
}
```

---

### `query`

특정 노드와 관계된 파일을 패턴으로 검색한다.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `repoRoot` | `string` | Y | — | 저장소 절대 경로 |
| `pattern` | `"callers_of" \| "callees_of" \| "tests_for" \| "imports_of"` | Y | — | 검색 패턴 |
| `target` | `string` | Y | — | 검색 대상 노드 이름 또는 파일 경로 |

#### Example

```javascript
ges_code_graph({
  action: "query",
  repoRoot: "/path/to/repo",
  pattern: "callers_of",
  target: "validateToken"
})
```

```json
{
  "nodes": [
    { "id": "src/middleware/auth.ts::checkAuth", "type": "function", "file": "src/middleware/auth.ts" },
    { "id": "src/routes/user.ts::getProfile", "type": "function", "file": "src/routes/user.ts" }
  ],
  "edges": [
    { "from": "src/middleware/auth.ts::checkAuth", "to": "src/auth/oauth.ts::validateToken", "type": "calls" }
  ]
}
```

---

### `stats`

코드 그래프 통계를 반환한다.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `repoRoot` | `string` | Y | — | 저장소 절대 경로 |

#### Example

```javascript
ges_code_graph({ action: "stats", repoRoot: "/path/to/repo" })
```

```json
{
  "totalFiles": 87,
  "totalNodes": 342,
  "totalEdges": 1204,
  "lastBuiltAt": "2026-05-31T09:12:00.000Z",
  "dbSizeBytes": 204800
}
```

---

### `db_exists`

코드 그래프 DB가 존재하는지 확인한다. `build` 전에 호출해 증분 갱신 여부를 판단할 때 사용한다.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `repoRoot` | `string` | Y | — | 저장소 절대 경로 |

#### Example

```javascript
ges_code_graph({ action: "db_exists", repoRoot: "/path/to/repo" })
```

```json
{ "exists": true }
```

---

## Execute 파이프라인 자동 컨텍스트 주입

`ges_execute` 호출 시 `codeGraphRepoRoot`를 지정하면 각 태스크 실행마다 관련 파일이 자동으로 추출된다.

```javascript
ges_execute({ action: "start", spec: { /* ... */ }, codeGraphRepoRoot: "/path/to/repo" })
```

동작 순서:
1. 태스크 `title` + `description`에서 키워드 추출 (최대 5개)
2. `searchByKeywords()`로 관련 파일 검색
3. `execute_task` 응답의 `suggestedFiles` 필드로 반환 (최대 10개)

`code-graph.db`가 없거나 검색에 실패하면 `suggestedFiles`는 반환되지 않는다 (graceful fallback).

---

## Skills

| 슬래시 커맨드 | 파일 | 설명 |
|---------------|------|------|
| `/build-graph` | `skills/build-graph/SKILL.md` | 코드 그래프 빌드 및 증분 갱신 |
| `/blast-radius` | `skills/blast-radius/SKILL.md` | 영향 범위 분석 (커밋 기준), 23개 트리거 |
| `/diff-radius` | `skills/diff-radius/SKILL.md` | 영향 범위 분석 (미커밋 기준) |

---

## 지원 언어 플러그인 (8개)

| 언어 | 확장자 | 지원 수준 |
|------|--------|----------|
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx` | 1급 지원 — TypeScript Compiler API 기반 AST 정적 분석. 함수·클래스·타입·import 엣지 완전 추출. |
| Python | `.py` | 정규식 기반 best-effort — 함수·클래스·import 기본 추출. 동적 require·타입 전용 import·매크로 미지원. |
| Go | `.go` | 정규식 기반 best-effort — 함수·클래스·import 기본 추출. 동적 require·타입 전용 import·매크로 미지원. |
| Java | `.java` | 정규식 기반 best-effort — 함수·클래스·import 기본 추출. 동적 require·타입 전용 import·매크로 미지원. |
| Kotlin | `.kt` | 정규식 기반 best-effort — 함수·클래스·import 기본 추출. 동적 require·타입 전용 import·매크로 미지원. |
| Rust | `.rs` | 정규식 기반 best-effort — 함수·클래스·import 기본 추출. 동적 require·타입 전용 import·매크로 미지원. |
| Swift | `.swift` | 정규식 기반 best-effort — 함수·클래스·import 기본 추출. 동적 require·타입 전용 import·매크로 미지원. |
| Objective-C | `.m`, `.h` | 정규식 기반 best-effort — 함수·클래스·import 기본 추출. 동적 require·타입 전용 import·매크로 미지원. |

> **지원 수준 안내**: TypeScript/JavaScript는 컴파일러 API 기반으로 정확한 분석을 제공합니다. 나머지 언어는 정규식 기반 휴리스틱으로, 기본적인 함수·클래스·import 추출은 가능하나 복잡한 패턴(동적 import, 매크로, 메타프로그래밍)은 누락될 수 있습니다.

각 플러그인 인터페이스: `{ language, extensions[], parse(filePath) → { nodes, edges } }`
