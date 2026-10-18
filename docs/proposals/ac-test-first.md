# AC 테스트 우선 실행과 AC별 테스트 연결 평가

## 배경

### 현재 동작

**플래닝은 AC를 인덱스로만 안다.** `Spec.acceptanceCriteria`는 `string[]`이다(`src/core/types.ts:99`). 태스크는 `sourceAC: number[]`로 AC를 가리키고 `isImplicit`, `dependsOn`, `model`을 함께 가진다(`src/core/types.ts:150-164`). 이 AC를 어떻게 검증할지 적는 자리는 어디에도 없다.

**태스크는 호스트가 closure 단계에서 만들고 서버는 나중에 검증한다.** closure 프롬프트는 `task-0`, `task-1` 꼴의 태스크를 JSON으로 내라고 한다(`src/execute/prompts.ts:99-139`). 테스트를 먼저 쓰라는 규칙은 없다. 서버는 다음을 확인한다.

- 태스크 수 상한(`MAX_ATOMIC_TASKS = 100`, `src/core/constants.ts:94`)
- taskId 중복, sourceAC 범위, dependsOn 참조(`src/execute/orchestrators/planning.ts:301-347`)

서버는 호스트가 보고한 continuity를 믿지 않는다. closure 결과와 proximity 결과로 DAG를 직접 다시 계산한다(`src/execute/orchestrators/planning.ts:72-75`). `plan_complete`는 그 DAG를 한 번 더 확인한다. 그다음 `assignModelHints`와 `computeParallelGroups`를 돌려 계획을 조립한다(`src/execute/orchestrators/planning.ts:211-237`). DAG 검증은 모든 태스크가 어느 그룹에 속해야 통과한다(`src/execute/dag-validator.ts:52`). 병렬 레이어는 의존이 없는 태스크를 0층에 놓는다(`src/execute/parallel-groups.ts:65-92`).

**서버는 명령을 직접 돌리지 않는다.** Passthrough 설계상 실행은 호스트가 한다(`CLAUDE.md` 설계 전제). 서버가 직접 하는 일은 `execute_start` 때 git 작업 트리 기준점을 잡는 것이다(`src/execute/orchestrators/execution.ts:457-473`). 완료 보고가 오면 `artifacts`가 그 뒤로 실제로 바뀌었는지 git blob 해시로 대조한다(`src/execute/artifact-verifier.ts:7-8`, `src/execute/orchestrators/execution.ts:479-510`). 대조에 실패하면 결과를 기록하지 않는다. 대신 `verification_failed`를 돌려주고 다시 제출하게 한다(`src/execute/orchestrators/execution.ts:169-183`, `src/mcp/tools/execute/execution.ts:239-276`).

**Structural 평가는 lint, build, test가 통과하는지만 본다.** 서버는 package.json과 lockfile을 보고 명령 문자열을 만든다. 이때 test는 스크립트가 없어도 남긴다(`src/execute/structural-commands.ts:86-99`). blast-radius가 찾은 테스트 파일이 있으면 test 명령을 그 파일들로 좁힌다(`src/execute/orchestrators/evaluation.ts:51-52`, `src/execute/orchestrators/evaluation.ts:223-243`). 호스트가 결과를 내면 서버는 요청한 명령과 문자열이 같은지 대조한다(`src/execute/orchestrators/evaluation.ts:105-112`, `src/execute/structural-commands.ts:146-161`). 호스트가 보고한 `allPassed`보다 종료 코드를 우선하고 하나라도 실패하면 short-circuit한다(`src/execute/orchestrators/evaluation.ts:114-138`).

**AC별 충족 판정은 전부 호스트 LLM의 판단이다.** contextual 프롬프트에 들어가는 것은 lint, build, test 각각의 PASS/FAIL과 태스크 output 요약뿐이다(`src/execute/prompts.ts:401-456`). `overallScore`도 호스트가 계산한다. 서버는 0과 1 사이인지와 모든 AC 인덱스가 빠짐없이 있는지만 확인한다(`src/execute/orchestrators/evaluation.ts:178-201`). 이 점수는 그대로 다음 두 곳에 들어간다.

- 성공 판정(`src/mcp/tools/execute/evaluate.ts:68-71`)
- 종료 조건(`src/execute/termination-detector.ts:41-44`, `src/execute/orchestrators/evolution.ts:139-145`)

**Evolve는 AC 문장과 gaps만 보고 패치를 만든다.** 진화 프롬프트는 `satisfied: false`인 AC의 문장과 `gaps`를 나열한다(`src/execute/prompts.ts:572-632`). 재실행 대상은 두 기준으로 고른다(`src/execute/impact-identifier.ts:12-53`).

- drift가 높았던 태스크
- AC 필드가 바뀌었을 때 sourceAC가 있는 태스크 전부

AC 문장은 그대로인데 테스트만 없는 경우가 있다. 그러면 패치가 AC를 건드리지 않고 재실행 대상이 비어 재평가만 반복된다.

**설정은 엔진까지 오지 않는다.** `executeConfigSchema`에는 threshold 세 개만 있다(`src/core/config.ts:47-51`). 엔진은 config 없이 생성된다(`src/mcp/server.ts:143-147`).

### 문제

- "AC를 테스트로 증명했다"는 사실을 서버가 확인할 방법이 없다. test 스크립트가 통과해도 그 안에 AC를 검증하는 테스트가 있는지는 모른다.
- 구현이 먼저 오고 테스트는 구현 태스크 안에 섞인다. 그래서 테스트가 구현을 따라 쓰이고 실패하는 상태를 한 번도 거치지 않는다.
- contextual 점수가 LLM 자기 보고라서 근거 없이 0.85를 넘을 수 있다.

### 전제

AC 구조화 PR이 다음 계약을 먼저 추가한다고 가정한다.

```ts
type AcVerifyBy = 'test' | 'command' | 'manual';
interface AcceptanceCriterion {
  id: string; // "AC-1"
  criterion: string;
  verifyBy: AcVerifyBy;
  check?: string; // 테스트 이름이나 패턴, 또는 셸 명령
}
```

이 문서는 다음을 더 가정한다.

- `Spec.acceptanceCriteria`가 `AcceptanceCriterion[]`가 된다. 배열 순서가 기존 인덱스와 같다.
- 옛 문자열 AC는 그 PR의 정규화 함수가 `verifyBy: 'manual'`로 올린다.
- `sourceAC: number[]`와 `ACVerification.acIndex`는 그대로 인덱스를 쓴다. id는 `acceptanceCriteria[i].id`로 찾는다.

## 설계

### 결정 요약

| 질문                                 | 결정                                                                                                             | 이유                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 테스트 태스크는 누가 넣나            | `plan_complete`에서 서버가 넣는다                                                                                | DAG를 서버가 다시 계산하는 기존 원칙(`planning.ts:72`)과 맞는다. 프롬프트로 부탁하면 빠뜨려도 잡을 방법이 없다 |
| 실패하는 상태(red)는 어떻게 확인하나 | 서버가 명령 문자열을 정하고 호스트가 돌려 종료 코드를 보고한다. 서버는 문자열과 종료 코드, 출력 패턴을 대조한다 | structural 평가와 같은 신뢰 모델이다. 서버가 직접 실행하면 Passthrough 전제가 깨진다                           |
| 켜는 방법                            | `start`의 `testFirst` 입력, 기본값은 `execute.testFirst`(기본 false)                                             | 계획 모양이 바뀌는 기능이라 opt-in으로 둔다                                                                    |
| 테스트 러너가 없는 레포              | `test_setup` 태스크를 하나 더 넣고 테스트 태스크가 거기에 의존한다                                               | red 명령은 setup이 끝난 뒤 실행 시점에 만든다                                                                  |
| AC 연결 결과는 어디에 두나           | 호스트가 돌린 원결과는 `StructuralResult.acChecks`, 서버 판정은 `EvaluationResult.acChecks`                      | 원결과와 판정을 나눠야 재평가와 이벤트 재구성이 단순하다                                                       |
| 점수 반영                            | 판정이 passed가 아닌 AC는 `satisfied`를 false로 덮어쓴다. 그 비율로 `overallScore` 상한을 건다                   | 자기 보고 점수가 근거 없이 임계값을 넘지 못하게 한다                                                           |
| short-circuit                        | AC 검사 실패는 short-circuit하지 않는다                                                                          | 빌드가 깨진 것과 AC가 미충족인 것은 고치는 경로가 다르다. 앞쪽은 `evolve_fix`, 뒤쪽은 `evolve`다               |

### 타입

`src/core/types.ts`에 추가한다.

```ts
// ─── Execute ───
export type AtomicTaskKind = 'implementation' | 'ac_test' | 'test_setup';

export interface AtomicTask {
  // 기존 필드 유지
  /** 없으면 implementation. 서버가 주입한 태스크만 ac_test, test_setup이다 */
  kind?: AtomicTaskKind;
  /** kind가 ac_test일 때 대상 AC id */
  acId?: string;
}

export interface RedCheckResult {
  command: string;
  exitCode: number;
  output: string;
  /** 구현 전인데 이미 통과한다고 호스트가 판단했을 때. output에 근거를 적는다 */
  alreadySatisfied?: boolean;
}

export interface TaskExecutionResult {
  // 기존 필드 유지
  redCheck?: RedCheckResult;
}

/** ac_test 태스크가 red 확인을 통과하면 남는 연결 */
export interface AcTestLink {
  acId: string;
  acIndex: number;
  taskId: string;
  /** 서버 기준 경로(baseline.cwd 기준 상대 경로) */
  testFiles: string[];
  redExitCode: number;
  alreadySatisfied: boolean;
  /** red 확인 시점의 blob 해시. 평가 때 테스트가 바뀌었는지 대조한다 */
  blobs: Record<string, string | null>;
  linkedAt: string;
}

export interface TestFirstReport {
  enabled: boolean;
  reason?: 'disabled' | 'no_test_acs' | 'non_node_project' | 'too_many_tasks';
  setupTaskId?: string;
  injectedTaskIds: string[];
}

export interface ExecutionPlan {
  // 기존 필드 유지
  testFirst?: TestFirstReport;
}

// ─── Evaluate ───
export type AcCheckSource =
  | 'test_first' // AcTestLink
  | 'check_path' // AC.check가 존재하는 테스트 파일 경로
  | 'check_search' // 테스트 파일 안에서 AC.check 문자열을 찾음
  | 'ac_id_search' // 테스트 파일 안에서 AC id를 찾음
  | 'check_command'; // verifyBy가 command

export interface AcCheckCommand {
  acId: string;
  acIndex: number;
  verifyBy: 'test' | 'command';
  /** null이면 돌릴 것이 없다. unlinkedReason에 이유가 있다 */
  command: string | null;
  source?: AcCheckSource;
  testFiles?: string[];
  unlinkedReason?: 'no_check' | 'test_not_found' | 'no_test_runner' | 'unsafe_path';
}

export interface AcCheckRunResult {
  acId: string;
  command: string;
  exitCode: number;
  output: string;
}

export interface StructuralResult {
  commands: StructuralCommandResult[];
  allPassed: boolean;
  acChecks?: AcCheckRunResult[];
}

export type AcCheckStatus = 'passed' | 'failed' | 'unlinked';

export interface AcCheckVerdict {
  acId: string;
  acIndex: number;
  verifyBy: 'test' | 'command';
  status: AcCheckStatus;
  source?: AcCheckSource;
  command?: string;
  exitCode?: number;
  /** red 확인 뒤 테스트 파일 내용이 바뀌었다. 경고이고 판정은 바꾸지 않는다 */
  testModifiedAfterRed?: boolean;
  detail: string;
}

export interface EvaluationResult {
  // 기존 필드 유지
  acChecks?: AcCheckVerdict[];
  scoreAdjustment?: {
    reportedScore: number;
    appliedScore: number;
    overriddenAcIds: string[];
  };
}

export interface ExecuteSession {
  // 기존 필드 유지
  testFirst?: boolean;
  acTestLinks?: AcTestLink[];
  acCheckCommands?: AcCheckCommand[];
  acCheckVerdicts?: AcCheckVerdict[];
}
```

`verifyBy: 'manual'`인 AC는 `AcCheckCommand`와 `AcCheckVerdict`를 만들지 않는다. 기존처럼 contextual 판단에만 맡긴다.

### 흐름 1: Execute에서 테스트 태스크 먼저 쓰기

#### 켜기

`start`에 `testFirst?: boolean`을 받는다. 값이 없으면 `config.execute.testFirst`를 쓴다. 이 기본값을 엔진에 전달하려면 다음 배선이 필요하다.

- `executeConfigSchema`에 `testFirst: z.boolean().default(false)`와 `acCheckMode: z.enum(['enforce', 'report']).default('enforce')`를 추가한다.
- `src/mcp/server.ts:143`에서 엔진 생성자에 `config.execute`를 넘긴다.

세션 값은 `EXECUTE_SESSION_STARTED` payload에 싣는다. 그래야 재시작 뒤 이벤트 재구성(`src/execute/repository.ts:100-127`)에서도 살아남는다.

#### 주입 (plan_complete)

`planComplete`가 서버 DAG를 확인한 뒤, `assignModelHints` 전에(`src/execute/orchestrators/planning.ts:223` 앞) `injectAcTestTasks()`를 부른다. 새 모듈 `src/execute/test-first.ts`에 둔다.

1. `verifyBy === 'test'`인 AC를 모은다. 없으면 `{ enabled: false, reason: 'no_test_acs' }`를 반환한다.
2. 프로젝트 루트는 `session.codeGraphRepoRoot ?? input.cwd ?? process.cwd()`로 정한다. structural 평가와 같은 순서다(`src/execute/orchestrators/evaluation.ts:51`). `plan_complete`는 공통 입력 `cwd`를 받는다.
3. 러너 상태를 판정한다(`detectTestRunner`).
   - `ready`: package.json에 `scripts.test`가 있다. 다만 `npm init` 기본값(`no test specified`가 들어 있고 `exit 1`로 끝나는 스크립트)이면 제외한다. 이 기본값은 항상 실패하므로 그대로 두면 red가 거짓으로 통과한다.
   - `missing`: package.json이 없거나 쓸 만한 test 스크립트가 없다. 빈 디렉토리에서 시작하는 greenfield가 여기에 해당한다.
   - `non_node`: package.json이 없고 `pyproject.toml`, `go.mod`, `Cargo.toml` 중 하나가 있다. 이때는 주입하지 않고 `reason: 'non_node_project'`를 반환한다. structural 명령도 package.json만 안다(`src/execute/structural-commands.ts:86-99`). 그런 레포에서 서버는 red 명령을 만들 수 없다.
4. 러너가 `missing`이면 `test_setup` 태스크(`ac-test-setup`)를 하나 넣는다. 설명은 "테스트 러너를 설치하고 package.json `scripts.test`를 만든다. 테스트는 쓰지 않는다"이다. 이미 러너가 있다고 판단하면 호스트가 `noCodeChange: true`로 끝낼 수 있다. 기존 규칙(`src/execute/orchestrators/execution.ts:494-498`)이 그대로 받는다.
5. 테스트 AC마다 `ac-test-<acId>` 태스크를 넣는다. 형태는 다음과 같다.
   - `kind: 'ac_test'`, `acId`, `sourceAC: [i]`, `isImplicit: false`
   - `estimatedComplexity: 'medium'`, `model: 'sonnet'`
   - `dependsOn`은 setup이 있으면 `[ac-test-setup]`, 없으면 `[]`
   - 호스트가 만든 taskId와 겹치면 `-2`처럼 접미사를 붙인다.
6. `sourceAC`에 i가 있는 기존 태스크는 전부 `dependsOn`에 `ac-test-<acId>`를 추가한다. implicit 태스크도 포함한다.
7. 주입 태스크는 새 그룹 `group-ac-tests`(domain `test`)에 넣는다. 그룹이 없으면 DAG 검증이 실패한다(`src/execute/dag-validator.ts:52`).
8. 합계가 `MAX_ATOMIC_TASKS`를 넘으면 주입을 포기하고 `reason: 'too_many_tasks'`를 반환한다. 계획 자체는 거부하지 않는다.
9. `validateDAG`를 다시 돌린다. 주입 태스크의 의존은 setup 하나뿐이고 setup은 의존이 없다. 새 간선은 모두 "기존 태스크 → 주입 태스크" 방향이다. 순환이 새로 생길 수 없다. 그래도 다시 돌리는 이유는 위상 순서와 임계 경로를 갱신하기 위해서다.

결과는 `ExecutionPlan.testFirst`에 담는다. 계획 전체가 이미 `EXECUTE_PLAN_COMPLETED` payload에 실리므로(`src/execute/session.ts:216-221`) 재구성 경로를 따로 고칠 필요가 없다.

`assignModelHints`는 `model`이 있는 태스크를 건드리지 않는다(`src/execute/model-hint.ts:97-99`). 그래서 주입 태스크의 `sonnet`은 그대로 남는다.

#### red 확인 (execute_task)

`submitTaskResult`의 기존 artifacts 대조(`src/execute/orchestrators/execution.ts:169`)가 통과한 뒤, `kind === 'ac_test'`이고 `status === 'completed'`이면 `verifyRedCheck()`를 추가로 돈다.

1. `artifacts`에서 테스트 파일만 고른다. 기준은 blast-radius 필터와 같은 패턴(`.test.`, `.spec.`, `__tests__`)이다(`src/execute/orchestrators/evaluation.ts:234`). 테스트 파일이 없으면 `redStatus: 'no_test_file'`로 거부한다.
2. 기대 명령을 만든다: `scriptCommand(pm, 'test', toTestArgs(root, testFiles))`. root는 `workingTreeBaseline.cwd`이고 없으면 세션 루트를 쓴다. `detectPackageManager`는 이 시점에 돌린다. greenfield라면 setup이 방금 만든 package.json을 읽는다. 다음 경우에는 `redStatus: 'unsafe_path'`로 거부하고 경로를 바꾸라고 안내한다.
   - `toTestArgs`가 빈 배열을 돌려줄 때. 경로가 안전하지 않거나 너무 많다는 뜻이다(`src/execute/structural-commands.ts:74-80`).
   - package.json이 여전히 없을 때.
3. `redCheck`가 없으면 결과를 기록하지 않는다. `verification_failed`와 같은 모양으로 `redStatus: 'required'`와 `redCheck.command`를 돌려준다. 호스트는 그 명령을 그대로 돌리고 `redCheck`를 붙여 다시 제출한다.
4. 제출된 `redCheck.command`가 기대 명령과 다르면 거부한다. 비교는 `findCommandMismatches`와 같은 trim 비교다.
5. 출력이 `/no test files found|no tests found|no tests ran/i`와 맞으면 거부한다(`redStatus: 'no_tests_collected'`). vitest와 jest는 테스트를 하나도 못 모아도 종료 코드 1을 낸다. 이 경우를 red로 받으면 안 된다.
6. 종료 코드가 0이면 거부한다(`redStatus: 'not_red'`). 예외가 하나 있다. `alreadySatisfied: true`이고 output에 근거가 있으면 받는다. 기능이 이미 있는 brownfield를 위한 출구다. 이 연결은 평가 단계 프롬프트에 드러난다.
7. 통과하면 `AcTestLink`를 만든다. 테스트 파일의 blob 해시는 `artifact-verifier.ts`의 `hashFiles`를 export해 다시 쓴다. 링크는 `EXECUTE_TASK_COMPLETED` payload의 `acTestLink` 필드에 싣고 `repository.ts:176-216`의 재구성에서 `session.acTestLinks`로 복원한다.

거부 이벤트는 기존 `EXECUTE_TASK_VERIFICATION_FAILED` payload에 `redStatus`를 더해 남긴다.

red 확인은 `execute_task`에만 있다. `evolve_re_execute`는 artifacts 대조도 하지 않는다(`plugin/skills/execute/SKILL.md:450`). 재실행 시점에는 구현이 이미 있어서 red가 나올 수 없다. 그래서 재실행된 `ac_test` 태스크는 red 없이 받는다. 링크는 다음 평가에서 `ac_id_search`로 다시 찾는다.

#### 구현 태스크 쪽

`buildNextTaskContext`(`src/execute/orchestrators/execution.ts:512-582`)는 다음 태스크의 `sourceAC`에 걸린 `acTestLinks`를 찾는다. 찾은 링크는 `buildTaskExecutionPrompt`에 넘긴다.

`TaskExecutionContext`에는 다음 필드를 추가한다.

- `redCheck?: { command: null; instructions: string }`: `ac_test` 태스크일 때. 명령은 테스트 파일을 쓰기 전이라 아직 정할 수 없다.
- `linkedTests?: { acId: string; testFiles: string[] }[]`: 구현 태스크일 때.

#### 프롬프트 변경

- **closure**(`src/execute/prompts.ts:99-139`): AC 목록에 `[i] AC-1 (verifyBy=test, check=...)` 꼴로 id와 검증 방식을 보인다. `testFirst`가 켜진 세션에는 규칙 두 줄을 더한다.
  - "verifyBy=test인 AC의 테스트만 쓰는 태스크를 만들지 않는다. 서버가 `ac-test-<id>`로 넣는다."
  - "그 AC를 구현하는 태스크는 sourceAC에 해당 인덱스를 반드시 적는다."
- **태스크 실행**(`src/execute/prompts.ts:240-299`): `ac_test`면 지시를 바꾼다.
  - 테스트 이름에 AC id를 넣는다(`it('AC-1: ...')`). 평가 단계의 `ac_id_search`가 이 규칙에 기댄다.
  - 구현 코드는 쓰지 않는다.
  - 제출하면 서버가 돌려줄 명령을 그대로 실행해 0이 아닌 종료 코드를 확인한다.

  구현 태스크면 `linkedTests` 블록을 더한다. "이 테스트가 통과하게 만든다. 통과시키려고 테스트를 고치지 않는다."

- **재실행**(`src/execute/prompts.ts:634`): `ac_test` 태스크면 red 확인이 없다는 점과 AC id 이름 규칙을 적는다.

### 흐름 2: Evaluate에서 AC마다 테스트 연결 확인

#### Call 1: 검사 명령 만들기

`startEvaluation`(`src/execute/orchestrators/evaluation.ts:32-74`)은 `buildStructuralCommands` 다음에 `resolveAcChecks(projectRoot, spec, session.acTestLinks)`를 부른다. 새 모듈 `src/execute/ac-checks.ts`에 둔다.

`verifyBy: 'test'`인 AC는 아래 순서로 테스트 파일을 찾는다. 먼저 찾은 쪽을 쓴다.

1. `test_first`: 해당 AC의 `AcTestLink.testFiles` 중 지금도 존재하는 파일
2. `check_path`: `AC.check`가 루트 안에 있는 파일 경로
3. `check_search`: 테스트 파일 안에서 `AC.check` 문자열을 그대로 찾는다
4. `ac_id_search`: 테스트 파일 안에서 `\bAC-1\b`를 찾는다
5. 다 실패하면 `command: null`과 함께 이유를 남긴다. 체크 문자열이 없었으면 `no_check`, 찾지 못했으면 `test_not_found`다.

파일 탐색 규칙은 다음과 같다.

- `readdirSync({ recursive: true })`와 `Dirent.parentPath`로 돈다. `glob`을 쓰지 않는 레포 관례(`CLAUDE.md` Conventions)를 따른다.
- `node_modules`, `.git`, `dist`, `.gestalt`는 건너뛴다.
- 파일은 5000개, 파일 하나는 512KB까지만 읽는다.

찾은 파일로 `scriptCommand(pm, 'test', toTestArgs(root, files))`를 만든다. `toTestArgs`가 빈 배열이면 `unlinkedReason: 'unsafe_path'`를 남긴다. package.json이 없으면 `no_test_runner`를 남긴다.

`verifyBy: 'command'`인 AC는 `AC.check`를 그대로 명령으로 쓴다(`source: 'check_command'`). `check`가 없으면 `no_check`다.

결과는 `startStructuralEvaluation`에 같이 넘겨 `session.acCheckCommands`에 둔다. `EVALUATE_STRUCTURAL_STARTED` payload에도 싣는다(`src/execute/session.ts:293-303`). 재구성(`src/execute/repository.ts:218-223`)에서 함께 복원한다.

응답의 `structuralContext`에 `acChecks: AcCheckCommand[]`를 추가한다. 안내 문구도 바꾼다. "`command`가 null이 아닌 항목은 그대로 실행해 `structuralResult.acChecks`로 낸다."

#### Call 2: 원결과 받기와 판정

`submitStructuralResult`(`src/execute/orchestrators/evaluation.ts:79-158`)는 기존 `commands` 대조 다음에 `acChecks`를 대조한다.

- `command`가 null이 아닌 요청 항목은 `acId`로 짝을 지어 빠짐과 불일치를 확인한다. 하나라도 어긋나면 기존 메시지 형식("Submitted commands do not match ...")으로 거부한다. 호스트 스킬이 이미 이 메시지에 대응하고 있다(`plugin/skills/execute/SKILL.md:521`).
- 판정은 서버가 만든다(`buildAcCheckVerdicts`).
  - `command`가 null이면 `unlinked`
  - 종료 코드가 0이면 `passed`, 아니면 `failed`
  - `test_first`나 `ac_id_search`로 찾은 파일이 `AcTestLink.blobs`와 해시가 다르면 `testModifiedAfterRed: true`를 단다. 판정은 바꾸지 않는다.
- `allPassed`와 short-circuit은 기존 `commands`로만 계산한다(`src/execute/orchestrators/evaluation.ts:115-138`). AC 검사가 실패해도 contextual 단계로 넘어간다.
- 판정은 `session.acCheckVerdicts`에 두고 `EVALUATE_STRUCTURAL_COMPLETED` payload에 싣는다. 원결과 `acChecks`는 `toEventStructuralResult`(`src/execute/session.ts:44-60`)가 `commands`와 같은 방식으로 비밀값을 가리고 끝부분만 남긴다.

short-circuit된 경우 `buildShortCircuitEvaluation`(`src/execute/repository.ts:32-44`)이 모든 AC를 미충족으로 만든다. 이 경로는 바꾸지 않는다.

#### Call 3: 점수 반영

`submitEvaluation`(`src/execute/orchestrators/evaluation.ts:163-218`)은 범위 검증 뒤에 `applyAcCheckVerdicts()`를 부른다.

- `acCheckMode === 'report'`면 `evaluationResult.acChecks`만 붙인다.
- `enforce`(기본값)면 다음을 한다.
  1. 판정이 `passed`가 아닌 AC는 `verifications[acIndex].satisfied`를 false로 바꾼다. `gaps` 앞에는 `"AC-1: 연결된 테스트를 찾지 못했다"` 또는 `"AC-1: 검사 명령이 exit 1로 실패했다"`를 넣는다.
  2. passed가 아닌 판정이 하나라도 있으면 `appliedScore = min(reported, satisfied 수 / 전체 AC 수)`로 상한을 건다. 가중치는 호스트만 알기 때문에(`src/execute/prompts.ts:451`) 상한이 걸릴 때만 가중 없는 비율을 쓴다.
  3. `scoreAdjustment`에 원래 점수, 적용 점수, 덮어쓴 AC id를 남긴다.

바뀐 `evaluationResult`는 `completeEvaluation`이 그대로 이벤트에 싣는다(`src/execute/session.ts:347-360`). 성공 판정(`src/mcp/tools/execute/evaluate.ts:68-71`)과 종료 조건(`src/execute/termination-detector.ts:41-44`)은 고친 점수를 읽으므로 따로 손대지 않는다.

#### contextual 프롬프트

`buildContextualEvaluationPrompt`(`src/execute/prompts.ts:401-456`)에 `acCheckVerdicts`를 받는 인자를 추가한다. `**AC Check Results**` 표에는 AC id와 상태, 출처, 테스트 파일, `testModifiedAfterRed`, `alreadySatisfied`를 보인다. 규칙도 더한다.

- "status가 passed가 아닌 AC는 satisfied=false로 낸다. 서버가 어차피 덮어쓴다."
- "testModifiedAfterRed가 있으면 테스트가 약해지지 않았는지 evidence에 적는다."

### 흐름 3: Evolve가 판정을 쓰는 방식

- **진화 프롬프트**(`src/execute/prompts.ts:572-632`): 덮어쓴 gaps는 기존 `Unsatisfied Criteria` 블록에 자동으로 실린다. 여기에 `**AC Check Results**` 블록을 더해 `unlinked`와 `failed`를 나눠 보인다. 안내도 덧붙인다. "`unlinked`이고 `check`가 실제 테스트 이름과 어긋난 경우라면 `acceptanceCriteria[].check`를 고치는 패치가 가장 작은 패치다." AC 필드는 L1 FREE라 이 패치가 허용된다(`src/execute/prompts.ts:559`).
- **재실행 대상**(`src/execute/impact-identifier.ts:12-53`): 네 번째 기준을 더한다. `acCheckVerdicts` 중 passed가 아닌 AC의 인덱스를 `sourceAC`에 가진 태스크와, 그 AC의 `ac_test` 태스크를 넣는다. 이렇게 하면 AC 문장이 그대로여도 재실행 대상이 비지 않는다. `submitSpecPatch`의 호출부(`src/execute/orchestrators/evolution.ts:250-255`)에서 `session.evaluationResult?.acChecks`를 넘긴다.
- **재실행 프롬프트**: 대상 태스크의 AC 판정을 붙인다. "AC-1 테스트를 찾지 못했다. 이름에 AC-1을 넣은 테스트를 추가한다."
- lateral과 human gate는 `evaluationResult`를 그대로 받는다. gaps를 거쳐 판정이 전달되므로 바꾸지 않는다.

### MCP 요청과 응답 변경

| 액션                            | 요청                                             | 응답                                                                                                                                          |
| ------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`                         | `testFirst?: boolean`                            | 변경 없음                                                                                                                                     |
| `plan_complete`                 | 공통 `cwd`를 러너 판정에 쓴다                    | `testFirst: TestFirstReport`. `planSummary.totalTasks`에 주입 태스크가 포함된다                                                               |
| `execute_start`, `execute_task` | `taskResult.redCheck?: RedCheckResult`           | `taskContext.redCheck`, `taskContext.linkedTests`. red 거부는 `status: 'verification_failed'`, `redStatus`, `redCheck.command`(required일 때) |
| `evaluate` Call 1               | 변경 없음                                        | `structuralContext.acChecks: AcCheckCommand[]`                                                                                                |
| `evaluate` Call 2               | `structuralResult.acChecks?: AcCheckRunResult[]` | `contextualContext.acCheckVerdicts`                                                                                                           |
| `evaluate` Call 3               | 변경 없음                                        | `evaluationResult.acChecks`, `evaluationResult.scoreAdjustment`                                                                               |

`src/mcp/schemas.ts`에서 다음을 바꾼다.

- `stepResult.atomicTasks` 항목(`src/mcp/schemas.ts:239-251`)에는 `kind`를 열지 않는다. 호스트가 `ac_test`를 직접 만드는 길을 막기 위해서다.
- `taskResult`(`src/mcp/schemas.ts:277-296`)에 `redCheck`를 추가한다.
- `structuralResult`(`src/mcp/schemas.ts:297-310`)에 `acChecks`를 추가한다.
- `evaluationResult`(`src/mcp/schemas.ts:311-327`)는 호스트가 `acChecks`를 내도 서버가 버리고 다시 만든다.

## 바꿀 파일

| 파일                                                                                                               | 변경                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/types.ts`                                                                                                | `AtomicTaskKind`, `RedCheckResult`, `AcTestLink`, `TestFirstReport`, `AcCheckCommand`, `AcCheckRunResult`, `AcCheckVerdict` 추가. `AtomicTask`, `TaskExecutionResult`, `ExecutionPlan`, `StructuralResult`, `EvaluationResult`, `ExecuteSession`에 선택 필드 추가 |
| `src/core/config.ts`                                                                                               | `executeConfigSchema`에 `testFirst`, `acCheckMode` 추가. `GESTALT_EXECUTE_TEST_FIRST`, `GESTALT_AC_CHECK_MODE` 환경변수 매핑                                                                                                                                      |
| `src/mcp/server.ts`                                                                                                | 엔진 생성 때 `config.execute` 전달                                                                                                                                                                                                                                |
| `src/execute/passthrough-engine.ts`                                                                                | 생성자 옵션으로 execute 설정을 받아 오케스트레이터에 넘김. `start`, `planComplete` 시그니처에 `testFirst`, `cwd` 추가                                                                                                                                             |
| `src/execute/test-first.ts` (새 파일)                                                                              | `detectTestRunner`, `injectAcTestTasks`, `buildRedCheckCommand`, `verifyRedCheck`                                                                                                                                                                                 |
| `src/execute/ac-checks.ts` (새 파일)                                                                               | `resolveAcChecks`, `findAcCheckMismatches`, `buildAcCheckVerdicts`, `applyAcCheckVerdicts`                                                                                                                                                                        |
| `src/execute/orchestrators/planning.ts`                                                                            | `planComplete`에서 주입 후 DAG 재검증. `start`에서 `testFirst`를 세션에 기록                                                                                                                                                                                      |
| `src/execute/orchestrators/execution.ts`                                                                           | `submitTaskResult`에 red 확인 단계 추가. `buildNextTaskContext`에 `redCheck`, `linkedTests` 추가                                                                                                                                                                  |
| `src/execute/orchestrators/evaluation.ts`                                                                          | Call 1에서 AC 검사 명령 생성, Call 2에서 대조와 판정, Call 3에서 덮어쓰기와 점수 상한                                                                                                                                                                             |
| `src/execute/orchestrators/evolution.ts`                                                                           | `identifyImpactedTasks`에 판정 전달. 진화 프롬프트와 재실행 프롬프트에 판정 전달                                                                                                                                                                                  |
| `src/execute/orchestrators/types.ts`                                                                               | `TaskExecutionContext`, `StructuralEvaluateContext`, `ContextualEvaluateContext`, `PassthroughTaskSubmitResult` 필드 추가                                                                                                                                         |
| `src/execute/impact-identifier.ts`                                                                                 | AC 판정 기반 네 번째 기준                                                                                                                                                                                                                                         |
| `src/execute/structural-commands.ts`                                                                               | `scriptCommand`, `toTestArgs`, 테스트 파일 판정 함수 export                                                                                                                                                                                                       |
| `src/execute/artifact-verifier.ts`                                                                                 | `hashFiles` export                                                                                                                                                                                                                                                |
| `src/execute/prompts.ts`                                                                                           | closure, 태스크 실행, 재실행, contextual 평가, 진화 프롬프트 변경                                                                                                                                                                                                 |
| `src/execute/session.ts`                                                                                           | `startExecution`이 아닌 `start` 이벤트에 `testFirst` 기록. `addTaskResult`에 `acTestLink`, `startStructuralEvaluation`에 `acCheckCommands`, `completeStructuralStage`에 판정 기록. `toEventStructuralResult`가 `acChecks`도 가림                                  |
| `src/execute/repository.ts`                                                                                        | 위 payload를 재구성에 반영                                                                                                                                                                                                                                        |
| `src/mcp/schemas.ts`                                                                                               | `testFirst`, `taskResult.redCheck`, `structuralResult.acChecks`                                                                                                                                                                                                   |
| `src/mcp/tools/execute/planning.ts`                                                                                | `handleStart`가 `testFirst`를 넘기고 `handlePlanComplete`가 `testFirst` 보고를 응답에 싣는다                                                                                                                                                                      |
| `src/mcp/tools/execute/execution.ts`                                                                               | red 거부 응답 포맷(`formatVerificationFailure` 확장)                                                                                                                                                                                                              |
| `src/mcp/tools/execute/evaluate.ts`                                                                                | Call 1과 Call 2 안내 문구, Call 3 응답에 `scoreAdjustment` 노출                                                                                                                                                                                                   |
| `plugin/skills/execute/SKILL.md`                                                                                   | red 확인 재제출 절차, `acChecks` 실행과 제출, 서브에이전트 지시문에 red 단계 추가                                                                                                                                                                                 |
| `docs/03-execute.md`, `docs/04-evaluate.md`, `docs/05-evolve.md`, `docs/configuration.md`, `docs/mcp-reference.md` | 흐름과 스키마, 설정 반영                                                                                                                                                                                                                                          |

## 하위 호환

- **옛 문자열 AC**: 구조화 PR이 `manual`로 올리므로 테스트 태스크도 AC 검사도 생기지 않는다. 평가 결과는 지금과 같다.
- **testFirst 기본값 false**: 계획 모양이 바뀌지 않는다. `kind`가 없는 태스크는 implementation으로 읽는다.
- **진행 중인 세션**: `acCheckCommands`가 없는 상태로 Call 2에 오면 AC 대조를 건너뛴다. 재시작 전에 Call 1을 받은 세션이 이 경우다. 구조 명령 대조가 비었을 때 Call 1부터 다시 하라고 거부하는 기존 처리(`src/execute/orchestrators/evaluation.ts:97-104`)와는 다르게, 여기서는 막지 않고 넘어간다.
- **옛 이벤트 원장**: 새 payload 필드는 모두 선택이다. 없으면 빈 값으로 복원한다. 옛 버전 서버가 새 원장을 읽어도 모르는 필드는 무시한다.
- **옛 스킬을 쓰는 호스트**: `acChecks`를 내지 않으면 Call 2가 거부된다. 거부 메시지는 기존 불일치 메시지와 같은 형식이라 옛 스킬도 "요청 명령을 그대로 다시 돌려 낸다"로 대응한다. 다만 옛 스킬은 `acChecks` 필드 자체를 모른다. 이 지점은 열린 질문에 남긴다.
- **`enforce`가 점수를 깎는 문제**: `verifyBy: 'test'`를 처음 쓰는 스펙부터 점수가 내려갈 수 있다. 출구는 `acCheckMode: 'report'`다.
- **`overallScore` 의미**: 상한이 걸리면 호스트의 가중 점수 대신 가중 없는 비율이 남는다. `scoreAdjustment.reportedScore`로 원래 값을 볼 수 있다.

## 테스트

| 대상                 | 파일                                                                       | 확인할 것                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 러너 판정            | `tests/unit/execute/test-first.test.ts` (새 파일)                          | `ready`, `missing`(package.json 없음, npm init 기본 스크립트), `non_node`                                                                                                                                                                                                    |
| 주입                 | 같은 파일                                                                  | 테스트 AC마다 태스크 하나. sourceAC가 겹치는 기존 태스크의 dependsOn에 추가. setup 의존. 그룹 추가. id 충돌 접미사. 100개 초과 시 포기. 재검증된 DAG가 유효하고 주입 태스크가 0층(setup이 있으면 1층)                                                                        |
| plan_complete 통합   | `tests/unit/execute/planning-orchestrator.test.ts`                         | testFirst 켬과 끔. `EXECUTE_PLAN_COMPLETED` 재구성 뒤 계획이 같은지                                                                                                                                                                                                          |
| red 확인             | `tests/unit/execute/execution-red-check.test.ts` (새 파일)                 | redCheck 없음이면 required와 명령 반환, 결과 미기록. 명령 불일치 거부. exit 0 거부. `alreadySatisfied` 수용. "No test files found" 거부. 테스트 파일 없는 artifacts 거부. 통과하면 `AcTestLink`와 blob 해시. git 임시 레포는 `execution-artifact-verify.test.ts` 헬퍼를 쓴다 |
| 구현 태스크 컨텍스트 | `tests/unit/execute/context-injection.test.ts`                             | `linkedTests`가 sourceAC 기준으로 실림                                                                                                                                                                                                                                       |
| AC 검사 해석         | `tests/unit/execute/ac-checks.test.ts` (새 파일)                           | 다섯 출처의 우선순위. 탐색 제외 디렉토리. 파일 수와 크기 상한. unsafe 경로. package.json 없음. command AC. manual AC 제외                                                                                                                                                    |
| 평가 3-Call          | `tests/unit/execute/execution-evaluate.test.ts`                            | Call 1 응답의 `acChecks`. Call 2 누락과 불일치 거부. AC 실패가 short-circuit하지 않음. 판정 생성과 `testModifiedAfterRed`. Call 3의 덮어쓰기와 점수 상한, `report` 모드                                                                                                      |
| 재구성               | `tests/unit/execute/repository.test.ts`                                    | `acTestLinks`, `acCheckCommands`, 판정, `testFirst`가 재시작 뒤에도 같다                                                                                                                                                                                                     |
| 이벤트 가림          | `tests/unit/execute/output-truncation.test.ts`                             | `acChecks.output`의 토큰이 가려지고 잘림                                                                                                                                                                                                                                     |
| 재실행 대상          | `tests/unit/execute/evolution-loop.test.ts`                                | AC 문장이 그대로여도 판정이 failed나 unlinked인 AC의 태스크가 대상에 들어간다                                                                                                                                                                                                |
| 스키마               | `tests/unit/execute/handlers-planning.test.ts`, `execute-dispatch.test.ts` | 호스트가 `atomicTasks[].kind`를 내도 무시됨. `redCheck`, `acChecks` 파싱                                                                                                                                                                                                     |

## PR 나누기

선행 조건은 **AC 구조화 PR**이다. 이 PR이 `AcceptanceCriterion`, `Spec.acceptanceCriteria` 전환, 문자열 AC 정규화를 제공한다. 아래 PR은 모두 그 PR이 머지된 뒤에 시작한다.

| 순서 | PR                                            | 내용                                                                                                                                                                      | 의존                                                       |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | `feat(evaluate): AC별 테스트 연결 검사`       | `ac-checks.ts`, 평가 3-Call 변경, `EvaluationResult.acChecks`와 `scoreAdjustment`, contextual 프롬프트, 설정 `acCheckMode`와 엔진 설정 배선, 스킬과 `docs/04-evaluate.md` | AC 구조화 PR                                               |
| 2    | `feat(evolve): AC 검사 판정 기반 재실행 대상` | `impact-identifier.ts` 네 번째 기준, 진화 프롬프트와 재실행 프롬프트, `docs/05-evolve.md`                                                                                 | 1                                                          |
| 3    | `feat(execute): AC 테스트 우선 태스크 주입`   | `test-first.ts`의 러너 판정과 주입, `plan_complete` 변경, closure 프롬프트, 설정 `testFirst`, `docs/03-execute.md`                                                        | AC 구조화 PR (1의 엔진 설정 배선을 쓰므로 1 다음이 편하다) |
| 4    | `feat(execute): 테스트 태스크 red 확인`       | `verifyRedCheck`, `AcTestLink`와 재구성, 태스크 실행 프롬프트, red 거부 응답, 스킬의 재제출 절차. 평가의 `test_first` 출처와 `testModifiedAfterRed`                       | 1, 3                                                       |

1번을 먼저 내는 이유는 두 가지다. 테스트 우선을 켜지 않은 세션에도 바로 효과가 있다. 그리고 3번과 4번이 만든 링크를 소비하는 쪽이 먼저 있어야 링크가 쓸모 있는지 확인할 수 있다.

## 열린 질문

1. **red의 질**: 종료 코드가 0이 아니라는 것만으로는 import 오류로 실패한 것과 단언이 실패한 것을 구별하지 못한다. 출력에서 러너별 단언 실패 패턴(`AssertionError`, `expected ... to`)을 요구할지, 아니면 거짓 거부가 늘 것을 감수할지 정해야 한다.
2. **테스트 태스크의 선행 조건**: 테스트가 import할 모듈 뼈대가 없으면 red는 import 오류가 된다. `ac_test`를 sourceAC가 없는 implicit 인프라 태스크에 의존시킬지 정해야 한다. 지금 설계는 setup에만 의존한다.
3. **node 외 생태계**: pytest, go test, cargo test의 red 명령을 서버가 만들 수 있게 할지, 아니면 그 레포에서는 호스트가 명령을 정하고 서버는 기록만 할지(`source: 'host'`) 정해야 한다. structural 명령도 같은 한계가 있다(`src/execute/structural-commands.ts:86-99`).
4. **AC 검사 명령 수**: AC마다 테스트 명령을 따로 돌리면 test 스위트를 여러 번 부른다. AC가 20개를 넘으면 파일을 합쳐 한 번만 돌리고 판정은 러너의 JSON 리포터로 나눌지 정해야 한다.
5. **command AC의 신뢰 경계**: `AC.check`는 스펙에서 온 문자열을 호스트 셸로 그대로 넘긴다. 스펙은 사용자 인터뷰에서 나오지만 evolve 패치로도 바뀐다(`src/execute/prompts.ts:559`). 패치로 바뀐 `check`를 다음 평가에서 그대로 실행해도 되는지, 사람 확인을 끼울지 정해야 한다.
6. **`enforce` 기본값**: 첫 릴리즈에서 `report`로 시작해 판정 분포를 본 뒤 `enforce`로 올릴지 정해야 한다.
7. **옛 스킬 호환**: 플러그인 버전이 서버보다 뒤처진 세션은 `acChecks`를 모른다. Call 2에서 거부하는 대신 `unlinked`로 처리하고 버전 알림(`src/mcp/server.ts`의 `toolReply()`)에 맡길지 정해야 한다.
8. **실패한 테스트 태스크의 후속 처리**: `computeReadyTaskIds`는 failed를 해소로 보지 않는다(`src/execute/parallel-groups.ts:27-31`). 반면 `getCurrentTask`는 failed 의존을 해소로 본다(`src/execute/orchestrators/execution.ts:442-444`). `ac_test`가 failed로 끝나면 구현 태스크가 ready 집합에서는 막히는데 순차 경로에서는 진행된다. 테스트 우선 세션에서 이 둘을 맞출지 정해야 한다.
