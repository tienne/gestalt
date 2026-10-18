# 실행 단계의 diff 기반 드리프트와 태스크 단위 서킷브레이커

## 배경

Execute 단계는 태스크가 끝날 때마다 드리프트를 재지만 재는 대상은 호스트가 제출한 `output` 텍스트다. `measureDrift`는 goal 임베딩 코사인(50%), constraint 키워드 겹침(30%), ontology Jaccard(20%)를 더한다(`src/execute/drift-detector.ts:45-54`). 세 차원 모두 `result.output`만 토큰화한다(`src/execute/drift-detector.ts:78`, `:153`, `:192`). 그래서 이 점수는 에이전트가 무엇을 했다고 말했는지를 잴 뿐이고 실제 코드가 어디를 건드렸는지는 보지 않는다. 출력문에 goal 단어를 잘 섞으면 드리프트가 낮게 나오고 범위를 벗어난 파일을 고쳐도 점수에는 아무 흔적이 남지 않는다.

서버가 코드를 볼 수 있는 자리는 이미 하나 있다. `execute_start` 때 git 작업 트리 기준점을 잡고(`src/execute/orchestrators/execution.ts:457-473`), `completed` 보고의 `artifacts`가 그 뒤로 실제로 바뀌었는지 대조한다(`src/execute/orchestrators/execution.ts:479-510`, `src/execute/artifact-verifier.ts:173-243`). 다만 기준점은 세션당 한 번만 잡는다(`src/execute/session.ts:224-247`, 주석 `src/execute/session.ts:75`). 그래서 앞 태스크가 바꾼 파일을 뒤 태스크가 `artifacts`에 적어도 통과한다. `evolve_re_execute`는 아예 대조하지 않는다(`src/execute/orchestrators/evolution.ts:289-310`). 이 두 한계는 로드맵 기술 부채 표에 이미 적혀 있다(`docs/roadmap.md:230`).

코드 그래프에는 변경 파일에서 역방향 BFS로 영향 범위를 구하는 로직이 있다(`src/code-graph/blast-radius.ts:15-159`). diff-radius 스킬이 쓰는 `codeGraphEngine.diffRadius`가 그 위에 얹혀 있다(`src/code-graph/engine.ts:519-551`). 하지만 이 함수는 `git diff HEAD`로 변경 파일을 고르고 `execSync`로 MCP 프로세스를 막는다. 태스크 단위 diff에는 그대로 쓸 수 없다.

두 번째 문제는 실패 반복이다. 재시도 상한은 LLM 어댑터(`src/llm/retry-adapter.ts:24`)와 Evolve 루프의 hard cap(`src/execute/termination-detector.ts:55`, `src/core/constants.ts:125-126`)에만 있다. 태스크 하나가 연속으로 실패할 때 끊어주는 장치는 없다(`docs/roadmap.md:228`). 실제로 루프가 도는 자리는 세 군데다.

1. `completed` 보고가 대조에 걸리면 결과를 기록하지 않고 같은 태스크를 다시 내라고 돌려보낸다(`src/execute/orchestrators/execution.ts:169-183`, `src/mcp/tools/execute/execution.ts:239-277`). 몇 번째 재제출인지는 세지 않는다.
2. `execute_task`에 같은 `taskId`를 다시 내면 이전 결과를 덮어쓴다(`src/execute/session.ts:249-256`). `failed`를 몇 번 내도 카운트가 남지 않는다.
3. `evolve_re_execute`에서 `failed`를 내면 그 태스크는 완료 집합에 들어가지 않는다. 그래서 `buildNextReExecuteTaskContext`가 같은 태스크를 다시 돌려준다(`src/execute/orchestrators/evolution.ts:598-616`). 서버 쪽에서 무한 루프가 구조적으로 가능한 자리다.

Orca 기반 dispatch 스킬은 "같은 태스크 3회 연속 실패 시 디스패치 중단"을 스킬 문서로만 적어둔다(`plugin/skills/dispatch/SKILL.md:192`). 서버는 이 규칙을 강제하지 않는다.

이 문서는 두 가지를 설계한다. 하나는 태스크별 기준점 위에서 재는 diff 기반 코드 드리프트이고 다른 하나는 taskId별 연속 실패 카운터와 서킷브레이커다.

## 설계

### 파트 0. 공통 전제: 설정 배선

`execute.driftThreshold`는 스키마(`src/core/config.ts:47-51`)와 환경 변수 `GESTALT_DRIFT_THRESHOLD`(`src/core/config.ts:539-541`)에서 읽지만 실제로는 아무 곳에도 전달되지 않는다. 엔진은 설정 없이 만들어지고(`src/mcp/server.ts:143-147`), MCP 핸들러는 임계값 인자 없이 `submitTaskResult`를 부른다(`src/mcp/tools/execute/execution.ts:115`). 그래서 늘 상수 `DRIFT_THRESHOLD = 0.6`(`src/core/constants.ts:117`)이 쓰인다. 문서는 기본값을 0.3이라고 적고 있어 이것도 어긋나 있다(`docs/03-execute.md:226`, `docs/configuration.md:88`).

이번 설계는 새 설정을 여럿 추가한다. 이 배선을 먼저 고치지 않으면 새 설정도 같은 꼴로 죽은 값이 된다. 그래서 `PassthroughExecuteEngine` 생성자가 `ExecuteConfig`를 받게 하고 오케스트레이터에 그대로 내려보낸다. `server.ts`는 `config.execute`를 넘긴다. 이 변경은 첫 PR에 들어간다.

### 파트 1. diff 기반 드리프트

#### 1-1. 태스크별 기준점 (체크포인트)

세션 기준점 하나 대신 체크포인트 열을 둔다. 체크포인트의 모양은 `WorkingTreeBaseline`과 같다(`src/core/types.ts:234-245`). 그래서 `verifyArtifacts`는 손대지 않고 넘기는 기준점만 바꾸면 된다.

```ts
// src/core/types.ts
export type CheckpointReason = 'execution_start' | 'task_recorded' | 're_execution_start';

export interface TaskCheckpoint {
  checkpointId: string;            // cp-0, cp-1 ...
  reason: CheckpointReason;
  baseline: WorkingTreeBaseline;
}

export interface TaskScopeAssignment {
  checkpointId: string;            // 이 태스크가 처음 착수 가능해진 시점의 체크포인트
  scopeFiles: string[];            // 그때 내준 suggestedFiles (repo 상대 경로, 상한 있음)
  assignedAt: string;
}

// ExecuteSession에 추가 (모두 optional — 옛 세션은 비어 있다)
taskCheckpoints?: TaskCheckpoint[];
taskAssignments?: Record<string, TaskScopeAssignment>;
```

흐름은 이렇다.

1. `execute_start`가 지금처럼 기준점을 잡는다. 이 기준점이 `cp-0`(`execution_start`)이 된다. 세션의 `workingTreeBaseline`은 하위 호환을 위해 그대로 둔다.
2. `submitTaskResult`가 결과를 기록한 직후(`completed`, `failed`, `skipped` 모두) `captureWorkingTreeBaseline`을 한 번 더 불러 새 체크포인트를 쌓는다. 이 메서드는 이미 async라서(`src/execute/orchestrators/execution.ts:141`) git을 기다려도 다른 도구 호출을 막지 않는다.
3. 기록 뒤 `nextTaskIds`에 새로 들어온 태스크마다, 아직 배정이 없으면 최신 체크포인트와 그 태스크의 `suggestedFiles`를 `taskAssignments`에 적는다. `suggestedFiles`를 지금 고정해 두는 이유가 있다. 완료 시점에 다시 검색하면 그래프가 바뀌어 결과가 달라진다. 범위 판정은 호스트에게 내준 그 목록을 기준으로 해야 재현된다.
4. `startReExecution`(`src/execute/session.ts:405-416`)은 체크포인트(`re_execution_start`)를 새로 잡는다. 영향받은 태스크의 배정도 이 체크포인트로 다시 적는다. 이것으로 `evolve_re_execute`도 대조할 수 있게 된다(`docs/roadmap.md:230`의 남은 항목).
5. 대조와 코드 드리프트는 태스크 배정의 체크포인트를 기준으로 삼는다. 배정이 없으면(옛 세션, 체크포인트 캡처 실패) 세션 기준점으로 떨어진다. 어느 쪽을 썼는지는 응답의 `baselineScope: 'task' | 'session'`에 드러낸다.

병렬로 착수한 형제 태스크는 같은 체크포인트를 공유한다. 그래서 태스크 T의 diff에는 그사이 끝난 형제의 변경이 섞인다. T의 체크포인트 이후에 기록된 형제의 `artifacts`는 `siblingClaimed` 집합으로 빼고 겹친 형제가 있었다는 사실은 `attribution: 'shared'`로 표시한다. 형제가 아직 안 끝났으면 그 변경은 뺄 수 없다. 이 한계는 열린 질문에 남긴다.

이벤트 크기는 기존 규칙을 따른다. dirty 해시가 `BASELINE_EVENT_DIRTY_LIMIT`(`src/core/constants.ts:106`)를 넘으면 이벤트에는 사유만 남기고 메모리에만 둔다. `memoryOnlyBaselines` 패턴(`src/execute/session.ts:76`, `:232-235`)을 체크포인트 id 키로 넓히면 된다. 새 이벤트는 `EXECUTE_TASK_CHECKPOINT = 'execute.task.checkpoint'`로 정하고 `{ checkpointId, reason, baseline? , baselineSkipped?, assignments: Record<taskId, TaskScopeAssignment> }`를 싣는다. 재구성은 `src/execute/repository.ts`에 case를 하나 추가하면 된다.

#### 1-2. 변경 파일 열거

`verifyArtifacts`는 호스트가 주장한 경로만 본다. 코드 드리프트에는 실제로 바뀐 파일 전체가 필요하다. 그래서 `artifact-verifier.ts`에 함수를 하나 추가한다.

```ts
export async function listChangedSince(
  baseline: WorkingTreeBaseline,
  limit: number,
): Promise<{ files: string[]; truncated: boolean }>;
```

후보는 세 집합의 합이다. 지금의 `git status -z` dirty 경로, 체크포인트의 `dirty` 키, 그리고 HEAD가 움직였으면 `git diff --name-only <cp.head> HEAD`다. 각 후보의 현재 해시를 체크포인트 쪽 해시와 비교한다. 체크포인트 쪽 해시는 dirty에 있으면 그 값을 쓰고 없으면 `cp.head` blob을 쓴다. `verifyArtifacts`가 이미 하는 비교와 같다(`src/execute/artifact-verifier.ts:219-238`). `hashFiles`, `headBlobs`, `parseStatusPaths`, `check-ignore`를 그대로 재사용하고 gitignore에 걸린 경로는 뺀다.

#### 1-3. 코드 드리프트 신호

새 파일 `src/execute/code-drift.ts`가 신호 네 개를 만든다.

```ts
export type CodeDriftDimensionName = 'undeclared' | 'scope' | 'code_ontology' | 'blast';

export interface CodeDriftDimension {
  name: CodeDriftDimensionName;
  score: number; // 0~1, 높을수록 이탈
  detail: string;
}

export type CodeGraphUnavailableReason =
  | 'no_graph'
  | 'locked'
  | 'reindex_pending'
  | 'refresh_failed'
  | 'too_many_files'
  | 'disabled';

export interface CodeDriftSignal {
  status: 'measured' | 'partial' | 'skipped';
  skipped?: 'not_completed' | 'no_code_change' | 'no_baseline' | 'mode_off' | 'error';
  baselineScope: 'task' | 'session';
  attribution: 'exclusive' | 'shared';
  graph: 'used' | 'stale' | 'unavailable';
  graphReason?: CodeGraphUnavailableReason;
  changedFileCount: number;
  undeclaredFiles: string[]; // 상한 CODE_DRIFT_LIST_LIMIT
  outOfScopeFiles: string[];
  missingEntities: string[];
  impactedFileCount?: number;
  blastBudget?: number;
  dimensions: CodeDriftDimension[]; // 잴 수 있었던 것만
  score: number; // 잰 차원의 가중 평균
  truncated?: boolean;
}
```

| 차원            | 계산                                                                                                                                                                                                                                                        | 그래프 필요                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `undeclared`    | diff에 있는데 `artifacts`에도 `siblingClaimed`에도 없는 파일 수 ÷ 변경 파일 수                                                                                                                                                                              | 아니다                                                          |
| `scope`         | 배정 때 고정한 `scopeFiles`를 그래프에서 양방향 1홉 넓힌 집합을 기대 범위로 잡는다. 그 밖의 변경 파일 수 ÷ 변경 파일 수. `scopeFiles`가 비었으면 재지 않는다                                                                                                | 그렇다                                                          |
| `code_ontology` | 태스크 제목과 설명에 이름이 나오는 ontology entity만 대상으로 삼는다. 변경 파일 노드의 심볼 이름(`getNodesByFile`, `src/code-graph/storage.ts:462`)을 camelCase와 snake_case로 쪼개 대조하고 안 걸린 entity 수 ÷ 대상 수로 낸다. 대상이 없으면 재지 않는다 | 선택. 그래프가 없으면 경로 토큰으로만 보고 `partial`로 표시한다 |
| `blast`         | 변경 파일로 `computeBlastRadius`(깊이 2)를 돌려 테스트가 아닌 영향 파일 수를 센다. 태스크 복잡도별 예산(low 10, medium 25, high 60)을 넘는 비율을 0~1로 자른다                                                                                              | 그렇다                                                          |

`undeclared`는 그래프 없이도 잴 수 있고 가장 정직한 신호다. 호스트가 말한 것과 실제로 한 것의 차이를 그대로 보여준다. 처음부터 여기에 무게를 둔다. 가중치는 `undeclared 0.3`, `scope 0.3`, `code_ontology 0.2`, `blast 0.2`로 정하고 잰 차원만으로 다시 정규화한다.

심볼 단위 매핑은 체크포인트 쪽이 HEAD blob인 파일에 한해 `git diff -U0 <cp.head> -- <path>` 헌크를 노드의 `lineStart`, `lineEnd`(`src/code-graph/types.ts:219-220`)에 대응시켜 넓힐 수 있다. 체크포인트에서 이미 dirty였던 파일은 이전 blob이 object DB에 없다(`hash-object`를 `-w` 없이 부른다, `src/execute/artifact-verifier.ts:75`). 그래서 v1은 파일 단위로 하고 심볼 단위는 열린 질문으로 남긴다.

#### 1-4. 그래프 접근과 폴백

- 그래프 루트는 `session.codeGraphRepoRoot ?? baseline.repoRoot`로 정한다. DB가 없으면(`codeGraphEngine.dbExists`, `src/code-graph/engine.ts:722`) 자동으로 빌드하지 않는다. diff-radius 스킬과 같은 원칙이다(`plugin/skills/diff-radius/SKILL.md`의 전제 조건 절). 이때는 `graph: 'unavailable'`, `graphReason: 'no_graph'`로 표시하고 `undeclared`와 경로 기반 `code_ontology`만 잰다. 그래서 `status: 'partial'`이다.
- 질의 전에 `codeGraphEngine.refresh(repoRoot, { maxInlineParse: MAX_INLINE_PARSE, lockTimeoutMs: CODE_DRIFT_LOCK_TIMEOUT_MS })`를 부른다(`src/code-graph/engine.ts:226`, `:122`). 결과가 `stale`이면 이전 그래프로 계속 재고 `graph: 'stale'`로 표시한다. `reindex_pending`이면 MCP 도구 쪽 `refreshBeforeQuery`처럼(`src/mcp/tools/code-graph-passthrough.ts:78-100`) 재색인 요청을 다른 프로세스로 넘긴다. 공용 헬퍼로 빼서 두 자리가 함께 쓰게 한다.
- `blastRadius()`(`src/code-graph/engine.ts:488`)는 co-change 이력 조회를 늘 돌린다(`src/code-graph/engine.ts:564-588`). 태스크마다 돌리기에는 비싸므로 `blastRadius(repoRoot, { changedFiles, maxDepth, coChange: false })`로 끌 수 있게 옵션을 하나 추가한다. `diffRadius()`는 HEAD 기준인 데다 `execSync`라서 쓰지 않는다.

#### 1-5. 비용 상한

better-sqlite3 호출은 동기라서 타이머로 끊을 수 없다. 그래서 상한은 입력 크기에 건다.

| 상수 (`src/core/constants.ts`) | 값                                  | 넘으면                                                                           |
| ------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------- |
| `CODE_DRIFT_MAX_FILES`         | 200                                 | 그래프 차원을 건너뛰고 `graphReason: 'too_many_files'`. `undeclared`는 계속 잰다 |
| `CODE_DRIFT_MAX_SEED_NODES`    | 2,000                               | `blast`를 건너뛴다 (BFS 전에 `getNodesByFile` 합계로 판단)                       |
| `CODE_DRIFT_BLAST_DEPTH`       | 2                                   | —                                                                                |
| `CODE_DRIFT_LOCK_TIMEOUT_MS`   | 500                                 | 락을 못 잡으면 `stale`                                                           |
| `CODE_DRIFT_LIST_LIMIT`        | 20                                  | 응답과 이벤트의 경로 목록을 자르고 `truncated: true`                             |
| `CODE_DRIFT_BLAST_BUDGET`      | `{ low: 10, medium: 25, high: 60 }` | —                                                                                |

git 호출은 기존 `ARTIFACT_GIT_TIMEOUT_MS`(`src/core/constants.ts:104`)를 따른다. 체크포인트 캡처는 태스크 기록 한 번에 git 호출 두세 번이 늘어나는 비용이다. 코드 드리프트 계산은 `completed`이면서 `noCodeChange`가 아닌 결과에만 돈다. 계산 중 예외가 나면 `status: 'skipped'`, `skipped: 'error'`로 떨어뜨리고 태스크 기록은 막지 않는다.

#### 1-6. 텍스트 차원과 합치는 방식

텍스트 차원은 없애지 않는다. `noCodeChange` 태스크(조사, 판단)에는 텍스트 말고 잴 것이 없다. 그리고 의도 정렬은 텍스트가 더 잘 잡는다. 대신 모드를 셋으로 나눈다.

| 모드            | `overall`                                                                                                | 용도                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `off`           | 지금 그대로                                                                                              | 끄기                                                                                                                      |
| `shadow` (기본) | 지금 그대로. `driftScore.code`만 덧붙는다                                                                | 분포 수집. 임계값은 텍스트 척도로 실측해 정한 값이다(`src/core/constants.ts:113-117`). 척도를 섞기 전에 데이터부터 모은다 |
| `blend`         | 코드 신호가 `measured`나 `partial`이면 `textOverall × 0.5 + code.score × 0.5`. `skipped`면 텍스트만 쓴다 | shadow 데이터로 임계값을 다시 잡은 뒤에 켠다                                                                              |

`DriftScore.dimensions`의 이름 유니온(`src/core/types.ts:322-326`)은 건드리지 않는다. 옛 이벤트 replay와 `classifyDrift`(`src/execute/drift-detector.ts:13-24`)가 그대로 돌게 하려는 것이다. 새 필드는 optional로만 붙인다.

```ts
export interface DriftScore {
  // ...기존 필드
  code?: CodeDriftSignal;
  /** blend 모드에서 섞기 전 텍스트 점수 */
  textOverall?: number;
  mode?: 'off' | 'shadow' | 'blend';
}
```

blend 모드에서는 `thresholdExceeded`가 코드 신호를 반영한다. 그러면 `identifyImpactedTasks`의 재실행 대상 선별(`src/execute/impact-identifier.ts:21-25`)에도 코드 드리프트가 따라 들어간다. impact-identifier 코드는 바꾸지 않지만 동작은 바뀐다는 점을 PR 본문에 적는다.

shadow 모드에서도 `undeclaredFiles`가 비어 있지 않으면 응답 `message`에 경고 한 줄을 붙인다. 점수와 무관하게 호스트가 고칠 수 있는 정보이기 때문이다.

#### 1-7. MCP 요청과 응답

요청 스키마는 바뀌지 않는다. 응답만 늘어난다.

`execute_start`

```json
"artifactCheck": { "repoRoot": "...", "baseline": "captured", "taskBaseline": "per_task" }
```

`execute_task`, `evolve_re_execute` (completed 기록 시)

```json
"artifactCheck": "verified",
"baselineScope": "task",
"driftScore": {
  "overall": 0.41, "status": "OK", "mode": "shadow",
  "code": {
    "status": "partial", "graph": "unavailable", "graphReason": "no_graph",
    "baselineScope": "task", "attribution": "exclusive",
    "changedFileCount": 4, "undeclaredFiles": ["src/util/date.ts"],
    "outOfScopeFiles": [], "missingEntities": [],
    "dimensions": [{ "name": "undeclared", "score": 0.25, "detail": "1/4 files changed but not reported" }],
    "score": 0.25
  }
}
```

`evolve_re_execute`는 지금 대조 없이 기록한다. 바꾼 뒤에는 `execute_task`와 같은 `verification_failed` 응답을 돌려준다. 응답을 만드는 `formatVerificationFailure`(`src/mcp/tools/execute/execution.ts:239-277`)는 `nextAction`을 인자로 받게 바꿔 두 핸들러가 함께 쓴다.

이벤트는 `EXECUTE_DRIFT_MEASURED`(`src/execute/session.ts:374-386`) payload에 `driftScore.code`가 함께 실린다. 경로 목록은 이미 상한에서 잘린 상태다.

#### 1-8. 설정

| 키                        | 환경 변수                                       | 기본       |
| ------------------------- | ----------------------------------------------- | ---------- |
| `execute.codeDrift`       | `GESTALT_CODE_DRIFT` (`off`, `shadow`, `blend`) | `shadow`   |
| `execute.codeDriftWeight` | `GESTALT_CODE_DRIFT_WEIGHT` (0~1)               | `0.5`      |
| `execute.taskBaseline`    | `GESTALT_TASK_BASELINE` (`per_task`, `session`) | `per_task` |

`taskBaseline: 'session'`은 이전 동작으로 돌아가는 탈출구다. 태스크별 기준점이 호스트 흐름을 깨는 경우(예: 한 파일을 여러 태스크가 나눠 고치는데 앞 태스크가 이미 다 고쳐버린 경우)에 쓴다.

### 파트 2. 태스크 단위 서킷브레이커

#### 2-1. 실패로 세는 것

| 사건                                          | 센다   | 근거                                                                                 |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `execute_task`의 `status: 'failed'`           | 그렇다 | 기록은 되지만(`src/execute/session.ts:249-256`) 같은 taskId 재제출을 막지 않는다     |
| `completed` 보고의 대조 실패                  | 그렇다 | 기록 없이 돌려보낸다(`src/execute/orchestrators/execution.ts:169-183`)               |
| 대조 중 git 호출 실패(`verification.error`)   | 아니다 | 서버 쪽 실패다. 응답도 그렇게 안내한다(`src/mcp/tools/execute/execution.ts:252-253`) |
| `evolve_re_execute`의 `status: 'failed'`      | 그렇다 | 같은 태스크가 다시 돌아온다(`src/execute/orchestrators/evolution.ts:598-616`)        |
| `evolve_re_execute`의 대조 실패 (파트 1 이후) | 그렇다 | 위와 같다                                                                            |
| 드리프트 `CRITICAL`                           | 아니다 | 이탈 신호이지 실패가 아니다. 재시도를 끊을 근거가 못 된다                            |
| Structural fix, Contextual evolve 반복        | 아니다 | 이미 hard cap이 끊는다(`src/execute/termination-detector.ts:55`)                     |

#### 2-2. 상태와 카운터

카운터는 기존 이벤트에서 파생시킨다. `EXECUTE_TASK_COMPLETED`(status 포함), `EXECUTE_TASK_VERIFICATION_FAILED`(git 실패면 `error` 필드가 있다, `src/execute/orchestrators/execution.ts:611`), `EVOLVE_TASK_COMPLETED`가 있으면 repository replay에서 다시 셀 수 있다. 그러면 옛 세션도 카운터가 맞게 복원된다. 다른 MCP 프로세스(dispatch 워커)가 같은 DB에 쓴 실패도 함께 잡힌다(`src/execute/session.ts:64-70`).

```ts
// src/core/types.ts
export type TaskFailureKind = 'reported_failed' | 'verification_failed';

export interface TaskCircuit {
  taskId: string;
  consecutiveFailures: number;
  lastFailures: Array<{ kind: TaskFailureKind; phase: 'execute' | 're_execute'; at: string }>; // 최근 threshold개
  state: 'closed' | 'open';
  openedAt?: string;
  gateId?: string;
}

// ExecuteSession
taskCircuits?: Record<string, TaskCircuit>;
```

리셋 규칙은 이렇다.

1. 같은 taskId로 `completed`나 `skipped`가 기록되면 0으로 돌아간다. "연속"의 정의가 여기서 나온다.
2. `gate_resolve`에서 `retry_task`를 고르면 0으로 돌아가고 `closed`가 된다.
3. `evolve_patch`나 `evolve_lateral_result`로 스펙이 바뀌어 재실행 대상이 되면, 그 태스크들은 0으로 돌아간다. 스펙이 달라졌으니 이전 실패를 그대로 물려줄 근거가 없다. 이 우회로가 무한히 열리지 않는 이유는 패치 횟수가 `EVOLVE_MAX_CONTEXTUAL`로 묶여 있어서다(`src/core/constants.ts:126`).
4. 다른 태스크의 성공은 리셋하지 않는다. 카운터는 taskId별이다.

#### 2-3. 끊긴 뒤의 동작

`consecutiveFailures`가 임계값에 닿으면 `taskBreakerAction` 설정에 따라 갈라진다.

**`gate` (기본)**: 사람 판단 게이트를 연다. 이미 있는 `awaiting_human` 흐름을 그대로 쓴다. 게이트가 열려 있으면 `status`, `resume`, `gate_resolve`, `evolution_viz` 말고는 모두 거절되고(`src/mcp/tools/execute-passthrough.ts:73-90`), 그 상태는 replay로 복원된다(`src/execute/repository.ts:454-466`).

지금의 `HumanGate`는 lateral 소진 전용이다. `context.triedPersonas`와 `bestScore`가 필수이고(`src/core/types.ts:378-392`), 선택지의 `manual_task`는 `evaluate`로 간다(`src/resilience/lateral.ts:143-147`). 실행 도중에 연 게이트에서 `evaluate`로 보내면 남은 태스크를 건너뛰게 된다. 그래서 게이트에 종류를 두고 선택지를 따로 만든다.

```ts
export type HumanGateKind = 'lateral_exhausted' | 'task_breaker';
export type HumanGateOptionId =
  | 'patch_spec'
  | 'manual_task'
  | 'restart'
  | 'abort'
  | 'retry_task'
  | 'skip_task';

export interface HumanGate {
  kind?: HumanGateKind; // 없으면 lateral_exhausted (옛 이벤트)
  // ...기존 필드
  context: {
    blockedTask?: { taskId: string; title: string };
    triedPersonas: string[]; // task_breaker는 []
    bestScore: number; // task_breaker는 마지막 평가 점수, 없으면 0
    unresolved: string[]; // task_breaker는 최근 실패 사유
    circuit?: TaskCircuit;
    /** 게이트를 닫고 돌아갈 단계. openHumanGate가 evolveStage를 지우므로(src/execute/session.ts:587) 따로 남긴다 */
    resumeStage?: 'executing' | 're_executing';
  };
}
```

`task_breaker` 게이트의 선택지는 다음과 같다.

| `optionId`    | 세션                                                                        | 태스크                                                                                                            | 다음 액션                               |
| ------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `retry_task`  | `executing`으로 돌아간다. 필요하면 `evolveStage: 're_executing'`도 되살린다 | 카운터 0, `closed`                                                                                                | `execute_task` 또는 `evolve_re_execute` |
| `manual_task` | 같다                                                                        | 카운터 유지, `closed`. 사람이 고친 뒤 `completed`로 내면 리셋된다                                                 | 같다                                    |
| `skip_task`   | 같다                                                                        | `status: 'skipped'`로 기록한다. 하위 태스크는 지금처럼 진행한다(`src/execute/orchestrators/execution.ts:426-444`) | 다음 태스크                             |
| `abort`       | `failed`로 끝난다. `terminationReason: 'task_breaker'`                      | —                                                                                                                 | 없음                                    |

`restart`와 `patch_spec`은 이 게이트에 넣지 않는다. 스펙을 고쳐야겠다는 판단이면 `abort`한 뒤 새로 `start`하면 된다. 실행 중에 `evolve_patch`로 들어가는 경로는 지금 상태 머신에 없다(`docs/03-execute.md:66-129`).

`gateOptionResumesSession`(`src/resilience/lateral.ts:169-171`)은 `retry_task`, `skip_task`에도 true를 돌려주게 바꾼다. 게이트 해소 결정은 지금처럼 `.gestalt/memory.json`의 `architectureDecisions`에 `[Escalation:<optionId>]` 꼴로 쌓인다(`src/mcp/tools/execute/evolve.ts`의 `handleGateResolve`).

**`fail`**: Orca와 같은 방식이다. 그 태스크를 `failed`로 확정하고 `open`으로 둔 채 세션을 계속 돌린다. 이후 같은 taskId로 `execute_task`나 `evolve_re_execute`가 오면 기록하지 않고 `task_circuit_open` 오류를 낸다. 다음 태스크 선택에서도 제외한다. 사람이 없는 자동 실행(CI, 벤치마크)을 위한 선택지다.

`TerminationReason`(`src/core/types.ts:347-353`)에는 `'task_breaker'`를 추가한다. `fail` 모드에서 끊긴 태스크가 하나라도 있는 채로 평가까지 가면, 평가 응답에 `openCircuits` 목록을 싣는다.

#### 2-4. 이벤트

카운트 자체는 기존 이벤트에서 파생하므로, 새 이벤트는 상태 전이 두 가지뿐이다.

| 이벤트                                                        | payload                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `EXECUTE_TASK_CIRCUIT_OPENED = 'execute.task.circuit_opened'` | `{ taskId, phase, consecutiveFailures, threshold, action: 'gate' \| 'fail', gateId?, lastFailures }` |
| `EXECUTE_TASK_CIRCUIT_RESET = 'execute.task.circuit_reset'`   | `{ taskId, reason: 'completed' \| 'skipped' \| 'gate_retry' \| 'spec_patched' }`                     |

게이트를 열 때는 기존 `EVOLVE_HUMAN_ESCALATION`도 함께 남긴다. replay가 그 이벤트로 `awaiting_human`을 복원하기 때문이다. 이름이 evolve로 시작하지만 새로 만들지 않는다. 대신 payload에 `gate.kind`가 실린다. 로그는 `logger.warn('execute.task_circuit_opened', ...)`로 남기고 알림은 `gestaltNotify({ event: 'human_escalation' })`(`src/mcp/tools/execute/evolve.ts`의 `formatHumanGate`)를 재사용한다. 알림 문구만 종류에 따라 바꾼다.

#### 2-5. MCP 요청과 응답

요청은 `gateResolution.optionId` enum(`src/mcp/schemas.ts:467-469`)에 `retry_task`, `skip_task`를 추가하는 것뿐이다.

실패를 센 응답에는 카운터를 싣는다. 호스트가 끊기기 전에 알아챌 수 있게 하려는 것이다.

```json
{
  "status": "verification_failed",
  "taskId": "task-003",
  "recorded": false,
  "taskAttempts": { "consecutiveFailures": 2, "threshold": 3, "remaining": 1 },
  "...": "기존 필드"
}
```

`execute_task`에서 `failed`가 기록된 응답(`status: 'executing'`)에도 같은 `taskAttempts`가 붙는다.

끊긴 응답(`gate` 모드)은 이렇다.

```json
{
  "status": "awaiting_human",
  "sessionId": "...",
  "reason": "task_breaker",
  "circuit": { "taskId": "task-003", "consecutiveFailures": 3, "threshold": 3, "lastFailures": [ ... ] },
  "gate": { "gateId": "gate-...", "kind": "task_breaker", "question": "\"로그인 API\" 태스크가 3번 연속 실패했어요. 어떻게 진행할까요?", "options": [ ... ] },
  "nextAction": "gate_resolve",
  "nextActionParams": { "sessionId": "...", "gateResolution": { "gateId": "gate-..." } }
}
```

`fail` 모드는 `status: 'executing'`에 `circuitOpened: { taskId, ... }`를 싣고 다음 태스크 컨텍스트를 그대로 준다. `ges_status`의 사람 판단 대기 요약(`src/mcp/tools/status.ts:224-225`)은 게이트 종류에 따라 문구를 나누고 열린 서킷 수를 함께 보여준다.

#### 2-6. 설정

| 키                                              | 환경 변수                                      | 기본                         |
| ----------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| `execute.taskBreakerThreshold` (정수, 0이면 끔) | `GESTALT_TASK_BREAKER_THRESHOLD`               | `TASK_BREAKER_THRESHOLD = 3` |
| `execute.taskBreakerAction`                     | `GESTALT_TASK_BREAKER_ACTION` (`gate`, `fail`) | `gate`                       |

기본값 3은 Orca와 dispatch 스킬의 규칙(`plugin/skills/dispatch/SKILL.md:192`)에 맞춘 값이다. 상수는 `src/core/constants.ts`의 Evolution Loop 묶음 옆에 둔다.

## 바꿀 파일

| 파일                                                                                                           | 파트    | 변경                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/types.ts`                                                                                            | 1, 2    | `TaskCheckpoint`, `TaskScopeAssignment`, `CodeDriftSignal`, `TaskCircuit`, `HumanGateKind` 추가. `DriftScore`, `HumanGate`, `ExecuteSession`에 optional 필드 추가. `HumanGateOptionId`, `TerminationReason` 확장 |
| `src/core/constants.ts`                                                                                        | 1, 2    | `CODE_DRIFT_*`, `TASK_BREAKER_THRESHOLD` 추가                                                                                                                                                                    |
| `src/core/config.ts`                                                                                           | 0, 1, 2 | `executeConfigSchema`에 새 키 추가, `GESTALT_*` 환경 변수 매핑                                                                                                                                                   |
| `src/mcp/server.ts`                                                                                            | 0       | `config.execute`를 엔진 생성자에 넘김                                                                                                                                                                            |
| `src/execute/passthrough-engine.ts`                                                                            | 0       | 생성자가 `ExecuteConfig`를 받아 오케스트레이터에 전달                                                                                                                                                            |
| `src/execute/artifact-verifier.ts`                                                                             | 1       | `listChangedSince` 추가                                                                                                                                                                                          |
| `src/execute/code-drift.ts` (신규)                                                                             | 1       | 네 차원 계산, 그래프 폴백, 비용 상한                                                                                                                                                                             |
| `src/execute/drift-detector.ts`                                                                                | 1       | `measureDrift`가 모드와 `CodeDriftSignal`을 받아 합성                                                                                                                                                            |
| `src/execute/orchestrators/execution.ts`                                                                       | 0, 1, 2 | 체크포인트 캡처와 배정, 태스크 기준점 대조, 코드 드리프트 호출, 서킷 판정                                                                                                                                        |
| `src/execute/orchestrators/evolution.ts`                                                                       | 1, 2    | 재실행 대조, 재실행 체크포인트, 서킷 판정, `task_breaker` 게이트 해소(`resumeStage` 복원, `skip_task` 기록)                                                                                                      |
| `src/execute/session.ts`                                                                                       | 1, 2    | 체크포인트와 서킷 기록 메서드, 체크포인트용 `memoryOnlyBaselines` 확장                                                                                                                                           |
| `src/execute/repository.ts`                                                                                    | 1, 2    | 새 이벤트 replay, 기존 이벤트로 카운터 파생                                                                                                                                                                      |
| `src/events/types.ts`                                                                                          | 1, 2    | `EXECUTE_TASK_CHECKPOINT`, `EXECUTE_TASK_CIRCUIT_OPENED`, `EXECUTE_TASK_CIRCUIT_RESET`                                                                                                                           |
| `src/resilience/lateral.ts`                                                                                    | 2       | `buildTaskBreakerGate` 추가, `gateOptionResumesSession` 확장                                                                                                                                                     |
| `src/code-graph/engine.ts`                                                                                     | 1       | `blastRadius`에 `coChange: false` 옵션                                                                                                                                                                           |
| `src/mcp/tools/code-graph-passthrough.ts`                                                                      | 1       | `refreshBeforeQuery`를 공용 헬퍼로 분리                                                                                                                                                                          |
| `src/mcp/schemas.ts`                                                                                           | 2       | `gateResolution.optionId` enum 확장                                                                                                                                                                              |
| `src/mcp/tools/execute/execution.ts`                                                                           | 1, 2    | `taskAttempts`, `baselineScope`, `driftScore.code`, 끊긴 응답                                                                                                                                                    |
| `src/mcp/tools/execute/evolve.ts`                                                                              | 1, 2    | 재실행 대조 실패 응답, 게이트 종류별 문구와 힌트                                                                                                                                                                 |
| `src/mcp/tools/status.ts`                                                                                      | 2       | 게이트 종류와 열린 서킷 요약                                                                                                                                                                                     |
| `plugin/skills/execute/SKILL.md`                                                                               | 1, 2    | `execute_task`에서 `awaiting_human`을 받는 경우, `taskAttempts`, `driftScore.code` 읽는 법                                                                                                                       |
| `plugin/skills/dispatch/SKILL.md`                                                                              | 2       | 3회 규칙을 서버가 강제한다고 고침                                                                                                                                                                                |
| `docs/03-execute.md`, `docs/05-evolve.md`, `docs/configuration.md`, `docs/mcp-reference.md`, `docs/roadmap.md` | 전부    | 상태 전이도, 종료 조건, 새 설정, 임계값 0.3과 0.6 불일치 정정, 기술 부채 표 갱신                                                                                                                                 |

## 하위 호환

- 새 세션 필드는 모두 optional이다. 옛 이벤트로 재구성한 세션은 체크포인트가 없으므로 세션 기준점으로 대조한다. 응답의 `baselineScope: 'session'`으로 그 사실이 드러난다.
- 서킷 카운터는 기존 이벤트에서 파생된다. 그래서 진행 중이던 세션도 업그레이드 직후부터 이전 실패를 센다. 업그레이드 순간 이미 3회 이상 실패한 태스크가 있으면 다음 실패 한 번에 바로 끊긴다. 의도한 동작이고 릴리스 노트에 적는다.
- `HumanGate.kind`가 없는 옛 게이트는 `lateral_exhausted`로 읽는다. 선택지와 해소 동작은 지금과 같다.
- `DriftScore.dimensions`는 그대로 세 개다. 기본 `shadow` 모드에서는 `overall`, `status`, `thresholdExceeded`가 지금과 같다. 그래서 `identifyImpactedTasks`의 재실행 선별도 그대로다.
- 태스크별 기준점은 대조를 더 엄격하게 만든다. 앞 태스크가 이미 바꾼 파일만 적던 호스트는 이제 `unchanged`로 걸린다. 이게 고치려는 문제이므로 기본값은 `per_task`로 둔다. 다만 `GESTALT_TASK_BASELINE=session`으로 되돌릴 수 있게 한다.
- `evolve_re_execute`는 이제 대조에 걸리면 기록하지 않는다. 지금 이 경로에 엉터리 `artifacts`를 내던 호스트는 동작이 바뀐다.
- `gate_resolve`의 enum이 늘어나는 것은 추가라서 기존 호출을 깨지 않는다.
- `GESTALT_DRIFT_THRESHOLD`가 실제로 먹기 시작한다. 이 변수를 0.3(문서 기본값)으로 설정해 둔 사용자는 업그레이드 뒤 retrospective가 훨씬 자주 뜬다. 릴리스 노트에 적는다.

## 테스트

테스트 DB는 `.gestalt-test/xxx-${randomUUID()}.db` 규칙을 따른다. git 레포가 필요한 테스트는 기존 `tests/unit/execute/artifact-verifier.test.ts`처럼 임시 레포를 만든다.

| 파일                                                                                     | 확인할 것                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/execute/artifact-verifier.test.ts`                                           | `listChangedSince`가 dirty 추가, 삭제, rename, HEAD 이동(커밋 끼어듦), gitignore 제외, 상한 truncation을 맞게 잡는지                                                                                                                                      |
| `tests/unit/execute/task-checkpoint.test.ts` (신규)                                      | 태스크 A가 바꾼 파일을 태스크 B가 `artifacts`로 내면 `unchanged`로 걸린다. `taskBaseline: 'session'`이면 통과한다. 병렬 형제의 `artifacts`가 `siblingClaimed`로 빠지고 `attribution: 'shared'`가 된다. 대조 실패 뒤 재제출해도 배정 체크포인트가 그대로다 |
| `tests/unit/execute/code-drift.test.ts` (신규)                                           | 그래프 없이 `undeclared`만 재고 `partial`이 된다. 범위 밖 파일 비율. 태스크 설명에 나온 entity만 대상이 된다. 복잡도별 blast 예산. `CODE_DRIFT_MAX_FILES` 초과 시 그래프 차원 생략. refresh가 `stale`이면 `graph: 'stale'`                                |
| `tests/unit/execute/drift-detection.test.ts`                                             | `shadow`는 `overall`이 바뀌지 않는다. `blend` 가중합. `code.status: 'skipped'`면 텍스트만 쓴다. `noCodeChange` 태스크는 코드 신호가 `skipped`                                                                                                             |
| `tests/unit/execute/task-breaker.test.ts` (신규)                                         | `failed` 3번에 게이트가 열린다. 대조 실패 3번에 열린다. git 오류는 세지 않는다. 중간에 `completed`가 오면 리셋된다. 다른 태스크 성공은 리셋하지 않는다. 임계값 0이면 끈다. `fail` 모드는 `task_circuit_open`을 내고 다음 태스크로 넘어간다                |
| `tests/unit/execute/evolution-loop.test.ts`                                              | 재실행에서 `failed` 반복이 이제 3번에 끊긴다(지금은 무한히 같은 태스크가 돌아온다). `retry_task` 뒤 `evolveStage: 're_executing'`가 복원된다. `evolve_patch` 뒤 영향 태스크 카운터가 리셋된다. 재실행 대조 실패                                           |
| `tests/unit/execute/handlers-lateral.test.ts`                                            | `task_breaker` 게이트의 선택지와 `nextAction`. `skip_task`가 `skipped`로 기록된다. 옛 게이트(`kind` 없음)는 동작이 같다                                                                                                                                   |
| `tests/unit/execute/repository.test.ts`, `session-cross-process.test.ts`                 | 새 이벤트 replay. 다른 프로세스가 남긴 실패까지 카운터에 합산된다. 메모리 전용 체크포인트가 재구성 뒤에도 다시 얹힌다                                                                                                                                     |
| `tests/config.test.ts`                                                                   | 새 `GESTALT_*` 변수 매핑과 범위 검증. `driftThreshold`가 엔진까지 전달된다                                                                                                                                                                                |
| `tests/unit/execute/handlers-execute-start.test.ts`, `execution-artifact-verify.test.ts` | 응답의 `taskBaseline`, `baselineScope`, `taskAttempts`, `driftScore.code` 모양                                                                                                                                                                            |

## PR 나누기

1. **`fix(execute): 실행 설정 배선과 태스크 단위 서킷브레이커`**. 파트 0과 파트 2를 묶는다. 로드맵의 "지금" 축에 가깝고 파트 1과 독립적이다. 재실행 무한 루프를 바로 막는다. 설정 배선이 먼저 있어야 임계값을 설정으로 받을 수 있으므로 같은 PR에 둔다.
2. **`feat(execute): 태스크별 작업 트리 기준점과 재실행 대조`**. 파트 1의 1-1과 1-2, 그리고 `evolve_re_execute` 대조다. 로드맵 기술 부채 "실행 완료를 확인 없이 신뢰"의 남은 항목을 닫는다. 서킷브레이커가 재실행 대조 실패를 세는 부분도 여기서 연결한다.
3. **`feat(execute): diff 기반 코드 드리프트 shadow 측정`**. 1-3부터 1-8까지를 `shadow` 기본으로 넣는다. `overall`은 바뀌지 않으므로 리스크가 낮다. `EXECUTE_DRIFT_MEASURED`에 분포가 쌓이기 시작한다.
4. **`feat(execute): 코드 드리프트 blend 모드와 임계값 재조정`**. shadow 데이터와 golden set 벤치마크(`docs/roadmap.md:41`)로 임계값을 다시 잡은 뒤 `blend`를 켤지 정한다. 이 PR은 데이터가 모이기 전에는 열지 않는다.

## 열린 질문

- **게이트가 세션 전체를 멈춘다.** dispatch로 여러 워커가 병렬로 돌 때, 한 태스크가 끊기면 다른 워커의 `execute_task`까지 거절된다(`src/mcp/tools/execute-passthrough.ts:73-90`). 태스크 단위 게이트를 두고 형제 태스크는 계속 받게 할지, 아니면 지금처럼 세션을 멈추는 게 맞는지 정해야 한다. 태스크 단위로 가면 "열린 게이트는 하나"라는 불변식(`src/execute/session.ts:583-584`)을 깨야 한다.
- **실패 태스크의 하위 태스크.** `getCurrentTask`는 실패한 의존을 해결된 것으로 친다(`src/execute/orchestrators/execution.ts:442-444`). 반면 `nextTaskIds`는 완료만 본다(`src/execute/session.ts:268-272`, `computeReadyTaskIds`). 둘이 어긋난다. `fail` 모드로 끊긴 태스크의 하위 태스크를 진행시킬지 막을지 이 PR들에서 정할지, 따로 뗄지 정해야 한다.
- **아직 안 끝난 병렬 형제의 변경.** 형제가 기록되기 전에 T가 끝나면 형제의 변경이 T의 diff에 섞인다. 그러면 `undeclared`와 `scope`가 부풀려진다. 형제가 진행 중이면 `attribution: 'shared'`로만 표시할지, 그 경우 코드 점수를 `partial`로 낮출지 정해야 한다.
- **심볼 단위 매핑.** 체크포인트에서 이미 dirty였던 파일은 이전 내용이 object DB에 없다. 체크포인트를 `hash-object -w`로 잡으면 헌크 매핑이 되지만 호스트 레포 `.git`에 loose object를 쓰는 부작용이 생긴다. 허용할지 정해야 한다.
- **자동 생성 파일.** 포매터, lockfile, 코드 생성기가 건드린 파일이 `undeclared`로 잡힌다. gitignore만으로 충분한지, `pnpm-lock.yaml` 같은 기본 제외 목록과 `gestalt.json` 설정을 둘지 정해야 한다.
- **`scopeFiles`가 키워드 검색 결과라는 점.** 기대 범위를 `searchByKeywords` 상위 10개(`src/execute/orchestrators/execution.ts:539-548`)와 하이브리드 검색(`src/execute/orchestrators/execution.ts:403-418`)으로 잡는다. 이 목록 자체가 빗나가면 `scope`가 거짓 양성을 낸다. shadow 데이터에서 `scope`만 따로 보고 가중치를 정할지, 플래닝 단계에서 태스크별 예상 파일을 받도록 `AtomicTask`를 넓힐지 정해야 한다.
- **blend 가중치와 임계값.** 0.5 대 0.5와 임계값 0.6은 출발점일 뿐이다. 텍스트 척도는 실측으로 정했다(`src/core/constants.ts:113-116`). 코드 척도도 같은 방식으로 정렬 샘플과 이탈 샘플을 모아야 하는데, 그 표본을 golden set 벤치마크에서 낼지 실사용 이벤트에서 낼지 정해야 한다.
- **서킷 임계값을 phase별로 나눌지.** 첫 실행과 재실행을 같은 카운터로 세는데, 재실행은 스펙이 바뀐 뒤라 리셋된다. 재실행 쪽 임계값을 더 낮게(예: 2) 둘 이유가 있는지는 사용 데이터를 보고 정한다.
