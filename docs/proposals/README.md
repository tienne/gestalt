# 인터뷰에서 검증까지 강화 제안

인터뷰, 스펙, 실행, 평가, 진화로 이어지는 흐름에서 검증이 구현 에이전트의 자기 보고에 기대는 자리를 줄이려는 설계 묶음이다. 문서 일곱 개는 각자 혼자 읽히게 썼고 이 파일은 문서끼리 겹치는 자리와 전체 순서만 다룬다.

## 문서

| 문서                                                   | 단계                    | 담는 것                                                                                              |
| ------------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| [ac-verification.md](./ac-verification.md)             | Spec                    | AC를 `{ id, criterion, verifyBy, check }` 레코드로 바꾸고 패치를 거쳐도 id를 유지한다                |
| [ac-test-first.md](./ac-test-first.md)                 | Execute, Evaluate       | `verifyBy: 'test'` AC를 실패하는 테스트로 먼저 쓰게 하고 평가 때 AC마다 연결된 테스트를 돌린다      |
| [evaluate-evidence.md](./evaluate-evidence.md)         | Evaluate                | 근거를 파일 위치로 받아 서버가 열어 보고 Contextual 채점을 구현 맥락이 없는 서브에이전트에게 맡긴다 |
| [execute-drift-breaker.md](./execute-drift-breaker.md) | Execute                 | 태스크별 작업 트리 기준점 위에서 diff로 드리프트를 재고 같은 태스크가 연속 실패하면 끊는다          |
| [interview-grounding.md](./interview-grounding.md)     | Interview, Spec, Evolve | 브라운필드 인터뷰에 관련 코드를 넣고 끝날 때 남은 가정을 목록으로 뽑아 Evolve까지 들고 간다         |
| [outcome-feedback.md](./outcome-feedback.md)           | 머지 뒤                 | 스펙과 커밋을 이어 리뷰 라운드와 재작업을 모으고 Memory와 벤치마크로 돌려보낸다                      |
| [verification-loop.md](./verification-loop.md)         | Spec, Execute, Evaluate, Evolve | 속성 테스트와 차분 테스트를 AC에 담고 변이(`mutation`)로 테스트 판별력을 본다. 검사를 fast와 gate로 나누고 실패 출력을 줄이며 흔들리는 검사와 E2E 기능 지도를 다룬다 |

공통 계약은 `ac-verification.md`의 `AcceptanceCriterion` 하나다. 나머지 문서는 이 타입이 들어온다고 보고 썼다.

## 문서끼리 겹치는 자리

일곱 문서를 따로 설계해서 같은 자리를 두 번 고치는 곳이 있다. 아래처럼 맞춘다.

### Evaluate Call 3의 점수 조정

`ac-test-first.md`는 테스트 검사가 통과하지 않은 AC를 내리고 가중치 없는 비율로 상한을 건다. `evaluate-evidence.md`는 근거를 확인하지 못한 AC를 내리고 priority 가중치로 점수를 깎는다. 두 규칙이 차례로 돌면 같은 AC를 두 번 깎거나 순서에 따라 결과가 달라진다.

`src/execute/score-adjustment.ts` 하나로 합친다. 내릴 AC 집합은 두 판정의 합집합으로 잡고 점수는 priority 가중치 방식 하나만 쓴다. `classifiedACs`에 priority가 이미 있으므로 가중치 없는 비율로 떨어질 이유가 없다. 응답의 `scoreAdjustment`에는 AC마다 어느 판정으로 내렸는지(`ac_check`, `evidence`)를 남긴다. 먼저 들어가는 PR이 이 모듈을 만들고 뒤에 오는 PR은 판정만 더한다.

### AC 검사 명령을 Structural 단계에 싣는 문제

`evaluate-evidence.md`가 열린 질문 1번으로 남긴 부분이다. `ac-test-first.md`가 AC 검사 명령을 Structural 단계(`structuralContext.acChecks`)에 싣기로 정했으므로 그쪽 결정을 따른다. 그러면 `command`와 `test` 근거가 `corroborated`로 올라갈 자리가 생긴다. 근거 확인기는 `session.structuralResult.commands`와 함께 `acChecks`도 대조 대상으로 본다.

### 기준점 이후 바뀐 파일 목록

`evaluate-evidence.md`의 `collectChangedSinceBaseline`과 `execute-drift-breaker.md`의 `listChangedSince`는 같은 함수다. `artifact-verifier.ts`에 `listChangedSince(baseline, limit)` 하나만 둔다. 평가는 세션 기준점(`cp-0`)을, 드리프트는 태스크 체크포인트를 넘긴다.

### 실행 설정 배선

`execute.driftThreshold`가 엔진까지 전달되지 않는 문제를 `ac-test-first.md`와 `execute-drift-breaker.md`가 둘 다 고치려 한다. 한 번만 고치고 두 문서가 더하는 설정 키(`testFirst`, `acCheckMode`, `codeDrift`, `taskBreakerThreshold` 등)는 그 위에 얹는다. 아래 "기존 버그"의 첫 항목으로 먼저 따로 낸다.

### Spec 스키마와 MCP 입력 스키마

`ac-verification.md`는 AC 타입을 바꾸고 `interview-grounding.md`는 `assumptions`와 `codeContext`를 더한다. 둘 다 `src/spec/schema.ts`와 `src/mcp/schemas.ts`의 같은 세 자리(spec 입력, execute `spec`, `specPatch`)를 고친다. `z.object`가 모르는 키를 조용히 버리므로 execute `spec` 쪽을 빠뜨리면 필드가 오류 없이 사라진다. 두 문서의 첫 PR에 있는 strip 회귀 테스트는 하나로 합친다.

### 재실행 대상 고르기

`src/execute/impact-identifier.ts`를 네 문서가 고친다.

| 문서                     | 바꾸는 것                                                                       |
| ------------------------ | ------------------------------------------------------------------------------- |
| ac-verification.md       | `acChanges`와 `sourceACIds`로 AC가 바뀐 태스크만 좁혀 고른다                    |
| ac-test-first.md         | 테스트 검사가 통과하지 않은 AC의 태스크를 더한다                                |
| execute-drift-breaker.md | 코드 내용은 그대로 두지만 blend 모드에서 드리프트 판정이 바뀌어 대상이 달라진다 |
| verification-loop.md     | `flaky`인 AC는 네 번째 기준에서 빼고 테스트 태스크만 고른다. `mutation_survived`인 AC는 테스트 태스크를 더한다 |

대부분 기준을 더하는 쪽이라 서로 부딪히지 않는다. `flaky`만 `ac-test-first.md`의 네 번째 기준을 좁히므로 그 문서의 PR 2 뒤에 들어간다. 기준마다 어느 이유로 골랐는지를 결과에 남겨야 재실행이 왜 일어났는지 추적된다. 첫 번째로 이 파일을 고치는 PR에서 `ImpactedTask.reasons`를 넣는다.

### Evolve 프롬프트

`buildContextualEvolvePrompt` 하나에 세 문서가 절을 더한다. 넣는 순서는 "Assumptions to check first", "AC Check Results", "Unsatisfied Criteria"로 고정한다. 확인 안 된 전제부터 보고 기계 판정을 본 다음, LLM 판정을 보는 순서다.

### 사람 판단 게이트

`execute-drift-breaker.md`가 `HumanGate.kind`를 들여온다. `interview-grounding.md`가 열린 질문으로 남긴 "깨진 미확인 가정에서 게이트를 세울지"를 나중에 정하게 되면 같은 구조에 `kind: 'assumption_broken'`을 더하면 된다.

### AC 계약에 더하는 `testDesign`

`verification-loop.md`는 `AcceptanceCriterion`에 선택 필드 `testDesign` 하나를 더한다. `verifyBy`의 세 값은 그대로 두고 `test` 안에서 `example`, `property`, `differential`, `e2e`를 나눈다. 검증 규칙은 `ac-verification.md`의 `superRefine` 표에 줄을 더하는 방식이라 ac-verification PR 2 뒤에 얹는다. 위 "Spec 스키마와 MCP 입력 스키마"의 strip 회귀 테스트에 `testDesign`도 넣어야 `specPatch`에서 조용히 사라지지 않는다.

### AC 검사의 판정 값과 Call 2 대조

`ac-test-first.md`의 `AcCheckStatus`에 `verification-loop.md`가 `flaky`와 `skipped`를 더한다. 둘 다 `passed`가 아니므로 위 "Evaluate Call 3의 점수 조정"의 합집합에 그대로 들어간다. AC마다 남기는 사유 값은 `ac_check` 하나로 묶고 따로 늘리지 않는다. 다만 gate 검사를 건너뛴 평가는 AC 단위가 아니라 점수 전체에 상한을 건다. `appliedScore`를 성공 기준 바로 아래로 묶고 사유 `gate_skipped`를 남긴다. `acCheckMode: 'report'`에도 건다. fast가 실패해 gate를 건너뛴 평가도 같다. 변이 검사는 점수를 바꾸지 않으므로 이 모듈에 들어오지 않는다.

Call 2에서 `acChecks`를 대조하는 자리도 함께 쓴다. `ac-test-first.md`가 `acId`로 짝을 짓는 대조를 만들고 `verification-loop.md`는 그 위에 `retry`와 `skipped`, 변이 결과의 원복 확인을 얹는다. `hashFiles` export는 두 문서가 같은 변경을 적었으니 먼저 들어가는 PR이 한 번만 한다.

### Evolve가 고르는 재실행 사유

`verification-loop.md`는 위 "재실행 대상 고르기" 표에 사유 `flaky`와 `mutation_survived`를 더한다. `flaky`인 AC는 `ac-test-first.md`의 네 번째 기준에서 빼고 그 AC의 `ac_test` 태스크만 고른다. `mutation_survived`인 AC는 검사가 통과한 AC라 네 번째 기준에 걸리지 않는다. 그래서 기준을 하나 더하는 셈이고 이때도 `ac_test` 태스크만 고른다. `testFirst`가 꺼져 있어 `ac_test` 태스크가 없으면 그 AC를 맡은 구현 태스크를 고르되 테스트만 고치라는 지시를 붙인다. `ImpactedTask.reasons`에 그대로 남긴다. 변이 검사는 `listChangedSince`로 바뀐 파일을 고르므로 위 "기준점 이후 바뀐 파일 목록"의 함수를 세 번째로 쓰는 곳이 된다.

Evolve 프롬프트의 절 순서는 바꾸지 않는다. 흔들린 검사와 테스트가 못 잡은 변이는 "AC Check Results" 절 안에 넣는다.

### 실패 출력 자르기

`verification-loop.md`의 `condenseFailureOutput`이 `tailOutput`과 이벤트 자르기를 함께 바꾼다. `ac-test-first.md`는 `acChecks.output`을 `commands`와 같은 방식으로 가리고 자른다고 했다. 이 함수가 먼저 들어가면 그 자리도 같은 함수를 쓴다.

## 설계 중에 나온 기존 버그

설계와 상관없이 지금 고쳐야 하는 것들이다. 작고 독립적이라 제안 PR보다 먼저 낸다.

| 버그                                                                                                                                | 근거 문서                                            | 영향                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `execute.driftThreshold`와 `GESTALT_DRIFT_THRESHOLD`가 엔진에 전달되지 않아 늘 상수 0.6으로 돈다. 문서는 기본값을 0.3으로 적고 있다 | execute-drift-breaker.md 파트 0                      | 설정이 먹지 않는다. 고치면 0.3으로 설정해 둔 사용자는 retrospective가 훨씬 자주 뜬다      |
| 스펙 생성기가 Zod 검증 결과(`validation.data`)가 아니라 검증 전 객체를 돌려준다                                                     | ac-verification.md 배경                              | 스키마의 transform이 결과에 안 실린다. `resolutionScore` 하위 호환 변환이 지금도 무시된다 |
| evolve로 AC를 추가하면 평가 프롬프트에는 새 AC가 안 보이는데 서버는 그 인덱스까지 검증하라고 요구한다                               | ac-verification.md 배경                              | AC를 추가한 패치 뒤 평가가 막힌다                                                         |
| `addExecution`이 같은 세션을 건너뛰어 evolve 뒤 재평가 점수가 Memory에 반영되지 않는다                                              | outcome-feedback.md 배경                             | `executionHistory`가 첫 평가 점수에 고정된다                                              |
| `evolve_re_execute`에서 `failed`를 계속 내면 같은 태스크가 끝없이 돌아온다                                                          | execute-drift-breaker.md 배경                        | 서버 쪽 무한 루프가 가능하다                                                              |
| `getCurrentTask`는 실패한 의존을 해소로 보고 `computeReadyTaskIds`는 안 본다                                                        | ac-test-first.md, execute-drift-breaker.md 열린 질문 | 순차 경로와 병렬 경로가 다음 태스크를 다르게 고른다                                       |

## 전체 순서

```
[0] 기존 버그 (설정 배선, validation.data, AC 추가 뒤 평가)
    verification-loop PR 1, 2 (실패 출력 줄이기, 재실행 판정)  ← 계약과 무관해 언제든
      │
[1] ac-verification PR 1 ──┬── interview-grounding PR 1   (스키마만, 동작 변화 없음)
      │                    │
[2] ac-verification PR 2   ├── interview-grounding PR 2, 3 (남은 가정 → Evolve)
      │                    └── interview-grounding PR 4, 5 (관련 코드)
    verification-loop PR 3 (testDesign 필드)
      │
[3] ac-test-first PR 1, 2  (AC별 테스트 검사, score-adjustment 모듈 생성)
    verification-loop PR 4, 5 (fast와 gate 단계, 기능 지도)  ← ac_test 쪽 지시는 ac-test-first PR 3 뒤에 켠다
      │
[4] evaluate-evidence PR 1 (공용 excerpt 대조, 이슈 #57)
    evaluate-evidence PR 2, 3 (근거 확인, 맥락 없는 채점자)
      │
[5] execute-drift-breaker PR 1 (서킷브레이커)  ← [0] 다음이면 언제든
    execute-drift-breaker PR 2 (태스크별 기준점, listChangedSince)
    ac-test-first PR 3, 4 (테스트 먼저 쓰기, red 확인)
    verification-loop PR 6 (변이 검사 report 모드, listChangedSince 뒤)
      │
[6] outcome-feedback PR 1 ~ 6
      │
[7] 데이터가 쌓인 뒤: 드리프트 blend, acCheckMode enforce 기본값, selfGraded 임계값, 변이 검사를 점수에 넣을지
```

몇 가지 기준으로 이 순서를 잡았다.

- **AC 구조가 먼저다.** 테스트 검사, 근거 확인, 테스트 먼저 쓰기가 모두 `verifyBy`와 `check`에 기댄다.
- **기계 판정을 LLM 판정보다 먼저 넣는다.** AC별 테스트 검사([3])는 서버가 종료 코드만 보면 되고 근거 확인([4])은 그 결과를 `corroborated`의 재료로 쓴다.
- **evaluate-evidence PR 1은 이슈 #57을 닫으므로 앞당겨도 된다.** 평가와 독립이라 [1]과 나란히 가도 된다.
- **서킷브레이커는 독립이다.** [0]의 설정 배선만 있으면 언제 넣어도 되고 재실행 무한 루프를 막으므로 일찍 넣는 편이 낫다.
- **실패 출력 줄이기와 재실행 판정은 [0] 옆에 둔다.** 둘 다 지금 Structural 경로에 바로 효과가 있고 AC 계약을 기다릴 이유가 없다.
- **변이 검사는 AC 검사 뒤에 온다.** 판별력을 보려면 AC마다 연결된 테스트 명령이 먼저 있어야 하고 바뀐 파일을 고르는 `listChangedSince`도 필요하다.
- **outcome-feedback은 맨 뒤에 둔다.** 앞 단계가 남기는 점수와 판정을 모으는 쪽이라, 앞이 바뀌는 동안 넣으면 스냅샷 모양을 계속 고쳐야 한다. 다만 PR 1(머지 규칙과 모르는 키 통과)은 옛 merge driver가 필드를 지우는 문제를 막으므로 [1] 무렵에 먼저 넣어도 된다.
- **기본값을 바꾸는 일은 데이터를 본 뒤에 한다.** blend, enforce, selfGraded 임계값은 모두 shadow나 report로 먼저 돌려 분포를 본다. 로드맵 1절의 벤치마크와 outcome-feedback의 CSV가 그 근거가 된다.

## 함께 정할 열린 질문

문서마다 열린 질문이 있지만 아래는 여러 문서에 걸려 있어서 한 번에 정해야 한다.

1. **`command` AC의 신뢰 경계.** `ac-verification.md` 2번과 `ac-test-first.md` 5번이 같은 문제다. 스펙의 `check` 문자열을 호스트 셸이 그대로 돌린다. 스펙이 Jira나 GitHub 이슈 텍스트에서 오거나 evolve 패치로 바뀌었을 때 사람 확인을 끼울지 정해야 한다. `verification-loop.md`에서는 차분 테스트의 `oracle`이 같은 경계에 걸리는데 ref 꼴을 검증 규칙으로 좁혀 두었다. 같은 문서의 기능 지도에도 같은 문제가 있다. `launch.command`는 호스트 셸로 가고 `launch.url`과 지도 본문은 사용자 세션을 쓰는 브라우저 조작으로 이어진다(그 문서 6번). `launch.command`는 package.json scripts 이름이나 `launch.skill`만 받고 `launch.url`은 localhost로 묶거나 첫 실행 전에 사람 확인을 받는 안을 함께 정한다. 그 문서는 브라우저 조작을 `launch.url`과 같은 출처로 묶어 두었지만 이 결정이 나기 전에는 `launch.url` 자체를 파일을 고친 쪽이 정하므로 그 제한이 막는 게 없다.
2. **Node 밖 생태계.** `ac-test-first.md`의 red 명령과 테스트 검사 명령, 그리고 지금 Structural 명령이 모두 package.json만 안다. `verification-loop.md`의 변이 연산자도 JS와 TS 문법만 안다. 서버가 명령을 만드는 범위를 넓힐지, 다른 생태계에서는 호스트가 명령을 정하고 서버는 기록만 할지 함께 정한다.
3. **서버가 점수를 얼마나 고칠지.** AC 검사 상한, 근거 내림, `contextClarity` 상한(`interview-grounding.md`), `selfGraded` 임계값이 모두 "호스트가 매긴 점수를 서버가 고치는가"의 문제다. 지금 원칙은 "Passthrough 점수는 호스트 몫"이다. 이번 묶음은 기계로 확인되는 사실(종료 코드, 파일 위치)로만 고치고 그 밖은 경고로 남기는 선을 제안한다. 변이 검사에서 테스트가 못 잡은 변이도 종료 코드로 나오지만 등가 변이를 가려낼 수 없어서 경고 쪽에 둔다. gate를 건너뛴 평가의 점수 상한(`gate_skipped`)은 "무거운 검사를 안 돌렸다"는 사실로만 고치므로 이 선 안에 든다.
4. **흔들리는 검사를 누가 격리하나.** `verification-loop.md`는 격리를 fix 태스크의 산출물로 두고 사람이 로컬 PR 리뷰에서 보게 했다. `execute-drift-breaker.md`의 `HumanGate`로 멈출지와 outcome-feedback이 레포별로 흔들린 명령을 모아 Memory에 남길지를 함께 정한다.
