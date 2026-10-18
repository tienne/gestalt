# Evaluate 근거 위치화와 맥락 없는 채점자

## 배경

Contextual 평가는 지금 구현한 쪽의 보고서를 근거로 삼는다. 시스템 프롬프트부터 "completed task results"를 기준으로 AC를 확인하라고 적혀 있다(`src/execute/prompts.ts:301-310`). `buildContextualEvaluationPrompt`는 태스크마다 `r.output`과 `r.artifacts`를 그대로 이어 붙인다(`src/execute/prompts.ts:417-421`). 지시문도 "Verify each AC against the task results"이고(`src/execute/prompts.ts:434`), 예시 JSON의 evidence 자리에는 "Specific evidence from task results"라고 적혀 있다(`src/execute/prompts.ts:440`). 그래서 evidence는 코드가 아니라 구현 에이전트의 자기 설명을 다시 옮긴 문장이 된다. 같은 꼴의 `buildEvaluationPrompt`도 있는데(`src/execute/prompts.ts:312-361`) 부르는 곳이 없다.

서버가 제출을 받을 때 보는 것도 많지 않다. `submitEvaluation`은 모든 AC 인덱스가 들어 있는지와 두 점수가 0~1 범위인지만 확인한다(`src/execute/orchestrators/evaluation.ts:178-201`). evidence는 `string` 하나이고(`src/core/types.ts:307-312`, `src/mcp/schemas.ts:313-320`) 내용을 검사하는 곳이 없다. 존재하지 않는 파일을 근거로 적어도 통과한다.

채점하는 주체도 문제다. Passthrough에서는 구현한 호스트 세션이 Call 2 응답의 `evaluatePrompt`를 받아 그대로 채점한다(`src/mcp/tools/execute/evaluate.ts:147-148`). 응답의 `contextualContext`에는 `taskResults`가 통째로 실려 있다(`src/execute/orchestrators/evaluation.ts:264`). 구현하면서 쌓은 판단과 기억이 남은 컨텍스트가 자기 결과를 채점하는 셈이다. 같은 컨텍스트로 하는 검증이 왜 약한지는 `doubt` 스킬이 이미 정리해 두었다(`plugin/skills/doubt/SKILL.md:107`, `plugin/skills/doubt/SKILL.md:135`).

서버가 코드를 직접 확인하는 장치는 다른 자리에 이미 있다. 태스크 완료 보고는 실행 시작 때 잡아 둔 git 기준 트리와 대조한다(`src/execute/artifact-verifier.ts:129-147`, `src/execute/artifact-verifier.ts:173-243`, `src/execute/orchestrators/execution.ts:480-510`). 아키텍처 검증기는 code 근거의 파일이 있는지와 줄이 범위 안인지 본다(`src/architecture/validator.ts:184-220`). 다만 excerpt가 그 줄과 같은지는 보지 않는다. 이슈 #57이 그 비교를 제안하고 있다. 이 문서는 그 비교를 공용 유틸로 만들어 평가 근거 확인과 아키텍처 검증이 함께 쓰게 한다.

이 문서는 다른 설계가 들여오는 AC 계약을 전제로 한다.

```ts
type AcVerifyBy = 'test' | 'command' | 'manual';
interface AcceptanceCriterion {
  id: string;
  criterion: string;
  verifyBy: AcVerifyBy;
  check?: string;
}
```

## 설계

목표는 두 가지다. 첫째, 채점자는 근거를 문장이 아니라 위치로 내고 서버가 그 위치를 직접 연다. 둘째, 채점은 구현 맥락이 없는 별도 에이전트가 한다. 서버는 에이전트를 띄울 수 없으므로 무엇을 넘기고 누구를 띄울지만 응답에 싣고 실제로 띄우는 일은 스킬이 맡는다.

### 타입

`src/core/types.ts`의 Evaluate 구역을 아래처럼 바꾼다.

```ts
export type AcEvidence =
  | { kind: 'code'; path: string; line: number; excerpt: string }
  | { kind: 'test'; name: string; file?: string }
  | { kind: 'command'; command: string; exitCode: number }
  | { kind: 'note'; text: string };

export type EvidenceCheckStatus =
  | 'verified' // 서버가 파일을 열어 확인했다
  | 'relocated' // 줄이 밀렸지만 근처에서 같은 줄을 찾아 고쳤다
  | 'corroborated' // 이미 제출된 structural 결과와 맞는다
  | 'unverified' // 서버가 확인할 방법이 없다 (note, file 없는 test, 모르는 command)
  | 'invalid'; // 확인했는데 틀렸다

export interface EvidenceCheck {
  evidenceIndex: number;
  status: EvidenceCheckStatus;
  problem?: string;
  /** relocated면 원래 줄. invalid인데 후보가 있으면 candidates */
  relocatedFrom?: number;
  candidates?: number[];
  /** 기준 트리 대비 바뀐 파일인가. 판정에는 안 쓰고 채점 참고로만 싣는다 */
  inChangeSet?: boolean;
}

export interface ACVerification {
  acIndex: number;
  /** AC 계약이 들어오면 채운다. acIndex와 같은 AC를 가리켜야 한다 */
  acId?: string;
  satisfied: boolean;
  evidence: AcEvidence[];
  gaps: string[];
  /** 서버가 채운다. 제출 때 넣은 값은 버린다 */
  evidenceChecks?: EvidenceCheck[];
}

export type EvaluatorIsolation = 'subagent' | 'same_session';

export interface EvaluatorDeclaration {
  isolation: EvaluatorIsolation;
  /** subagent면 띄운 모델. same_session이면 비운다 */
  model?: string;
  /** same_session일 때 필수. 왜 서브에이전트를 못 띄웠나 */
  reason?: string;
}

export interface EvaluationResult {
  verifications: ACVerification[];
  overallScore: number;
  goalAlignment: number;
  recommendations: string[];
  evaluator?: EvaluatorDeclaration;
  /** 서버가 채운다. 근거 확인에 실패해 satisfied를 false로 내린 AC */
  downgradedAcIndices?: number[];
  /** 서버가 채운다. evaluator.isolation이 same_session이면 true */
  selfGraded?: boolean;
}
```

`note`는 두 자리에 쓴다. 하나는 `verifyBy: 'manual'`인 AC의 사람 확인 메모이고 다른 하나는 옛 문자열 evidence를 읽을 때 감싸는 꼴이다(하위 호환 절 참고). `note`만으로는 서버가 satisfied를 인정하지 않는다. manual AC는 예외다.

### 공용 유틸: 줄 위치와 excerpt 대조

`src/core/source-location.ts`를 새로 둔다. 아키텍처 검증기와 평가 근거 확인이 둘 다 이 파일만 쓴다.

```ts
/** 한 번의 검증 동안 파일 내용을 기억한다. 읽지 못한 파일은 null */
export type SourceFileCache = Map<string, string[] | null>;

export function resolveInsideRoot(
  root: string,
  relPath: string,
): { ok: true; abs: string } | { ok: false; reason: 'absolute' | 'outside_root' };

export function readSourceLines(abs: string, cache: SourceFileCache): string[] | null;

export type LocationCheck =
  | { status: 'match' }
  | { status: 'moved'; candidates: number[] } // 가까운 순, 최대 3개
  | { status: 'mismatch' } // 근처에서도 못 찾았다
  | { status: 'out_of_range'; lineCount: number }
  | { status: 'missing_file' };

export function checkLineExcerpt(
  lines: string[] | null,
  line: number,
  excerpt: string | undefined,
  opts?: { window?: number }, // 기본 200
): LocationCheck;
```

대조 규칙은 이슈 #57의 제안을 그대로 따른다.

1. excerpt와 줄 내용 모두 앞뒤 공백을 걷어 낸다. 걷어 낸 줄이 걷어 낸 excerpt로 시작하면 맞은 것으로 본다. excerpt에 일부만 잘라 적는 경우가 많아서다.
2. excerpt가 여러 줄이면 줄마다 같은 규칙으로 `line`부터 이어지는 줄과 맞춘다.
3. 안 맞으면 위아래 `window` 줄 안에서 같은 규칙으로 맞는 시작 줄을 찾는다. 가까운 순으로 최대 3개를 `candidates`에 싣는다.
4. excerpt가 없거나 걷어 낸 뒤 비어 있으면 범위 검사만 한다.
5. 2MB가 넘는 파일은 읽지 않는다. `src/review/snippet-reader.ts`의 `MAX_FILE_BYTES`와 같은 기준이다.

줄 세기는 지금 `countLines`(`src/architecture/validator.ts:161-165`)와 같게 마지막 빈 줄을 뺀다. 그래야 아키텍처 쪽 범위 판정이 바뀌지 않는다.

아키텍처 쪽 변경은 이슈 #57 범위만큼만 한다. `LineCountCache`(`src/architecture/validator.ts:169-182`)를 `SourceFileCache`로 바꾸고 `checkCodeLocation`(`src/architecture/validator.ts:184-220`)이 경로 판정에는 `resolveInsideRoot`를, 범위 판정에는 `checkLineExcerpt`를 쓰게 한다. `checkEvidenceList`(`src/architecture/validator.ts:254-259`)는 public 근거에 excerpt가 있을 때 `moved`나 `mismatch`가 나오면 `CODE_EVIDENCE_EXCERPT_MISMATCH` 경고를 낸다. 이 경고에는 후보 줄을 싣는다. 경고 타입 합집합(`src/architecture/validator.ts:100`)에 하나를 더한다. 오류로 올리지 않는 이유는 이슈와 같다. 이미 저장된 지도가 한꺼번에 막히면 안 된다.

### 평가 근거 확인 규칙

`src/execute/evidence-checker.ts`를 새로 둔다. 순수 함수 `checkEvaluationEvidence(session, result)`가 `ACVerification[]`에 `evidenceChecks`를 채워 돌려준다. 파일 읽기는 동기 `readFileSync`로 충분하다. 아키텍처 검증기도 같은 방식이다.

파일 경로 기준은 `session.workingTreeBaseline.repoRoot`다. 기준 트리가 없으면 `session.codeGraphRepoRoot`를 쓰고 그것도 없으면 Call 1에서 받은 cwd를 쓴다. 바뀐 파일 집합은 Call 2에서 계산해 세션에 둔 값을 다시 쓴다(아래 흐름 참고).

| kind      | 서버가 하는 일                                                                                                                    | 결과                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`    | `resolveInsideRoot`와 `checkLineExcerpt`를 돌린다. excerpt는 필수다                                                               | `match`면 verified. `moved`인데 후보가 하나면 줄을 고치고 relocated. 후보가 여럿이면 가장 가까운 줄로 고치고 relocated에 나머지 후보를 남긴다. `mismatch`, `out_of_range`, `missing_file`, 루트 밖 경로는 invalid |
| `test`    | `file`이 있으면 루트 안에 있는지 보고 내용에 `name`이 문자열 그대로 들어 있는지 본다. structural의 test 명령이 통과했는지도 본다 | 둘 다 맞으면 verified. 파일은 있는데 이름이 없으면 invalid. `file`이 없으면 unverified                                                                                                                            |
| `command` | `session.structuralResult.commands`에서 같은 명령 문자열(공백 정리 후)을 찾는다                                                   | 찾았고 종료 코드도 같으면 corroborated. 찾았는데 종료 코드가 다르면 invalid. 못 찾으면 unverified                                                                                                                 |
| `note`    | 아무것도 안 한다                                                                                                                  | unverified                                                                                                                                                                                                        |

서버는 명령을 직접 돌리지 않는다. structural 명령도 호스트가 돌리고 결과만 받는 구조라서(`src/execute/orchestrators/evaluation.ts:105-117`) 평가 근거만 따로 서버가 실행하면 경계가 흐려진다. AC 계약의 `check`가 `verifyBy: 'command'`나 `'test'`로 들어오면 그 명령을 structural 단계에 함께 싣는 편이 맞다. 그러면 command 근거가 corroborated로 올라갈 자리가 생긴다. 이 결정은 AC 계약 설계 쪽 몫이라 열린 질문에 남긴다.

**AC 단위 판정.** satisfied가 true인 AC에는 verified, relocated, corroborated 중 하나인 근거가 최소 하나 있어야 한다. 이런 근거를 "확인된 근거"라 부른다. `verifyBy: 'manual'`인 AC는 note 하나로도 satisfied를 인정한다. 대신 응답의 `manualChecks`에 올려 사람이 확인할 목록으로 보인다. satisfied가 false인 AC는 근거 확인을 판정에 쓰지 않는다. 그래도 invalid 근거는 결과에 남긴다.

### 근거 확인에 실패했을 때

선택지는 셋이었다.

| 안                                                    | 장점                                                  | 단점                                                             |
| ----------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| 바로 unverified로 내리고 받는다                       | 왕복이 없다                                           | 경로 오타 하나로 AC가 떨어진다. Evolve가 멀쩡한 AC를 고치러 간다 |
| 경고만 돌려주고 받는다                                | 기존 흐름과 같다                                      | 지금과 다를 게 없다. 경고는 읽히지 않는다                        |
| 한 번 돌려보내 고치게 하고 두 번째에는 내려서 받는다 | 실수는 고칠 기회가 있고 지어낸 근거는 점수에서 빠진다 | Call 3이 한 번 더 늘 수 있다                                     |

세 번째 안을 쓴다. structural 단계도 명령이 어긋나면 거부하고 같은 단계에서 다시 받는다(`src/execute/orchestrators/evaluation.ts:105-112`). 이 안도 같은 꼴이라 3-Call 패턴은 그대로 유지된다. 단계가 `contextual`에 머무르고 같은 `evaluate` + `evaluationResult` 요청을 다시 낼 뿐이다.

1. **첫 제출에서 확인된 근거가 없는 satisfied AC가 있으면** 세션을 완료하지 않는다. `status: "evidence_rejected"`와 `evidenceIssues`를 돌려준다. 단계는 `contextual`로 둔다. relocated는 문제로 치지 않는다. 서버가 이미 고쳤기 때문이다.
2. **두 번째 제출에서도 남으면** 받는다. 대신 그 AC의 satisfied를 false로 내리고 gaps 앞에 `근거를 서버가 확인하지 못했다: <problem>`을 넣는다. 인덱스는 `downgradedAcIndices`에 남긴다.
3. 내린 AC가 있으면 점수를 다시 계산한다. 제출된 `overallScore`에 "남은 satisfied AC의 가중치 합 / 처음 satisfied였던 AC의 가중치 합"을 곱한다. 가중치는 `classifiedACs`의 priority로 정한다. 채점자가 매긴 상대 가중을 존중하면서 근거 없는 몫만 덜어 내는 방식이다. 가중치 값은 `src/core/constants.ts`에 둔다.
4. `goalAlignment`는 서버가 고치지 않는다. 위치로 확인할 수 있는 값이 아니어서다.

거부 횟수는 프로세스를 넘어 유지돼야 한다. 세션을 다른 프로세스에서 이어 받는 경로가 있기 때문이다(`tests/unit/execute/session-cross-process.test.ts`). 그래서 `EventType.EXECUTE_EVALUATION_EVIDENCE_REJECTED` 이벤트를 새로 두고 `{ attempt, issues }`를 싣는다. `src/execute/repository.ts`가 replay할 때 `session.evidenceRejections`를 센다. `startContextualEvaluation`(`src/execute/session.ts:318-326`)이 이 값을 0으로 되돌린다. 그래서 Evolve 뒤 재평가는 기회를 다시 한 번 받는다.

### 흐름

```
Call 1  evaluate                         → structuralContext (변경 없음)
Call 2  evaluate + structuralResult      → contextualContext
          서버: 기준 트리 대비 바뀐 파일 집합을 계산해 세션에 둔다
          서버: evaluatorPacket과 isolation 지시를 만든다
        [스킬] 서브에이전트를 띄워 evaluatorPacket만 넘긴다
        [서브에이전트] 파일을 읽고 위치 근거로 채점한다
Call 3  evaluate + evaluationResult      → 서버가 근거를 확인한다
          확인된 근거 없는 satisfied AC 있음, 첫 회 → evidence_rejected (stage 그대로)
Call 3' evaluate + evaluationResult      → 남은 것은 내리고 완료
          통과 → completed (기존과 같음)
```

**바뀐 파일 집합.** 지금의 `collectChangedFiles`는 `HEAD~1..HEAD`와 작업 트리를 기준으로 한다(`src/execute/structural-commands.ts:131-141`). 실행 시작 시점과는 상관이 없다. 채점자에게 줄 목록은 기준 트리 대비여야 한다. `src/execute/artifact-verifier.ts`에 `collectChangedSinceBaseline(baseline)`을 더한다. 후보는 `git diff --name-only <baseline.head>`와 추적 안 되는 파일, `baseline.dirty`의 키를 합친 것이다. 이 후보를 `verifyArtifacts`(`src/execute/artifact-verifier.ts:173`)에 넣어 status가 `changed`인 것만 남긴다. 시작 전부터 dirty였는데 그 뒤로 안 바뀐 파일은 여기서 빠진다. `verifyArtifacts`가 비동기라 `submitStructuralResult`도 `Promise<Result<...>>`를 돌려주게 바꾼다. `execute_task` 핸들러가 이미 비동기이고 핸들러 타입도 `Promise<string> | string`을 받으므로(`src/mcp/tools/execute/types.ts:5-9`) 디스패처는 손대지 않는다.

기준 트리가 없으면(`workingTreeBaselineSkipped`가 있으면) 태스크 결과의 `artifacts` 합집합을 쓴다. 이때 `changeSetSource: "reported_artifacts"`로 출처를 밝힌다. 구현자의 주장이 섞였다는 표시다.

### MCP 요청과 응답 변경

**Call 2 응답의 `contextualContext`**

```jsonc
{
  "phase": "evaluating",
  "stage": "contextual",
  "systemPrompt": "...",            // 기존. 아래 프롬프트 변경 반영
  "evaluatePrompt": "...",          // 기존. 아래 프롬프트 변경 반영
  "evaluatorPacket": {
    "specGoal": "...",
    "constraints": ["..."],
    "acceptanceCriteria": [
      { "acIndex": 0, "id": "AC-1", "criterion": "...", "verifyBy": "test", "check": "...",
        "classification": "figure", "priority": "critical" }
    ],
    "repoRoot": "/abs/path",
    "changeSetSource": "baseline",  // 또는 "reported_artifacts"
    "changedFiles": ["src/a.ts", "tests/a.test.ts"],
    "diffCommand": "git diff <baseline.head> -- <changedFiles>",
    "structural": [{ "name": "test", "command": "pnpm run test", "exitCode": 0 }]
  },
  "isolation": {
    "required": true,
    "subagentType": "Explore",
    "tier": "frontier",
    "effort": "high",
    "instruction": "Spawn a fresh read-only sub-agent... pass evaluatorPacket, systemPrompt, evaluatePrompt only...",
    "fallback": "same_session_declared"
  },
  "spec": { ... },
  "classifiedACs": [ ... ],
  "structuralResult": { ... }
  // taskResults는 뺀다
}
```

- `taskResults`를 응답에서 뺀다(`src/execute/orchestrators/evaluation.ts:264`). 이 값은 호스트가 원래 가진 데이터라 빼도 잃는 게 없다. 실어 두면 스킬이 서브에이전트 프롬프트에 그대로 붙여 넣을 길이 열린다.
- `evaluatorPacket`에는 태스크의 `output`도, `artifacts` 주장도 넣지 않는다. 파일 목록은 git에서 나온 것만 넣는다. diff 본문은 크기가 커질 수 있어서 싣지 않는다. 대신 서브에이전트가 직접 돌릴 `diffCommand`를 준다.
- `structural`에는 명령과 종료 코드만 넣고 출력은 뺀다. 테스트 통과 여부는 사실이지만 출력 로그에 구현자의 커밋 메시지나 설명이 섞일 수 있어서다.
- `isolation.tier`는 `continuity-judge`와 같은 frontier다. 판정 행의 model과 effort 쌍을 그대로 따른다(`plugin/skills/_shared/agent-model.md:69`). 실제 model 값은 스킬이 `ges_status`의 `tierModels`에서 읽는다(`src/mcp/tools/status.ts:45`). 서버는 별칭을 박지 않는다.
- 서버는 호스트 종류를 안다(`src/mcp/server.ts:312`의 `input.client ?? config.client`). `client`가 `codex`이면 `isolation.instruction`에 Agent 도구가 없을 때의 폴백 문장을 먼저 적는다. 다만 판정은 스킬이 한다. Codex에도 서브에이전트 수단이 생기면 서버를 고치지 않고 스킬만 바꾸면 된다.
- `verbose: false`일 때 `stripContextPrompts`(`src/mcp/tools/execute/utils.ts:46-55`)는 지금처럼 프롬프트 키만 지운다. `evaluatorPacket`과 `isolation`은 남긴다.

**Call 3 요청의 `evaluationResult`** (`src/mcp/schemas.ts:311-326`)

```jsonc
{
  "verifications": [
    {
      "acIndex": 0,
      "acId": "AC-1",
      "satisfied": true,
      "evidence": [
        {
          "kind": "code",
          "path": "src/auth/oauth.ts",
          "line": 42,
          "excerpt": "export async function exchangeCode(",
        },
        { "kind": "test", "name": "exchanges code for token", "file": "tests/auth/oauth.test.ts" },
      ],
      "gaps": [],
    },
  ],
  "overallScore": 0.9,
  "goalAlignment": 0.85,
  "recommendations": [],
  "evaluator": { "isolation": "subagent", "model": "opus" },
}
```

스키마는 `evidence`에 `z.union([z.string(), z.array(AcEvidenceSchema)])`를 받는다. 문자열은 `[{ kind: 'note', text }]`로 정규화한다. `evaluator`는 선택이다. 없으면 `same_session`, `reason: "undeclared"`로 기록한다. 선언하지 않은 채점을 격리된 것으로 치지 않는다는 뜻이다.

**Call 3 거부 응답**

```jsonc
{
  "status": "evidence_rejected",
  "sessionId": "...",
  "stage": "contextual",
  "attempt": 1,
  "maxAttempts": 2,
  "evidenceIssues": [
    {
      "acIndex": 0,
      "evidenceIndex": 0,
      "status": "invalid",
      "problem": "src/auth/oauth.ts:42 줄이 excerpt로 시작하지 않고 위아래 200줄에서도 같은 줄이 없다",
    },
    {
      "acIndex": 2,
      "status": "no_confirmed_evidence",
      "problem": "satisfied=true인데 확인된 근거가 없다. note와 file 없는 test는 서버가 확인하지 못한다",
    },
  ],
  "nextAction": "evaluate",
  "hint": "evidenceIssues의 근거를 실제 파일 위치로 고쳐 같은 evaluationResult를 다시 제출하세요. 다음 제출에서도 남으면 그 AC는 미충족으로 내려갑니다.",
}
```

**Call 3 완료 응답**은 지금 꼴(`src/mcp/tools/execute/evaluate.ts:87-98`)에 아래를 더한다.

- `evaluationResult.verifications[].evidenceChecks`
- `evaluationResult.downgradedAcIndices`
- `evaluationResult.selfGraded`
- `manualChecks`: manual AC 중 note로만 satisfied가 된 것
- `selfGraded`가 true면 `message` 끝에 `구현한 세션이 직접 채점했다 (<reason>)`를 붙인다. `ProjectMemoryStore.addExecution`의 `resultSummary`(`src/mcp/tools/execute/evaluate.ts:48`)에도 같은 표시를 남긴다.

`selfGraded`는 통과 임계값을 바꾸지 않는다. 격리 여부를 점수에 섞기 시작하면 호스트마다 같은 결과가 다른 판정을 받는다. 지금은 드러내기만 한다. 임계값을 바꿀지는 열린 질문에 둔다.

### 프롬프트 변경

`src/execute/prompts.ts`

- `EXECUTE_EVALUATION_SYSTEM_PROMPT`(`:301-310`)의 "against the completed task outputs"를 "against the code in the repository"로 바꾼다. 규칙에 세 가지를 더한다. 근거는 반드시 파일 위치로 낸다. 위치를 못 대면 satisfied로 두지 않는다. 판단을 내리기 전에 파일을 열어 읽는다.
- `buildContextualEvaluationPrompt`(`:401-454`)의 시그니처를 `(packet: EvaluatorPacket)`로 바꾼다. `taskResults` 인자와 `resultSummary` 블록을 지운다. 대신 바뀐 파일 목록과 `diffCommand`, AC마다 `verifyBy`와 `check`를 싣는다. 예시 JSON의 evidence를 위 배열 꼴로 바꾸고 kind별 규칙을 짧게 적는다. excerpt는 그 줄을 그대로 복사한다. test 근거에는 file을 적는다. command 근거는 structural 목록의 명령일 때만 서버가 확인할 수 있다.
- 쓰는 곳이 없는 `buildEvaluationPrompt`(`:312-361`)는 지운다. 남겨 두면 문자열 evidence 예시가 한 벌 더 살아 있게 된다.
- `mergeSystemPrompt(..., 'evaluate')`(`src/execute/orchestrators/evaluation.ts:255-259`)가 붙이는 `continuity-judge` 페르소나는 "Gather evidence from task outputs"라고 적혀 있다(`plugin/agents/continuity-judge/AGENT.md`의 Core Behavior 2). 이 줄도 "Gather evidence from code locations"로 고친다.

### 스킬 변경

**`plugin/skills/execute/SKILL.md` Phase 3** (`:507-560`)

Call 2와 Call 3 사이에 "채점자 띄우기" 절을 넣는다. 내용은 아래와 같다.

1. `ges_status`에서 `tierModels`를 읽고 `contextualContext.isolation.tier`의 값을 model로 쓴다.
2. Agent 도구로 `subagent_type: "Explore"`인 새 서브에이전트를 띄운다. 부모 대화를 물려받는 종류(fork)는 쓰지 않는다. `doubt`와 같은 이유다(`plugin/skills/doubt/SKILL.md:135`).
3. 프롬프트에는 `systemPrompt`, `evaluatePrompt`, `evaluatorPacket` 세 가지만 넣는다. 구현 요약, 태스크 output, 대화 내용, "잘 된 것 같다" 같은 판단은 넣지 않는다.
4. 서브에이전트가 `ges_execute evaluate`로 Call 3을 직접 제출한다. 병렬 실행에서 서브에이전트가 `execute_task`를 직접 내는 것과 같은 꼴이다(`plugin/skills/execute/SKILL.md:377-388`). `evidence_rejected`가 오면 서브에이전트가 자기 근거를 고쳐 한 번 더 낸다. 채점 맥락을 가진 쪽이 고쳐야 근거가 바뀌지 않는다. 서브에이전트가 MCP 도구를 못 쓰는 환경이면 결과 JSON을 돌려받아 메인 세션이 고치지 않고 그대로 제출한다.
5. `evaluator`에는 `{ isolation: "subagent", model }`을 싣는다.

"단계를 건너뛰고 싶어질 때" 표(`:500-505` 근처)에 두 줄을 더한다.

| 변명                                                              | 반박                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| "방금 구현해서 다 아니까 내가 채점하는 게 빠르다"                 | 다 안다는 게 문제다. 구현 맥락이 있는 채점은 자기 설명을 다시 읽는 일이다. 서브에이전트를 띄운다 |
| "evidence_rejected가 왔으니 메인 세션이 줄 번호만 맞춰 다시 낸다" | 고치는 건 채점한 서브에이전트다. 메인 세션이 근거를 바꾸면 격리한 의미가 없어진다                |

**폴백.** Agent 도구가 없는 호스트(Codex 등)나 스폰이 실패한 경우를 다룬다. `doubt`는 이때 멈춘다(`plugin/skills/doubt/SKILL.md:137`). Evaluate는 파이프라인의 관문이라 멈추면 세션이 `contextual`에 묶인다. 그래서 여기서는 멈추지 않고 진행하되 숨기지 않는다.

1. 메인 세션이 직접 채점하되 `evaluatorPacket`에 있는 정보만으로 채점한다. 근거 위치 확인은 그대로 적용된다.
2. `evaluator: { isolation: "same_session", reason: "<Agent 도구 없음 | 스폰 실패: 메시지>" }`를 싣는다.
3. 완료 보고에 "Contextual 평가를 구현한 세션이 직접 했다"와 그 이유를 적는다. `tool-availability.md` 규칙 4(`plugin/skills/_shared/tool-availability.md:19`)의 적용이다.

`plugin/skills/_shared/tool-availability.md`에는 한 절을 더한다. "멈추는 대신 선언하고 진행하는 자리"라는 절이고 지금은 Evaluate 채점자 하나만 적는다. 멈추지 않는 이유도 함께 적는다.

**`plugin/skills/architecture/SKILL.md` Step 9**: 이슈 #57대로 "excerpt 불일치 경고가 나오면 후보 줄로 고친다" 한 줄을 넣는다.

**`docs/04-evaluate.md`, `docs/mcp-reference.md`**: Stage 2 타입 블록과 Call 3 예시, 거부 응답, 채점자 격리 절을 고친다. 소스 참조 표의 `src/execute/evaluate-context-builder.ts`는 지금 없는 파일이다. 같이 `src/execute/orchestrators/evaluation.ts`로 고친다.

## 바꿀 파일

| 파일                                           | 변경                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/source-location.ts`                  | 새 파일. `SourceFileCache`, `resolveInsideRoot`, `readSourceLines`, `checkLineExcerpt`                                                                           |
| `src/architecture/validator.ts`                | `LineCountCache`를 `SourceFileCache`로 교체. `checkCodeLocation`이 공용 유틸을 쓴다. excerpt 불일치 경고 추가                                                    |
| `src/core/types.ts`                            | `AcEvidence`, `EvidenceCheck`, `EvaluatorDeclaration` 추가. `ACVerification`과 `EvaluationResult` 확장. 세션에 `evidenceRejections`와 `evaluationChangeSet` 추가 |
| `src/core/constants.ts`                        | priority별 점수 가중치, 근거 재제출 상한(2), excerpt 탐색 창(200)                                                                                                |
| `src/execute/evidence-checker.ts`              | 새 파일. kind별 확인과 AC 단위 판정, 내림과 점수 재계산                                                                                                          |
| `src/execute/artifact-verifier.ts`             | `collectChangedSinceBaseline` 추가                                                                                                                               |
| `src/execute/orchestrators/evaluation.ts`      | Call 2 비동기화, 변경 집합 계산, `evaluatorPacket`과 `isolation` 생성, `taskResults` 제거. Call 3에서 근거 확인과 거부, 내림 처리                                |
| `src/execute/orchestrators/types.ts`           | `ContextualEvaluateContext` 필드 변경. `PassthroughEvaluateResult`에 `evidenceRejected`와 `evidenceIssues` 추가                                                  |
| `src/execute/passthrough-engine.ts`            | `submitStructuralResult` 반환 타입을 Promise로                                                                                                                   |
| `src/execute/session.ts`                       | 거부 이벤트 기록, `startContextualEvaluation`에서 카운터 초기화                                                                                                  |
| `src/execute/repository.ts`                    | 거부 이벤트 replay. 옛 문자열 evidence 정규화. `buildShortCircuitEvaluation`(`:32-44`)의 evidence를 note 배열로                                                  |
| `src/events/types.ts`                          | `EXECUTE_EVALUATION_EVIDENCE_REJECTED`                                                                                                                           |
| `src/execute/prompts.ts`                       | 시스템 프롬프트와 contextual 프롬프트 재작성. `buildEvaluationPrompt` 삭제                                                                                       |
| `src/mcp/schemas.ts`                           | `evidence` union, `acId`, `evaluator`                                                                                                                            |
| `src/mcp/tools/execute/evaluate.ts`            | Call 2 await, `evidence_rejected` 응답, 완료 응답에 `selfGraded`와 `manualChecks`                                                                                |
| `plugin/agents/continuity-judge/AGENT.md`      | 근거 수집 문장 수정                                                                                                                                              |
| `plugin/skills/execute/SKILL.md`               | Phase 3 채점자 띄우기 절, 폴백, 변명 표, Call 3 예시                                                                                                             |
| `plugin/skills/_shared/tool-availability.md`   | 선언하고 진행하는 자리 절                                                                                                                                        |
| `plugin/skills/architecture/SKILL.md`          | Step 9 한 줄                                                                                                                                                     |
| `docs/04-evaluate.md`, `docs/mcp-reference.md` | 타입, 예시, 흐름                                                                                                                                                 |

## 하위 호환

- **옛 스킬이 문자열 evidence를 낸다.** 플러그인 캐시가 서버보다 뒤처지는 일은 실제로 있다(`src/mcp/CLAUDE.md`). 스키마가 문자열을 받아 note로 정규화하므로 요청이 깨지지는 않는다. 다만 satisfied AC마다 확인된 근거가 없으니 첫 제출은 `evidence_rejected`가 된다. hint 문장이 무엇을 고칠지 알려 주므로 옛 스킬로도 다시 낼 수 있다. 계속 문자열로 내면 두 번째에 내려간다. 이 동작은 의도한 것이다. 문자열 근거를 계속 통과시키면 이 설계가 없는 것과 같다.
- **저장된 이벤트의 `evaluationResult`.** `EXECUTE_EVALUATION_COMPLETED`와 `EVALUATE_SHORT_CIRCUITED`에 문자열 evidence가 들어 있다(`src/execute/session.ts:335-338`, `src/execute/session.ts:354-360`). replay(`src/execute/repository.ts:261-271`)에서 정규화 함수를 거쳐 note 배열로 바꾼다. 이벤트는 다시 쓰지 않는다.
- **evidence를 읽는 다른 곳.** `src/resilience/prompts.ts:82-93`, `src/resilience/lateral.ts:95`, Evolve 프롬프트(`src/execute/prompts.ts:581`)는 `gaps`와 `satisfied`만 읽는다. 바뀌는 건 내려간 AC의 gaps 앞에 사유가 붙는 것뿐이다. 그 덕에 Evolve가 근거 없는 AC를 진짜 결함으로 다루게 된다.
- **`contextualContext.taskResults` 제거.** 스킬은 이 필드를 직접 읽지 않는다(`plugin/skills/execute/SKILL.md:541`은 `contextualContext` 전체만 언급한다). 외부에서 MCP를 직접 부르는 사용자가 읽고 있었다면 깨진다. 릴리스 노트에 적는다.
- **아키텍처 검증.** 오류는 늘지 않고 경고만 는다. 줄 세기 규칙을 그대로 옮기므로 기존 범위 판정 테스트는 그대로 통과해야 한다.
- **`evaluator`를 안 보내는 클라이언트.** 거부하지 않는다. `selfGraded: true`, `reason: "undeclared"`로 기록만 한다.

## 테스트

`tests/unit/core/source-location.test.ts` (새 파일)

- 줄이 excerpt로 시작하면 match다. 앞뒤 공백과 들여쓰기가 달라도 match다.
- 줄이 밀리면 moved이고 candidates가 가까운 순으로 나온다. 창(200줄) 밖이면 mismatch다.
- 여러 줄 excerpt가 이어지는 줄과 맞는다.
- 줄 번호 0, 음수, 마지막 줄 다음은 out_of_range다. 마지막 빈 줄은 세지 않는다.
- 절대 경로와 `../` 경로는 루트 밖으로 거부된다. 2MB를 넘는 파일은 null이다.
- 같은 파일을 두 번 물어도 한 번만 읽는다(캐시).

`tests/unit/architecture/validator.test.ts`

- 이슈 #57 완료 기준 세 가지. 밀린 근거에는 후보 줄이 담긴 경고가 나온다. excerpt로 시작하는 줄에는 경고가 없다. excerpt가 없는 근거와 private 근거에도 경고가 없다.
- 기존 `CODE_EVIDENCE_NOT_FOUND` 케이스가 그대로 통과한다.

`tests/unit/execute/evidence-checker.test.ts` (새 파일)

- kind별 표의 각 칸을 하나씩 확인한다. code는 verified, relocated, invalid 세 종류다. test는 file이 있을 때와 없을 때다. command는 structural과 맞을 때, 종료 코드가 다를 때, 목록에 없을 때다.
- manual AC는 note만으로 satisfied가 유지되고 `manualChecks`에 오른다.
- 내림 뒤 점수 재계산이 priority 가중에 맞는다. satisfied AC가 하나도 안 남으면 0이다.

`tests/unit/execute/execution-evaluate.test.ts`

- Call 2 응답에 `taskResults`가 없고 `evaluatorPacket.changedFiles`가 기준 트리 대비 바뀐 파일만 담는다. 시작 전부터 dirty였고 그 뒤로 안 바뀐 파일은 빠진다.
- 기준 트리가 없으면 `changeSetSource: "reported_artifacts"`다.
- 첫 Call 3에 지어낸 경로를 내면 `evidence_rejected`이고 stage가 `contextual`로 남는다. 고친 제출은 완료된다.
- 두 번 연속 실패하면 완료되고 `downgradedAcIndices`가 채워진다. 점수가 내려간다.
- `evaluator`가 없거나 `same_session`이면 `selfGraded: true`이고 message에 사유가 붙는다.

`tests/unit/execute/session-cross-process.test.ts`

- 첫 거부 뒤 다른 프로세스에서 세션을 이어 받아도 두 번째 제출이 내림으로 처리된다(카운터 replay).

`tests/unit/execute/repository.test.ts`

- 문자열 evidence가 든 옛 이벤트를 replay하면 note 배열이 된다. short-circuit 결과도 note 배열이다.

스킬 쪽은 `pnpm gate`의 `verify:skill-confusion`과 `verify:routing`이 통과하는지만 본다. 서브에이전트 스폰은 단위 테스트로 검증할 수 없다. 이 레포로 한 번 수동 실행해 보고 그 결과를 PR 본문에 남긴다.

## PR 나누기

1. **공용 유틸과 아키텍처 경고 (이슈 #57 해결)**. `src/core/source-location.ts`, `validator.ts` 교체, 경고 코드, architecture 스킬 Step 9 한 줄, 테스트. 평가와 독립이라 먼저 들어간다.
2. **근거 타입과 서버 확인**. 타입, 스키마 union, `evidence-checker.ts`, Call 3 거부와 내림, 이벤트와 replay, 프롬프트의 evidence 예시 교체, `continuity-judge` 문장. 채점자는 아직 같은 세션이다. 이 PR만으로도 지어낸 근거가 점수에서 빠진다.
3. **맥락 없는 채점자**. `collectChangedSinceBaseline`, Call 2 비동기화, `evaluatorPacket`과 `isolation`, `taskResults` 제거, `evaluator` 선언과 `selfGraded`, execute 스킬 Phase 3와 폴백, tool-availability 절, 문서.

2번이 1번에 기대고 3번이 2번의 프롬프트에 기댄다. AC 계약 설계가 먼저 들어오면 2번에서 `acId`와 `verifyBy`를 바로 쓴다. 늦게 들어오면 2번은 `acIndex`만으로 동작하고 manual 예외는 계약이 들어올 때 켠다.

## 열린 질문

1. **AC `check` 명령을 structural 단계에 실을지.** 실으면 command 근거와 test 근거가 corroborated로 올라갈 길이 생긴다. 대신 Call 1 명령 목록이 길어지고 `findCommandMismatches`의 대조 대상이 늘어난다. AC 계약 설계와 함께 정한다.
2. **`selfGraded`일 때 임계값을 올릴지.** 지금은 표시만 한다. 같은 세션 채점이 실제로 점수를 얼마나 부풀리는지는 `benchmarks/`의 golden set에서 격리 채점과 비교해 보고 정한다(`docs/roadmap.md`의 효과 증명 묶음).
3. **Agent 도구가 없는 호스트에서 새 프로세스로 채점할지.** Codex에서 `codex exec`나 `claude -p` 같은 새 프로세스를 띄우면 맥락 없는 채점이 된다. 하지만 셸에서 다른 에이전트 CLI를 띄우는 건 `dispatch` 영역이고 설치 여부도 알 수 없다. 이번에는 선언형 폴백만 두고 쓰임새가 보이면 그때 넣는다.
4. **재제출 상한을 2로 둘지.** 한 번 고칠 기회면 오타는 대부분 잡힐 것으로 본다. 내림이 실제로 얼마나 나오는지 이벤트로 세어 보고 조정한다.
5. **relocated를 그냥 받아도 되는지.** 후보가 여럿일 때 가장 가까운 줄을 고르는 건 평가에서는 무해하다. 다만 채점자가 엉뚱한 함수를 가리켰는데 같은 줄 내용이 근처에 우연히 있으면 통과한다. 이 경우를 `relocated`와 후보 목록으로 남겨 두고 문제가 보이면 후보가 둘 이상일 때 invalid로 바꾼다.
6. **메인 세션이 서브에이전트 결과를 고쳐 내는 경우.** 서버는 이를 막을 수 없다. 이 설계는 적대적인 호스트를 막으려는 게 아니라 같은 컨텍스트로 채점하는 걸 피하려는 것이다. 토큰 서명 같은 장치는 넣지 않는다. 필요해지면 따로 다룬다.
