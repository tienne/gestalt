# 해상도 점수를 관찰 신호와 실제 결과로 보정하기

## 배경

인터뷰를 끝내고 스펙을 만들어도 되는지는 해상도 점수 하나로 정한다. 그런데 이 점수의 재료는 호스트 LLM이 직접 쓴 0~1 숫자다. Amrut Joshi의 글 [Asking LLM for confidence](https://rumple.github.io/blog/2026/10/20/asking-llm-for-confidence.html)(2026-10-20)가 이 구조의 문제를 짚는다. 요지는 다음과 같다.

- LLM이 쓴 "0.85"는 모델 안에서 잰 값이 아니다. 토큰을 이어 쓴 텍스트다.
- 사전학습은 자기가 쓴 숫자가 실제 정답률과 맞는지를 채점하지 않는다.
- 같은 질문을 다시 하면 숫자가 바뀌고 "Are you sure?" 같은 말에도 흔들린다. 앞에서 자신 있게 말했으면 뒤에 높은 숫자가 따라 나온다.
- 믿을 만한 확신도는 예측에 쓴 정보량을 반영해야 하고 같은 종류의 질문에서 실제 결과와 맞춰본 적이 있어야 한다. 매일 계절 평균 30%만 말하는 예보관은 숫자는 맞지만 정보를 안 쓰니 쓸모가 없다.
- 그래서 확신도는 관찰할 수 있는 신호로 만든 규칙으로 계산하고 결과를 기록해 구간별로 맞는지 계속 확인하라고 권한다.

로드맵 1절도 같은 문제를 적어 두었다. "현재 0.8은 LLM이 스스로 매긴 점수가 임계치를 넘었다는 의미일 뿐이다"(`docs/roadmap.md` 1절). 코드에서 확인한 지금 상태는 다음과 같다.

| 자리          | 지금 동작                                                                                                                                                                    | 근거                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 원점수        | 호스트 LLM이 차원마다 0~1을 쓴다. 프롬프트는 "Score each dimension from 0.0 (completely ambiguous) to 1.0 (crystal clear)" 한 줄이고 점수별 기준이나 예시가 없다             | `src/llm/prompts.ts:83-96`                                                                                  |
| 입력 검증     | 범위(`min(0).max(1)`)만 본다. 내용 검사는 답한 라운드가 하나도 없는데 `isReady`인 점수를 거부하는 것 하나뿐이다                                                              | `src/mcp/schemas.ts:40-50`, `src/interview/passthrough-engine.ts:343-353`                                   |
| 다시 채점하기 | 없다. 채점할 때마다 새 점수가 앞 점수를 덮어쓴다                                                                                                                             | `src/interview/session.ts:179-196`                                                                          |
| 모순 감점     | 모순 개수에 따라 0.05~0.15를 깎는다. 모순 목록도 LLM이 쓴 텍스트다                                                                                                           | `src/gestalt/analyzer.ts:96-102`                                                                            |
| 판정          | `overall >= RESOLUTION_THRESHOLD`(0.8)이면 인터뷰를 끝낼 수 있고 스펙을 만들 수 있다. 아래면 force로만 넘어간다                                                              | `src/gestalt/analyzer.ts:91`, `src/interview/session.ts:212-221`, `src/spec/passthrough-generator.ts:79-83` |
| 기준값 설정   | `interview.resolutionThreshold` 설정과 `GESTALT_RESOLUTION_THRESHOLD` 환경 변수가 있지만 판정 코드는 전부 상수를 직접 읽는다. 설정을 바꿔도 판정은 그대로다                  | `src/core/config.ts:43`, `src/core/config.ts:531-532`, `src/core/constants.ts:3`                            |
| 결과와 대조   | 해상도 점수를 실제 결과와 맞춰본 기록이 없다. `specHistory`에 점수가 안 남고 스펙의 `metadata.resolutionScore`는 읽는 곳이 없다                                              | `src/core/types.ts:725-731`, `src/spec/passthrough-generator.ts:103`                                        |
| 벤치마크      | `run-resolution-benchmark.ts`는 `computeResolutionScore`를 부르지 않는다. 0.5/0.65/0.8 라벨이 붙은 고정 문맥을 judge에게 주고 judge가 쓴 `reworkProbability`의 단조성만 본다 | `benchmarks/run-resolution-benchmark.ts:183-212`, `benchmarks/run-resolution-benchmark.ts:286-291`          |

로드맵의 증명 사다리와 견주면 빈자리가 보인다. ① 재현성은 같은 입력을 다섯 번 채점해 분산만 본다. 분산이 작아도 결과와 안 맞을 수 있다. 계절 평균만 말하는 예보관도 분산은 0이다. ③ 인과성에 쓸 실제 결과는 [outcome-feedback.md](./outcome-feedback.md)가 모은다. 그 문서는 해상도 구간별 재작업률을 내는 스크립트(`benchmarks/outcome-correlation.ts`)까지 적었지만 판정 규칙을 어떻게 바꿀지는 열린 질문 8번으로 남겨 두었다.

이 제안은 그 사이를 채운다. 해상도 점수 옆에 서버가 직접 세는 신호를 기록하고 마지막 채점을 한 번 더 받아 흔들림을 남긴다. outcome-feedback이 모은 결과로 점수 구간과 신호 조합마다 실제로 어땠는지 표를 만든다. 표가 근거를 보여준 다음에만 판정을 LLM 숫자에서 신호 규칙 쪽으로 옮긴다.

## 설계

### 원칙

1. LLM이 쓴 숫자는 판정 재료로 남기지만 혼자서 게이트를 열지 못하게 한다.
2. 신호는 서버가 세션 상태에서 직접 센다. LLM이 쓴 텍스트에서 나온 신호는 따로 표시한다.
3. 판정 규칙을 바꾸려면 결과 표가 먼저 커밋돼 있어야 한다. outcome-feedback 열린 질문 8번의 기본값(첫 결과 문서 전에는 기준을 안 건드린다)을 그대로 따른다.
4. 바꾸는 단계마다 설정으로 끄고 켤 수 있게 한다. 기본값은 기록만 하는 쪽이다.

### 파트 1. 기준값 설정 연결

판정 규칙을 데이터로 바꾸려면 우선 기준값이 설정에서 들어와야 한다. 지금은 `RESOLUTION_THRESHOLD`를 직접 읽는 곳이 다섯 군데다.

- `src/gestalt/analyzer.ts:91`
- `src/spec/generator.ts:28`
- `src/spec/passthrough-generator.ts:80`
- `src/interview/session.ts:216`
- `src/interview/repository.ts:142`

`computeResolutionScore`에 `threshold` 인자를 더하고 호출부가 `config.interview.resolutionThreshold`를 넘긴다. 상수는 설정 기본값으로만 쓴다. `src/cli/commands/interview.ts:83`의 안내 문구도 설정값을 찍는다. Evaluate 기준값(`EVOLVE_SUCCESS_THRESHOLD`, `EVOLVE_GOAL_ALIGNMENT_THRESHOLD`, `src/core/constants.ts:127-128`)도 설정(`src/core/config.ts:49-50`)이 판정에 안 들어가는 같은 문제가 있다. 같은 PR에서 고친다.

저장된 이벤트로 세션을 다시 만드는 쪽은 따로 봐야 한다. `src/interview/repository.ts:113-117`은 이벤트에 저장된 `isReady`를 다시 계산하지 않고 그대로 읽는다. 기준값을 바꾼 뒤 예전 세션을 열면 예전 기준으로 낸 판정이 남는다. 이 동작은 유지한다. 이벤트는 그 시점의 판정을 기록한 것이기 때문이다. 대신 이벤트에 `threshold`를 같이 남겨서 어느 기준으로 낸 판정인지 보이게 한다.

### 파트 2. 서버가 세는 신호

`ResolutionScore`에 선택 필드 `signals`를 더한다. 채점이 들어올 때마다 서버가 세션 상태로 계산한다. LLM에게 묻지 않는다.

```ts
export interface ResolutionSignals {
  /** 답이 비어 있지 않은 라운드 수 */
  answeredRounds: number;
  /** 답을 보냈지만 공백뿐인 라운드 수. 답을 기다리는 마지막 라운드는 세지 않는다 */
  emptyRounds: number;
  /** "알아서", "모르겠", "나중에", "up to you" 같은 위임 답변으로 판정한 라운드 수 */
  deferredRounds: number;
  /**
   * 점수가 0.8 이상인데 그 차원의 원칙으로 질문한 라운드가 하나도 없는 차원.
   * 차원과 원칙의 짝은 analyzer.ts의 dimensions 정의를 따른다
   */
  unaskedConfidentDimensions: ResolutionDimensionName[];
  /** 직전 채점보다 overall이 오른 폭. 내려가면 음수. 첫 채점이면 null */
  overallJump: number | null;
  /** 이 세션에서 지금까지 가장 크게 오른 폭. 결과 표의 overall_jump_max를 specHistory만으로 채우려고 둔다 */
  maxOverallJump: number | null;
  /** 마지막 채점의 모순 수. 모순 목록은 LLM이 쓴 텍스트라 llmDerived로 묶는다 */
  llmDerived: { contradictions: number };
  /** 파트 3의 다시 채점하기 결과. 아직 안 했으면 없음 */
  rescore?: RescoreResult;
}
```

`ResolutionDimensionName`은 [interview-grounding.md](./interview-grounding.md)가 더하는 타입을 같이 쓴다. 그 문서가 먼저 머지되지 않으면 이 PR에서 정의하고 그쪽이 가져다 쓴다.

신호마다 고른 이유는 다음과 같다. 정답 신호라서 고른 게 아니다. 결과 표에서 점수보다 결과를 잘 가르는지 확인할 후보다.

| 신호                            | 왜 후보인가                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `answeredRounds`, `emptyRounds` | 글이 말한 "예측에 쓴 정보량"에 가장 가깝다. 답이 적은데 점수가 높으면 정보 없이 숫자만 오른 것이다                                                                        |
| `deferredRounds`                | 사용자가 결정을 넘긴 답은 문장으로는 답이지만 요구사항을 채우지 않는다. LLM 채점은 답이 있다는 사실에 끌려 점수를 올리기 쉽다                                             |
| `unaskedConfidentDimensions`    | 한 번도 묻지 않은 차원에 높은 점수가 붙었다면 다른 답에서 추론했거나 지어낸 것이다. 질문 주제(`InterviewRound.gestaltFocus`)는 서버가 고르므로 기록이 정확하다(아래 참고) |
| `overallJump`                   | 앞에서 자신 있게 쓰면 뒤 숫자가 따라 오른다는 글의 관찰과 맞닿는다. 한 라운드에 0.3 넘게 뛰면 답 하나로 여러 차원이 한꺼번에 채워졌다고 봐야 하는데 그런 일은 드물다      |
| `llmDerived.contradictions`     | 지금도 감점에 쓴다. LLM 텍스트에서 나온 값이라 다른 신호와 섞지 않고 따로 둔다                                                                                            |

passthrough 경로는 이 기록이 틀려 있었다. 호스트는 직전 응답의 `gestaltContext.currentPrinciple`로 질문을 만드는데 서버는 새 라운드에 바로 앞 라운드의 `gestaltFocus`를 복사해 넣었다. 그래서 모든 라운드가 첫 라운드 원칙(closure)으로 남았다. 이 신호를 세려면 그 기록부터 맞아야 해서 이 파트에서 같이 고친다. 직전 `respond`가 그 라운드 번호로 남긴 `GESTALT_PRINCIPLE_APPLIED` 이벤트의 원칙을 라운드에 쓴다.

`deferredRounds`의 판정은 정규식 목록(`src/gestalt/signals.ts`의 `DEFERRED_ANSWER_PATTERNS`)으로 한다. 한국어와 영어를 같이 둔다. 답 전체가 짧고(40자 이하) 패턴에 걸릴 때만 센다. 긴 답 안에 "나중에"가 들어간 것까지 세면 잘못 세는 경우가 많아진다.

[interview-grounding.md](./interview-grounding.md)가 머지되면 `openAssumptions`(확인 안 된 가정 수)를 더한다. [ac-verification.md](./ac-verification.md)가 머지되면 스펙 단계 신호로 `machineCheckableAcRatio`(`verifyBy`가 `test`나 `command`인 AC 비율)를 `specHistory`에 남긴다. 둘 다 그 문서의 PR 뒤에 얹는다.

신호는 세 군데에 남는다.

- `INTERVIEW_RESOLUTION_SCORED` 이벤트 payload에 `signals`와 `threshold`를 더한다(`src/interview/session.ts:190-196`).
- 스펙 생성 때 `SpecHistoryEntry`에 `resolutionScore`와 `resolutionSignals?: ResolutionSignals`를 더한다. 그래야 이벤트 DB가 없는 팀원도 결과 표를 만들 수 있다. `resolutionScore`는 outcome-feedback이 정한 필드와 이름과 의미가 같다(스펙을 만든 시점의 해상도, text 소스면 null). outcome-feedback PR 2를 기다리지 않고 이 파트에서 먼저 넣는다.
- `ges_status`의 인터뷰 요약에 신호 한 줄을 붙인다. 예: `답변 6/7, 위임 답변 1, 안 물은 차원: 우선순위`. API 키 경로(`src/mcp/tools/status.ts`)는 `summary` 뒤에 붙이고 passthrough 경로(`src/mcp/server.ts`의 `handleStatusPassthrough`)는 `summary`가 없어서 `session.signalSummary`로 싣는다. 두 경로 모두 같은 문자열을 `signalSummary`에도 둔다.

이 파트는 판정을 바꾸지 않는다.

### 파트 3. 마지막 채점은 두 번

글이 지적한 "다시 물으면 바뀐다"를 실제 세션에서 남긴다. 매 라운드 두 번 채점하면 비용이 두 배가 되므로 판정이 걸린 채점 한 번만 다시 받는다.

흐름은 다음과 같다.

1. 호스트가 `respond`나 `score`로 제출한 점수가 처음으로 기준값을 넘으면 서버는 그 점수를 저장하고 응답에 `rescorePrompt`를 싣는다. `nextAction`은 `rescore`다.
2. `rescorePrompt`는 `buildResolutionPrompt`와 같은 본문이지만 지금까지의 점수와 이전 채점의 `reasoning`을 빼고 대화 기록만 담는다.
3. 호스트는 이 프롬프트를 인터뷰 맥락이 없는 서브에이전트에게 맡긴다. 방법은 [evaluate-evidence.md](./evaluate-evidence.md)의 Contextual 채점 위임과 같고 서브에이전트를 못 띄우는 런타임의 폴백도 `plugin/skills/_shared/agent-delegation.md`를 따른다. 폴백으로 같은 세션에서 다시 채점했으면 `rescoreMode: 'same-context'`로 표시한다. 맥락이 이어진 채점은 앞 숫자를 따라가기 쉬워서 흔들림이 덜 드러나기 때문이다.
4. 호스트가 `score`를 `rescore: true`와 함께 다시 부른다. 서버는 두 점수를 비교해 `RescoreResult`를 남긴다.

```ts
export interface RescoreResult {
  mode: 'isolated' | 'same-context';
  /** 두 번째 채점의 overall */
  overall: number;
  /** 차원별 |첫 점수 - 두 번째 점수| 중 가장 큰 값 */
  maxDimensionSpread: number;
  /** 첫 채점에서 기준값 이상이었다가 두 번째 채점에서 아래로 떨어진 차원 */
  droppedDimensions: ResolutionDimensionName[];
}
```

판정에 어떻게 쓸지는 설정 `interview.rescore`로 정한다.

| 값              | 동작                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`           | 다시 채점하지 않는다                                                                                                                                       |
| `record` (기본) | 다시 채점해서 기록만 한다. `isReady`는 첫 점수로 정한다                                                                                                    |
| `gate`          | 두 overall 중 낮은 쪽으로 `isReady`를 정한다. `maxDimensionSpread`가 0.2를 넘으면 `isReady`를 false로 두고 가장 많이 흔들린 차원을 다음 질문 주제로 고른다 |

`gate`로 기본값을 옮기는 시점은 파트 5의 절차를 따른다.

다시 채점하기는 인터뷰 하나에 한 번만 한다. 기준값을 넘었다가 다음 라운드에서 다시 떨어지고 또 넘는 경우에도 두 번째부터는 받지 않는다. 추가 비용을 한 번으로 제한하려는 것이고 그 경우는 `overallJump`로 따로 보인다.

구현하면서 위 흐름에 없던 것을 아래처럼 정했다.

- 스킬 흐름에서는 호스트가 점수를 대부분 `respond`에 실어 보낸다. 그래서 `respond`로 처음 넘어도 `rescorePrompt`를 싣는다.
- `gate`는 다시 채점을 받기 전까지 `isReady`를 false로 둔다. 안내를 건너뛰고 `complete`를 부르면 첫 점수로 끝나 버려서 `gate`가 의미가 없어지기 때문이다. 받기 전까지는 넘을 때마다 `rescorePrompt`를 다시 싣는다. `record`는 처음 넘을 때 한 번만 싣는다.
- `gate`에서 흔들림은 0.2 이하인데 낮은 쪽 overall이 기준값 아래라 판정을 미룬 경우는 낮은 쪽 점수로 다음 원칙을 고른다. 흔들림이 0.2를 넘으면 가장 많이 흔들린 차원의 원칙을 고른다. 어느 쪽이든 `rescore` 응답에 그 원칙으로 만든 `gestaltContext`를 싣는다.
- `rescoreMode`를 안 넘기면 `same-context`로 남긴다. 실제로는 맥락이 이어진 채점을 `isolated`로 잘못 남기는 것보다 반대쪽 실수가 결과를 덜 흐린다.
- 결과는 `interview.resolution.rescored` 이벤트로 따로 남긴다. 채점 이벤트로 남기면 `overallJump`와 처음 넘은 시점 판단이 섞인다. `signals.rescore`는 이후 채점의 신호에도 이어 붙여서 `specHistory`의 `resolutionSignals`만으로 결과 표를 채울 수 있게 한다.
- 다시 채점은 첫 채점과 같은 모델로 받는 걸 목표로 한다(열린 질문 3). 스킬은 서브에이전트에 `tierModels.frontier`를 넘긴다. 스킬 문서 규칙상 `model`을 비울 수 없어서 세션 모델을 물려받는 대신 인터뷰를 보통 돌리는 frontier 모델을 고정했다. API 키 경로는 같은 채점기로 새 호출을 한 번 더 해서 `isolated`로 남긴다. 그 호출이 실패하면 경고만 남기고 인터뷰는 이어간다.
- `interview.rescore`에는 환경변수를 두지 않고 `gestalt.json`에서만 정한다.

### 파트 4. 결과 표

outcome-feedback이 내보내는 CSV(`gestalt outcome export --format csv`)에 열을 더하고 그 CSV로 구간별 표를 만든다.

더하는 열은 `answered_rounds`, `empty_rounds`, `deferred_rounds`, `unasked_confident_dims`, `overall_jump_max`, `contradictions`, `rescore_mode`, `rescore_overall`, `rescore_spread`, `threshold`다. 인터뷰 없이 텍스트로 만든 스펙은 전부 비운다.

표는 `benchmarks/resolution-calibration.ts`가 만든다. outcome-feedback의 `benchmarks/outcome-correlation.ts`와 같은 CSV를 읽는 짧은 스크립트이고 CLI에는 넣지 않는다. 결과는 `docs/experiments/`에 날짜를 붙인 md와 csv로 남긴다.

결과 칸은 outcome-feedback의 정의를 그대로 쓴다. `rough`는 리뷰 3라운드 이상, 재작업 커밋 1개 이상, 사람 게이트 1번 이상, evolve 2세대 이상 중 하나라도 해당하는 스펙이다.

첫 번째는 점수 구간별 표다.

```
| 해상도 구간 | 스펙 수 | rough 비율 | 리뷰 라운드 중앙값 | 재작업 커밋 평균 |
| --- | --- | --- | --- | --- |
| force (< 기준값) | | | | |
| 기준값 ~ 0.85 | | | | |
| 0.85 ~ 0.90 | | | | |
| 0.90 이상 | | | | |
```

두 번째는 신호별 표다. 신호마다 두 칸으로 나눠 rough 비율을 비교한다.

```
| 신호 | 칸 A | 칸 A rough 비율 (n) | 칸 B | 칸 B rough 비율 (n) |
| --- | --- | --- | --- | --- |
| 안 물은 차원 | 없음 | | 1개 이상 | |
| 위임 답변 | 0 | | 1 이상 | |
| 다시 채점 흔들림 | 0.2 이하 | | 0.2 초과 | |
| overall 점프 | 0.3 이하 | | 0.3 초과 | |
```

스크립트를 쓰면서 위 표에 없던 것을 아래처럼 정했다.

- 해상도 점수가 빈 행(텍스트 스펙)과 `status`가 `final`이 아닌 행은 표에서 뺀다. `pending` 행은 재작업 수치가 덜 쌓여 rough 비율을 낮춰 보이게 한다. 뺀 행 수는 표 아래 문장에 적는다.
- force 구간은 행마다 남은 `threshold`로 가른다. 기준값을 바꾼 스펙도 그때의 기준으로 판정한다. `threshold`가 비면 0.8로 본다.
- 신호 값이 빈 행은 신호별 표의 어느 칸에도 넣지 않는다. 다시 채점을 안 받은 스펙은 흔들림 칸 대신 표 아래 문장에 수만 적는다.
- "표본 부족"은 rough 비율 칸 뒤에 붙인다. 숫자는 그대로 둔다.
- 아래 `--judge-csv` 비교 옵션은 이번에 넣지 않았다. judge 예측을 담은 CSV 형식이 아직 없어서다.

표를 읽는 규칙도 같이 정해 둔다. 결과 문서마다 이 규칙에 따라 판정한 문장을 적는다.

- 칸 하나에 스펙이 20개 미만이면 그 칸은 결론을 내지 않는다. 숫자만 적고 "표본 부족"이라고 쓴다.
- 점수 구간이 올라가도 rough 비율이 내려가지 않으면 기준값 위에서 점수가 결과를 가르지 못한다고 적는다.
- 신호 칸 사이의 rough 비율 차이가 점수 구간 사이의 차이보다 크면 그 신호를 파트 5의 게이트 후보로 올린다.

이 표로 답할 수 없는 질문도 적어 둔다. 기준값 아래 스펙은 force로만 생기므로 수가 적고 일부러 넘긴 스펙이라 치우쳐 있다. "0.8이 0.5보다 낫다"는 이 표로 증명할 수 없고 로드맵 ② 단조성 실험이 필요하다. 이 표가 답하는 질문은 "기준값을 넘긴 스펙들 사이에서 무엇이 나쁜 결과를 미리 알려주는가"다.

### 파트 5. 판정 규칙을 옮기는 절차

결과 표가 커밋된 뒤에만 판정을 바꾼다. 단계마다 PR 하나이고 PR 본문에 근거가 된 결과 문서 경로를 적는다.

1. **기록 단계.** 파트 2와 파트 3의 `record`까지다. 판정은 지금과 같다.
2. **신호 게이트.** 신호별 표에서 rough 비율을 크게 가른 신호를 하드 게이트로 올린다. 예를 들어 "안 물은 차원이 있으면 `isReady`가 false이고 다음 질문 주제를 그 차원으로 고른다" 같은 규칙이다. 어떤 신호를 올릴지는 표를 보고 정하고 이 문서에서 미리 정하지 않는다. `interview.rescore`를 `gate`로 바꾸는 것도 이 단계에서 같은 기준으로 정한다.
3. **규칙 기반 준비도.** 신호 조합별 rough 비율이 안정되면 `isReady`를 신호 규칙이 정하고 LLM 해상도 점수는 표시와 질문 주제 고르기에만 쓴다. 이 단계는 스펙이 수백 개 쌓인 뒤의 일이라 열린 질문으로 남긴다.

단계 2와 3에서 기준을 바꾸면 그 뒤로 쌓이는 결과는 이전 결과와 섞어서 비교하지 않는다. 이벤트와 `specHistory`에 남는 `threshold`와 규칙 버전(`readinessRuleVersion`)으로 나눠서 표를 만든다. 지금 규칙은 버전 1이다. 채점 이벤트와 다시 채점 이벤트에는 `threshold`와 `readinessRuleVersion`이 둘 다 남는다. `specHistory`에는 `readinessRuleVersion`만 남고 인터뷰로 만든 스펙에만 붙는다. `specHistory`의 기준값은 outcome-feedback의 CSV 내보내기를 만들 때 같이 정한다.

### 파트 6. 그 밖에 LLM이 쓴 숫자

해상도 말고도 LLM이 쓴 확신도 숫자가 남는 자리가 있다. 지금은 대부분 저장하거나 보여주기만 한다. 판정에 쓰는 곳부터 정리한다.

| 자리                                                                         | 쓰임                                                                                                                                                                      | 이 제안에서 할 일                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RolePerspective.confidence` (`src/core/types.ts:535-539`)                   | 합의 프롬프트에 `(confidence: 0.85)` 꼴로 들어간다(`src/agent/role-consensus-engine.ts:34`). 코드는 분기하지 않지만 합의를 맡은 LLM이 숫자 높은 관점에 끌릴 수 있다(추정) | 합의 프롬프트에서 숫자를 뺀다. 출력 예시에 박힌 `0.85`(`src/agent/role-prompt-generator.ts:29`)도 뺀다. 필드는 하위 호환을 위해 선택값으로 남긴다                                              |
| `gestaltAnalysis[].confidence` (`src/core/types.ts:31-35`)                   | 읽는 곳이 없다. 값이 없으면 파서가 0.5로 채운다(`src/spec/extractor.ts:106`). LLM이 쓴 숫자와 코드가 채운 숫자가 구분 없이 섞인다                                         | 기본값 0.5를 없애고 선택값으로 바꾼다                                                                                                                                                          |
| `RoleMatch.relevanceScore`                                                   | 점수로 자르지 않는다. 이름으로 레지스트리를 찾기만 한다                                                                                                                   | 그대로 둔다                                                                                                                                                                                    |
| Evaluate `overallScore`, `goalAlignment`                                     | LLM 점수로 성공 판정과 정체 판정을 한다(`src/mcp/tools/execute/evaluate.ts:67-71`, `src/execute/termination-detector.ts:41-69`)                                           | 판정은 [ac-test-first.md](./ac-test-first.md)와 [evaluate-evidence.md](./evaluate-evidence.md)가 다룬다. 여기서는 결과 표에 `first_score`, `final_score` 구간을 같은 방식으로 붙여 보기만 한다 |
| `Assumption.confidence` ([interview-grounding.md](./interview-grounding.md)) | 아직 제안 단계다                                                                                                                                                          | 그 문서에서 숫자 대신 근거 유무(`evidence`)와 사용자 확인(`confirmed`)으로 판단하게 하는지 확인한다. 아래 "문서끼리 겹치는 자리"에 적는다                                                      |

구현하면서 위 표에 없던 것을 아래처럼 정했다.

- 합의 프롬프트가 확신도를 더 안 받으니 호스트가 보내는 `ges_execute` 입력의 `perspectives[].confidence`와 `consensus.perspectives[].confidence`도 선택값으로 바꿨다. 필수로 두면 확신도 없이 돌아온 관점이 입력 검증에서 막힌다. 보내면 지금처럼 받는다.
- `buildSpecPrompt`의 출력 예시에 있는 `"confidence": 0.0-1.0`은 그대로 뒀다. 읽는 곳이 없고 선택값이라 LLM이 써도 판정에 안 쓰인다.

벤치마크 judge가 쓰는 `reworkProbability`도 LLM 숫자다. 로드맵은 사람 라벨 5개로 judge를 보정하겠다고 했다. 이 제안의 결과 표가 쌓이면 judge의 예측과 실제 rough 비율을 같은 표에 놓고 비교할 수 있다. 이 비교는 파트 4 스크립트에 선택 옵션(`--judge-csv`)으로만 둔다.

## 문서끼리 겹치는 자리

- **outcome-feedback.md.** `SpecHistoryEntry.resolutionScore`, CSV 내보내기, `rough` 정의를 그대로 쓴다. 그 문서의 PR 2(과정 스냅샷)와 PR 6(CSV)이 먼저 들어가야 한다. 열린 질문 8번에는 이 문서의 파트 5가 답한다. 두 문서가 같은 CSV에 열을 더하므로 열 순서는 outcome-feedback 열 뒤에 이 문서 열을 붙이는 것으로 고정한다.
- **interview-grounding.md.** `ResolutionDimensionName`을 함께 쓴다. `Assumption.confidence`가 LLM 숫자라는 점을 그 문서의 열린 질문에 더하자고 제안한다. 가정 수(`openAssumptions`)는 이 문서의 신호로 들어온다.
- **ac-verification.md.** `machineCheckableAcRatio` 신호를 그 문서의 AC 레코드로 계산한다.
- **evaluate-evidence.md.** 맥락 없는 서브에이전트 채점 방식을 다시 채점하기에 그대로 가져온다.

## 바꿀 파일

| 파일                                                                       | 변경                                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/types.ts`                                                        | `ResolutionSignals`, `RescoreResult` 추가. `ResolutionScore.signals`, `SpecHistoryEntry.resolutionSignals` 추가. `gestaltAnalysis[].confidence`를 선택값으로 |
| `src/core/config.ts`                                                       | `interview.rescore` 추가. 기존 `resolutionThreshold`와 Evaluate 기준값을 판정에 연결                                                                         |
| `src/gestalt/analyzer.ts`                                                  | `computeResolutionScore`에 `threshold` 인자                                                                                                                  |
| `src/gestalt/signals.ts` (새 파일)                                         | `computeSignals(session, score, prevScore)`, `DEFERRED_ANSWER_PATTERNS`, `formatSignalLine`                                                                  |
| `src/interview/passthrough-engine.ts`                                      | 라운드에 직전 응답이 고른 원칙 기록, 처음 기준값을 넘을 때 `rescorePrompt` 반환, `rescore: true` 처리                                                        |
| `src/interview/session.ts`                                                 | 채점마다 신호 계산, 이벤트 payload에 `signals`, `threshold`. 다시 채점하기 단계 판단과 결과 기록                                                             |
| `src/interview/rescore.ts` (새 파일)                                       | 다시 채점 요청 여부, 두 점수 비교, 모드별 판정, 판정을 미룬 뒤 다음 원칙                                                                                     |
| `src/interview/repository.ts`, `src/events/types.ts`                       | `interview.resolution.rescored` 이벤트와 그 fold                                                                                                             |
| `src/interview/resolution.ts`, `src/interview/engine.ts`                   | 비-passthrough 경로의 다시 채점하기. 같은 모델로 한 번 더 호출                                                                                               |
| `src/llm/prompts.ts`                                                       | `buildRescorePrompt` 추가 (대화 기록만 담는다)                                                                                                               |
| `src/mcp/schemas.ts`                                                       | `score` 입력에 `rescore`, `rescoreMode` 추가                                                                                                                 |
| `src/mcp/tools/interview-passthrough.ts`                                   | `nextAction: 'rescore'` 안내 문구                                                                                                                            |
| `src/mcp/tools/status.ts`, `src/mcp/server.ts`                             | 신호 한 줄 (API 키 경로와 passthrough 경로)                                                                                                                  |
| `src/mcp/tools/spec-passthrough.ts`                                        | `addSpec`에 `resolutionScore`, `resolutionSignals`                                                                                                           |
| `src/spec/generator.ts`, `src/spec/passthrough-generator.ts`               | 설정 기준값 사용, `specHistory`에 신호 기록                                                                                                                  |
| `src/agent/role-consensus-engine.ts`, `src/agent/role-prompt-generator.ts` | 합의 프롬프트와 출력 예시에서 confidence 숫자 제거                                                                                                           |
| `src/spec/extractor.ts`                                                    | confidence 기본값 0.5 제거                                                                                                                                   |
| `benchmarks/resolution-calibration.ts` (새 파일)                           | CSV로 구간별 표와 신호별 표 생성                                                                                                                             |
| `plugin/skills/interview/SKILL.md`                                         | `rescore` 다음 행동과 서브에이전트 위임 안내                                                                                                                 |

## 하위 호환

- 새 필드는 전부 선택값이다. 예전 이벤트와 `memory.json`은 그대로 읽힌다.
- `interview.rescore` 기본값이 `record`라 판정은 바뀌지 않는다. 호스트가 `rescore` 안내를 무시하고 바로 `complete`를 불러도 지금처럼 끝난다. 이때 `signals.rescore`가 비어 있고 결과 표에서는 "다시 채점 안 함" 칸으로 따로 센다.
- 파트 1에서 설정 기준값을 연결하면 `GESTALT_RESOLUTION_THRESHOLD`를 이미 걸어 둔 사용자의 판정이 바뀐다. 지금까지 조용히 무시되던 값이라 릴리스 노트에 적는다.
- `RolePerspective.confidence`를 합의 프롬프트에서 빼도 입력 스키마는 그대로 받는다.

## 테스트

- `computeSignals`: 빈 답, 위임 답(짧은 답과 긴 답 구분), 묻지 않은 차원, 첫 채점의 `overallJump`가 null인지.
- 기준값 연결: 설정 0.7에서 overall 0.75가 `isReady`인지. 스펙 생성 차단과 CLI 안내 문구가 같은 값을 쓰는지. 이벤트로 다시 만든 세션이 이벤트의 `isReady`를 그대로 쓰는지.
- 다시 채점하기: 처음 기준값을 넘을 때만 `rescorePrompt`가 나오는지. 두 번째로 넘을 때는 안 나오는지. `rescorePrompt`에 이전 점수와 `reasoning`이 없는지. `gate` 모드에서 낮은 쪽으로 판정하는지와 흔들림 0.2 초과에서 `isReady`가 false인지. `record` 모드에서 판정이 안 바뀌는지.
- 결과 표 스크립트: 고정 CSV를 넣어 칸별 숫자와 "표본 부족" 표시가 나오는지.
- 합의 프롬프트에 `confidence:` 문자열이 없는지.
- 테스트 DB는 `.gestalt-test/xxx-${randomUUID()}.db` 경로를 쓴다.

## PR 나누기

1. **`fix(config): 해상도와 평가 기준값 설정의 판정 연결`**
   파트 1. 혼자 들어가도 되고 다른 PR과 무관하다. [README.md](./README.md)의 "기존 버그"에 같은 종류로 묶어도 된다.
2. **`feat(interview): 서버가 세는 해상도 신호 기록`**
   파트 2. 이벤트와 status까지. `specHistory` 기록은 outcome-feedback PR 2 뒤에 이 PR이나 다음 PR에서 붙인다.
3. **`feat(interview): 기준값을 처음 넘은 채점의 다시 채점하기`**
   파트 3, `record` 모드까지. 스킬 문서 갱신 포함.
4. **`refactor(agent): 합의 프롬프트와 스펙 분석의 LLM 확신도 숫자 정리`**
   파트 6. 다른 PR과 무관하다.
5. **`feat(benchmark): 해상도 결과 표 스크립트`**
   파트 4. outcome-feedback PR 6 뒤에 들어간다.
6. 파트 5의 단계 2 이후는 결과 문서가 나온 뒤 따로 낸다.

## 열린 질문

1. **결과가 쌓이는 속도.** 칸마다 20개를 채우려면 스펙이 적어도 수십 개 있어야 한다. 이 레포처럼 `.gestalt/`를 gitignore한 레포는 팀 공유가 안 되므로 개인 데이터만 쌓인다(outcome-feedback 열린 질문 7번). 몇 달 안에 표본이 안 차면 기록 단계에 계속 머무르게 된다.
2. **위임 답변 패턴의 정확도.** 정규식이 놓치거나 잘못 세는 비율을 모른다. 첫 결과 문서를 낼 때 걸린 답 50개를 사람이 확인해 함께 적을지 정해야 한다.
3. **다시 채점하기 비용.** 인터뷰마다 채점 한 번이 늘어난다. 서브에이전트 채점에 frugal 모델을 쓰면 첫 채점과 모델이 달라져 흔들림이 모델 차이까지 섞인다. 같은 모델을 쓸지, 모델 차이를 받아들이고 `mode`에 모델 이름을 남길지 정해야 한다.
4. **점수 기준표를 넣을까.** `buildResolutionPrompt`에 차원별로 0.2, 0.5, 0.8이 어떤 상태인지 예시를 넣으면 흔들림은 줄 수 있다. 다만 결과와 맞는지와는 별개이고 기록 단계 도중에 프롬프트를 바꾸면 앞뒤 데이터가 섞인다. 넣는다면 첫 결과 문서 전에 넣거나 `readinessRuleVersion`을 올려서 나눠야 한다.
5. **Evaluate 점수도 같은 절차를 밟을까.** Evaluate의 성공 판정도 LLM이 쓴 `overallScore`에 걸려 있다. ac-test-first와 evaluate-evidence가 기계 판정으로 상한을 걸지만 0.85 기준값 자체를 결과와 맞춰보는 절차는 없다. 이 문서의 결과 표에 `final_score` 구간을 붙인 뒤 따로 제안할지 정해야 한다.
