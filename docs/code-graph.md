# Code Knowledge Graph

코드베이스를 정적 분석해 의존성 그래프를 빌드하고, 변경 영향 파일을 빠르게 추출해 AI 컨텍스트를 절약한다.

신호는 둘이다. 소스를 파싱해 얻는 import 그래프가 하나고 git 이력에서 뽑는 co-change(함께 바뀐 파일)가 다른 하나다. 둘은 나란히 쌓이며 서로를 대체하지 않는다 — [git co-change 신호](#git-co-change-신호)를 본다.

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
| `co_change` | git 이력에서 함께 바뀐 파일 조회 |
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

파일 파싱이 끝나면 같은 호출에서 git 이력 co-change도 함께 갱신한다. `repoRoot`가 git 레포 최상위가 아니면 이 단계를 건너뛰고 응답에 `coChange`가 실리지 않는다.

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
  "installedHook": false,
  "embeddingsBuilt": 0,
  "skippedCount": 0,
  "skippedFiles": [],
  "coChange": {
    "pairs": 4597,
    "commitsUsed": 561,
    "commitsScanned": 906,
    "mode": "full"
  }
}
```

`coChange`가 아예 없으면(`undefined`) 수집을 건너뛴 것이다. 페어가 0건인 것과 다르다.

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
| `limit` | `number` | N | `30` | 이력 신호에서 가져올 이웃 수 상한(0~500) |
| `minPairCount` | `number` | N | `3` | 동시등장이 이 미만인 페어는 버린다 |
| `minConfidence` | `number` | N | `0.3` | confidence가 이 미만인 페어는 버린다 |

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
  "rankedFiles": [
    {
      "filePath": "src/middleware/auth.ts",
      "origin": "both",
      "hopDistance": 1,
      "coChangeCount": 12,
      "confidence": 0.71,
      "lift": 8.4,
      "isTest": false
    },
    {
      "filePath": "docs/auth-flow.md",
      "origin": "history",
      "coChangeCount": 7,
      "confidence": 0.54,
      "lift": 11.2,
      "isTest": false
    },
    {
      "filePath": "src/routes/user.ts",
      "origin": "import",
      "hopDistance": 2,
      "isTest": false
    }
  ],
  "coChangeAvailable": true,
  "coChangeTruncated": false,
  "coChangeMatchedCapped": false,
  "coChangeTotalMatched": 2,
  "riskScore": 0.62,
  "depthExhausted": false,
  "unexploredNodes": 0,
  "summary": "Changed 1 file(s) impact 3 file(s) (1 test files, 2 test functions). Risk: HIGH (62.0%). Git history adds 1 file(s) imports cannot see, 1 confirmed by both signals."
}
```

#### 결과 필드

| 필드 | 설명 |
|------|------|
| `impactedFiles` | import 그래프 역방향 BFS 결과. 이력 신호는 여기 안 들어간다 |
| `rankedFiles` | 두 신호를 합쳐 출처를 붙인 목록. `both` → `history` → `import` 순 |
| `coChangeAvailable` | 이력 신호가 실제로 실렸는지 |
| `coChangeReason` | 신호가 없거나 이웃이 0건일 때 그 사유 |
| `coChangeTruncated` | 이력 이웃이 `limit`에 잘렸다. 켜지면 `rankedFiles`의 `history` 항목은 하한이다 — 다만 보인 것은 전체 순위의 상위 접두사다 |
| `coChangeMatchedCapped` | 조회가 질의 단 천장(10,000행)에 걸렸다. `coChangeTruncated`와 사유가 다르다 — 이쪽이 켜지면 접두사 보장이 없고 `coChangeTotalMatched`도 하한이다 |
| `coChangeTotalMatched` | 임계를 통과한 이력 이웃 수. 얼마나 잘렸는지 가늠하는 자리다. `coChangeMatchedCapped`가 꺼져 있을 때만 정확한 수다 |
| `depthExhausted` | `maxDepth`에 걸려 탐색이 멈췄고 갈 곳이 남아 있었다 |
| `unexploredNodes` | 그때 다음 홉에서 기다리던 노드 수 |
| `riskScore` | 위험도 0~1. `depthExhausted`면 하한이다 |

`rankedFiles`의 `origin`은 세 값이다. `both`는 import와 이력 양쪽에 걸린 파일이고 가장 먼저 읽어야 할 파일이다. `history`는 이력에만 걸려 import 그래프가 원리상 못 보는 파일이다. `import`는 import 신호만 있는 파일이다.

---

### `diff_radius`

아직 커밋되지 않은 변경을 기준으로 영향 파일을 분석한다.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `repoRoot` | `string` | Y | — | 저장소 절대 경로 |
| `diffMode` | `"staged" \| "unstaged" \| "all"` | N | `"all"` | 분석 대상 diff 범위 |
| `maxDepth` | `number` | N | `2` | 의존성 탐색 최대 깊이 |
| `limit` | `number` | N | `30` | 이력 신호에서 가져올 이웃 수 상한(0~500) |
| `minPairCount` | `number` | N | `3` | 동시등장이 이 미만인 페어는 버린다 |
| `minConfidence` | `number` | N | `0.3` | confidence가 이 미만인 페어는 버린다 |

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
  "rankedFiles": [
    { "filePath": "src/middleware/auth.ts", "origin": "both", "hopDistance": 1, "coChangeCount": 9, "confidence": 0.6, "lift": 7.1, "isTest": false },
    { "filePath": "schemas/gestalt.schema.json", "origin": "history", "coChangeCount": 3, "confidence": 0.43, "lift": 14.0, "isTest": false }
  ],
  "coChangeAvailable": true,
  "coChangeTruncated": false,
  "coChangeMatchedCapped": false,
  "coChangeTotalMatched": 2,
  "riskScore": 0.45,
  "summary": "Changed 2 file(s) impact 2 file(s) (0 test files, 0 test functions). Risk: MEDIUM (45.0%). Git history adds 1 file(s) imports cannot see, 1 confirmed by both signals."
}
```

결과 필드는 `blast_radius`와 같다.

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
    {
      "id": "function:/path/to/repo:checkAuth",
      "kind": "function",
      "name": "checkAuth",
      "filePath": "/path/to/repo/src/middleware/auth.ts",
      "lineStart": 12,
      "lineEnd": 28,
      "isTest": false,
      "updatedAt": 1780000000000
    }
  ],
  "edges": [
    {
      "id": 41,
      "kind": "CALLS",
      "sourceId": "function:/path/to/repo:checkAuth",
      "targetId": "function:/path/to/repo:validateToken",
      "line": 19,
      "updatedAt": 1780000000000
    }
  ]
}
```

---

### `co_change`

git 이력이 함께 바뀌었다고 말하는 파일을 조회한다. `target`을 주면 그 파일의 이웃을, 생략하면 레포 전체 상위 페어를 돌려준다.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `repoRoot` | `string` | Y | — | 저장소 절대 경로 |
| `target` | `string` | N | — | 기준 파일. 생략하면 레포 전체 상위 페어 |
| `limit` | `number` | N | `30` / `50` | 반환 개수(0~500). `target`이 있으면 `DEFAULT_NEIGHBOR_LIMIT`(30), 없으면 `DEFAULT_PAIR_LIMIT`(50) |
| `minPairCount` | `number` | N | `3` | 동시등장이 이 미만인 페어는 버린다 |
| `minConfidence` | `number` | N | `0.3` | confidence가 이 미만인 페어는 버린다 |

`target`은 절대 경로와 레포 상대 경로를 모두 받는다. 내부 저장은 절대 경로이므로 응답도 절대 경로로 돌아온다.

#### Example

```javascript
ges_code_graph({
  action: "co_change",
  repoRoot: "/path/to/repo",
  target: "src/humanize/index.ts"
})
```

```json
{
  "target": "/path/to/repo/src/humanize/index.ts",
  "neighbors": [
    { "filePath": "/path/to/repo/src/humanize/check.ts", "pairCount": 8, "confidence": 0.67, "lift": 30.4 },
    { "filePath": "/path/to/repo/plugin/role-agents/humanize-monolith/AGENT.md", "pairCount": 6, "confidence": 0.5, "lift": 13.0 }
  ],
  "pairs": [],
  "commitsUsed": 561,
  "commitsScanned": 906,
  "pairsInDb": 4597,
  "totalMatched": 12,
  "truncated": false,
  "matchedCapped": false,
  "available": true
}
```

| 필드 | 설명 |
|------|------|
| `neighbors` | `target`을 준 경우의 이웃 목록 |
| `pairs` | `target`을 생략한 경우의 상위 페어 목록 |
| `commitsUsed` | 필터를 통과해 실제로 센 커밋 수 |
| `commitsScanned` | 읽은 전체 커밋 수 |
| `pairsInDb` | DB에 저장된 전체 페어 수 |
| `totalMatched` | 임계를 통과한 행 수. 하한이 아니라 정확한 수다 — `matchedCapped`가 켜졌을 때만 예외다 |
| `truncated` | 반환 목록이 `limit`에 잘렸는지. 잘려도 돌려준 목록은 전체 순위의 상위 접두사다 |
| `matchedCapped` | 질의가 천장(10,000행)에 걸렸는지. `truncated`와 따로 읽어야 한다 |
| `available` | 수집이 됐는지 |
| `reason` | 결과가 비었을 때 그 사유 |

`available: false`면 수집 자체가 안 된 것이다. `available: true`인데 결과가 비었으면 임계를 넘는 페어가 없거나 경로가 안 맞는 것이다. `pairsInDb`가 그 둘을 가른다.

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
  "lastBuiltAt": 1780000000000,
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

## git co-change 신호

### import이 원리상 못 보는 관계

import 그래프는 소스에 적힌 것만 안다. 매니페스트 JSON끼리의 약속, 코드와 그 코드를 설명하는 문서, 스키마와 그걸 읽는 설정 파일은 서로를 import하지 않으므로 파싱으로는 영영 안 잡힌다.

이 레포로 재보면 강한 페어(동시등장 3회 이상, confidence 0.3 이상) 가운데 양쪽 파일이 워킹트리에 다 남아 있는 것을 실제 그래프의 `IMPORTS_FROM` 엣지와 맞대봤다. **넷 중 셋에는 대응하는 import 엣지가 아예 없다.**

### 측정 스냅숏

이 절의 숫자는 전부 **`c927188` 한 커밋에서 잰 값이다.** 커밋이 쌓이면 함께 움직이므로 이 문서를 읽는 시점의 값과 다르다. 숫자가 밀렸다고 문서가 틀린 게 아니라 스냅숏이 오래된 것이다. 지금 값이 필요하면 직접 재면 된다.

```javascript
ges_code_graph({ action: "build", repoRoot: "<경로>" })   // 응답의 coChange가 커밋 수와 페어 수다
```

개수를 전체 이력에 붙여 읽으면 임계가 무엇 위에서 걸린 건지 어긋난다. 페어 계산의 입력은 전체 이력이 아니라 아래 마지막 단계이고 `confidence`와 `lift`의 분모(`commitsUsed`)도 같은 값이다.

| 단계 | 커밋 수 (`c927188` 기준) |
|---|---|
| `git rev-list --count HEAD` — 전체 | 938 |
| `--no-merges` 적용 | 906 |
| 거기서 파일 2~20개인 커밋만 (`commitsUsed`) | 561 |

같은 커밋에서 전체 페어는 4,597개, 그중 `minPairCount` 기본값(3회)만 통과한 것이 485개, confidence 0.3까지 통과한 강한 페어가 416개다. 강한 페어 중 양쪽이 워킹트리에 남은 것이 400개, 대응 import 엣지가 없는 것이 297개(74%)다.

`src/code-graph/storage.ts`의 인덱스 주석과 이웃 조회 주석도 이 스냅숏의 값을 인용한다. **코드 주석에 실측 숫자를 적을 때는 문서와 같은 꼴로 커밋 sha를 함께 적는다** — 앵커가 없으면 다음 라운드에 또 밀린다.

가장 좋은 예가 이 레포 자신이다. CLAUDE.md에 사람이 손으로 적어둔 "네 매니페스트의 버전 핀을 릴리즈마다 함께 갱신한다"는 규칙을 co-change가 이력에서 그대로 찾아낸다.

```javascript
ges_code_graph({
  action: "co_change",
  repoRoot: "<경로>",
  target: ".claude-plugin/plugin.json"
})
```

```
130회  .claude-plugin/marketplace.json
 45회  plugin/.codex-plugin/plugin.json
 14회  .claude-plugin/.mcp.json
 13회  plugin/mcp.json
```

confidence는 0.81에서 1.0 사이다. 넷 다 JSON이라 import 그래프에는 노드조차 없다. 문서로 관리하던 규칙을 이력이 이미 갖고 있었던 셈이다.

### 스코어링 — 빈도가 아니라 confidence와 lift

동시등장 횟수만으로 세우면 `package.json`이나 락파일처럼 아무 커밋에나 끼는 파일이 늘 맨 위에 온다. 그래서 두 값을 쓴다.

- `confidence = 함께 바뀐 횟수 / 한쪽이 바뀐 횟수` — A가 바뀔 때 B도 바뀔 확률. A→B와 B→A가 다르므로 방향별로 계산하고 큰 쪽을 페어 점수로 쓴다
- `lift = confidence / (상대 파일이 전체 커밋에서 등장하는 비율)` — 우연 대비 몇 배인지. 어디에나 끼는 파일일수록 분모가 커져 점수가 눌린다

랭킹 키는 `confidence * lift`다. 보고되는 confidence는 소수 둘째 자리, lift는 첫째 자리에서 반올림한다. `co_change` 응답과 `rankedFiles`가 같은 값을 보고 같은 순서로 서도록 반올림한 값으로 랭킹까지 매긴다.

실제로 눌리는 걸 확인한 예다.

```
src/humanize/index.ts 의 이웃
  8회  conf 0.67  lift 30.4  src/humanize/check.ts
  6회  conf 0.50  lift 13.0  plugin/role-agents/humanize-monolith/AGENT.md
  4회  conf 0.24  lift  3.3  package.json          ← 흔한 파일이라 눌렸다
```

`package.json`은 네 번이나 함께 바뀌었지만 confidence 0.24로 기본 임계 0.3에 걸려 실제 조회 결과에는 나오지 않는다.

### 무엇을 세고 무엇을 버리나

| 규칙 | 상수 | 이유 |
|------|------|------|
| 한 커밋이 파일 21개 이상을 건드리면 통째로 제외 | `MAX_FILES_PER_COMMIT = 20` | 릴리즈나 일괄 포맷팅 커밋 하나가 그 안의 모든 파일을 서로 연결해버린다. 이 레포는 커밋당 변경 파일 중앙값이 2인데 최대가 135다 |
| 파일이 하나뿐인 커밋 제외 | `MIN_FILES_PER_COMMIT = 2` | 페어를 만들 수 없다 |
| 동시등장 3회 미만 제외 | `MIN_PAIR_COUNT = 3` | 우연으로 본다 |
| confidence 0.3 미만 제외 | `DEFAULT_MIN_CONFIDENCE = 0.3` | 한쪽이 바뀔 때 열에 셋도 안 따라오면 같이 읽을 이유가 약하다 |
| merge 커밋 제외 | `git log --no-merges` | 머지 커밋의 파일 목록은 함께 고친 흔적이 아니다 |

임계 셋은 `minPairCount`와 `minConfidence`로 낮출 수 있다. `co_change`뿐 아니라 `blast_radius`와 `diff_radius`도 같은 파라미터를 받는다. 이력 신호를 쓰는 세 액션이 같은 튜닝 면을 공유한다. 반환 개수 상한은 `limit`이고 기본값은 `DEFAULT_NEIGHBOR_LIMIT`(30)과 `DEFAULT_PAIR_LIMIT`(50)이다. 두 임계는 질의가 걸고 `limit`은 랭킹을 다 세운 뒤 걸린다. 커밋 21개 경계는 상수라 코드를 고쳐야 바뀐다.

`minConfidence`는 반올림 전 값에 걸린다. 응답의 `confidence`는 소수 둘째 자리까지 보여주므로 0.30으로 보이는 페어의 원값이 0.296일 수 있고 그건 `minConfidence: 0.3`을 통과하지 못한다.

삭제되거나 이름이 바뀐 파일은 이력에만 남는다. 이런 경로는 **조회 시점에** 워킹트리 존재 여부로 거른다. 수집에서 빼면 그 파일이 살아 있던 시절의 solo 카운트가 함께 깎여 남은 파일들의 confidence가 부풀기 때문이다.

### 수집과 갱신

`build`가 파일 파싱을 끝낸 뒤 `git log --format=%H --name-only --no-merges`를 한 번 읽어 페어를 센다. 파일마다 git을 부르지는 않는다. [같은 스냅숏](#측정-스냅숏)에서 merge를 뺀 906커밋을 읽는 데 41ms가 걸렸고 그중 파일 2~20개인 561커밋에서 4,597페어가 나왔다. 줄어드는 단계는 앞 절의 표에 적어뒀다.

증분 빌드는 `cg_cochange_meta`에 적힌 이전 HEAD가 지금 HEAD의 조상이면 그 사이 구간만 읽어 카운터에 더한다. HEAD가 그대로면 `git log`를 아예 안 읽는다. post-commit 훅이 부르는 자리라 수백 ms를 넘기면 안 되기 때문이다. rebase나 amend, shallow clone으로 이전 기준점에 못 닿으면 경고를 남기고 전량 재수집으로 내린다.

점수는 저장하지 않고 조회할 때 계산한다. lift 분모가 사용 커밋 수라서 커밋 하나만 더 반영해도 저장된 점수가 전부 무효가 된다. 원시 카운트만 두면 증분 갱신이 덧셈으로 끝난다.

테이블은 `cg_cochange`(페어 카운트), `cg_cochange_solo`(파일별 등장 횟수), `cg_cochange_meta`(기준 HEAD와 커밋 수) 셋이다. 기존 `cg_nodes`와 `cg_edges`는 손대지 않았다. co-change는 파일 단위 무방향 페어고 `cg_edges`는 노드 단위 방향 엣지라 성격이 다르다.

`repoRoot`가 git 레포 최상위가 아니면 수집을 통째로 건너뛴다. 하위 디렉토리를 넘기면 `git log`가 부모 레포의 전체 이력을 끌어오기 때문이다.

### `impactedFiles`와 `rankedFiles`는 다르다

이력 신호는 `rankedFiles`에만 실린다. `impactedFiles`는 import 신호만 담은 채로 남는다.

`impactedFiles`를 받아 `.test.`나 `.spec.`, `__tests__`로 걸러 테스트 러너 인자로 그대로 넘기는 자리가 있다(`src/execute/orchestrators/evaluation.ts`). 이력에만 걸린 md나 json이 거기 섞이면 vitest 인자가 오염된다. 그래서 두 목록을 나눠 뒀다.

- `impactedFiles` — import 그래프 역방향 BFS 결과. 테스트 러너 인자로 그대로 써도 되는 목록
- `rankedFiles` — 두 신호를 합쳐 출처를 붙인 목록. 사람과 에이전트가 읽을 순서를 정하는 자리

혼동하면 조용히 깨진다. 사용자에게 보여줄 땐 `rankedFiles`를 쓴다. 명령줄에 넣을 땐 `impactedFiles`를 쓴다.

### `coChangeAvailable` — 0건과 미수집을 가른다

`rankedFiles`에 `history` 항목이 하나도 없을 때, 그게 "함께 바뀐 파일이 없다"인지 "이력 신호가 아예 안 실렸다"인지 구분해야 한다. 구분이 없으면 조용한 0건이 된다. 경로 표기가 어긋나 조인이 전부 빗나가도 결과는 똑같이 비어 보인다.

- `coChangeAvailable: false` — 수집 자체가 안 됐다. git 레포가 아니거나, `repoRoot`가 레포 최상위가 아니거나, 아직 빌드를 안 돌렸다
- `coChangeAvailable: true`인데 `history`가 0건 — 이력은 있는데 이 파일만 안 걸렸다. `coChangeReason`이 사유를 말한다. `co_change` 응답의 `pairsInDb`를 함께 보면 경로 불일치인지 가릴 수 있다

`summary` 문구도 갈라 쓴다. 수집이 안 됐으면 `Git history signal unavailable (import graph only).`가 붙는다. 실렸으면 `Git history adds N file(s) imports cannot see, M confirmed by both signals.`가 붙는다.

### 잘린 이력은 잘렸다고 말한다

이웃이 `limit`보다 많으면 `coChangeTruncated`가 켜지고 `summary`에 이 문장이 따라붙는다.

```
History neighbors are a lower bound: showing the top N of M match(es). Raise limit to see more.
```

`depthExhausted`가 import 신호를 두고 하는 말과 같은 자리다. 이 표식이 없으면 이웃 40개 중 30개만 받아놓고 그게 전부라고 읽게 된다.

**`M`은 하한이 아니라 정확한 수고 보인 `N`개는 그 `M`의 상위 `N`개다.** 자르는 자리가 랭킹을 다 세운 뒤 한 곳뿐이라 그렇다. 개수로 먼저 줄이고 점수로 다시 세우면 이 말이 성립하지 않는다 — 랭킹 키가 confidence × lift인데 `pair_count` 순으로 먼저 자르면 카운트는 낮고 점수는 높은 페어가 통째로 빠진다.

대신 두 임계(`minPairCount`, `minConfidence`)를 질의로 내려 조회가 읽는 행을 줄인다. 임계는 개수와 달리 손실이 없다 — 어차피 결과에서 뺄 행을 애초에 안 뜨는 것뿐이다. 조회 비용은 임계를 통과한 행 수에 비례하므로 임계를 0으로 내리면 그만큼 더 읽는다. [스냅숏 기준](#측정-스냅숏)으로 기본 임계에서는 seed당 최대 22행, 전역 페어 416행이고 임계를 둘 다 0으로 내리면 seed당 최대 133행, 전역 4,597행이다.

### 천장 — 임계가 0이어도 읽는 행은 유한하다

두 임계는 외부 입력이고 둘 다 0을 받는다. 둘 다 0이면 조회가 페어 테이블 전체를 뜬다. `limit`은 랭킹을 다 세운 뒤에 걸리므로 읽는 행도, 워킹트리 존재 확인(`stat`)이 도는 횟수도 못 막는다. 그래서 질의에 절대 천장을 하나 뒀다.

**`MAX_MATCHED_ROWS`는 10,000행이고 `exists` 확인과 점수 계산보다 앞, SQL 안에 있다.** 뒤에 두면 stat은 이미 다 돈 뒤라 막을 것이 없다.

정상 질의는 이 선에 못 닿는다. 이 레포는 임계를 둘 다 0으로 내려 전량을 떠도 4,597행이다. 출력 상한인 `limit`의 최대값(500)과 비교하면 20배다. 천장이 사용자가 보는 목록을 결정하는 자리가 되면 안 된다는 뜻이다.

닿았으면 `matchedCapped`(blast-radius와 diff-radius에서는 `coChangeMatchedCapped`)가 켜지고 `summary`에 다른 문장이 붙는다.

```
History neighbors hit the 10000-row query ceiling: showing N of at least M match(es), and the list is not a ranked prefix. Raise minPairCount or minConfidence to get an exact ranking.
```

`truncated`와 갈라 쓰는 이유가 셋이다.

- **사유가 다르다.** `truncated`는 랭킹을 다 세운 뒤 `limit`이 자른 것이고 `matchedCapped`는 점수를 매기기도 전에 행 수로 걸린 것이다
- **접두사 보장이 다르다.** `truncated`만 켜졌으면 보인 목록은 여전히 전체 순위의 상위 접두사다. `matchedCapped`가 켜지면 아니다 — 천장은 점수가 아니라 행을 읽은 순서로 걸린다
- **손잡이가 다르다.** `truncated`는 `limit`을 올려서 푼다. `matchedCapped`는 `limit`으로는 안 풀린다. 임계를 올려야 한다

`matchedCapped`가 켜지면 `totalMatched`도 정확한 수가 아니라 하한이 된다. 둘이 함께 켜질 수도 있는데 그때 `summary`는 천장 쪽을 말한다 — `limit`을 올리라고 안내하면 사용자가 시킨 대로 해도 같은 자리에 다시 선다.

### 한계

이력이 신호의 전부다. 이력이 없으면 아무것도 못 낸다. 갓 만든 레포, 커밋이 수십 개인 레포, squash로 히스토리를 접어버린 레포에서는 임계(3회, confidence 0.3)를 넘는 페어가 거의 안 나온다. 그런 곳에서는 import 그래프가 사실상 유일한 신호다. `coChangeAvailable`이 true인데도 이웃이 비어 있는 게 정상이다.

커밋을 잘게 쪼개 쓰는 레포일수록 신호가 좋다. 반대로 기능 하나를 커밋 하나에 몰아넣는 레포는 대형 커밋 필터에 많이 걸려 쓸 수 있는 커밋이 줄어든다. 도입 직후에 약한 건 고장이 아니라 이력이 아직 안 쌓인 것이다.

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
