# 에이전트 tier로 모델 고르기 (공유 규칙)

`ges_agent { action: "get" }`은 `tier`와 함께 **해석된 `model`** 을 돌려준다. 에이전트 frontmatter의
tier가 "이 역할이 어느 정도 모델을 필요로 하나"를 선언하고 서버가 그걸 호스트 Agent 도구가 받는
별칭으로 옮겨준 값이다.

```
ges_agent { action: "get", name: "architect" }
  →  { tier: "frontier", model: "opus", systemPrompt: "...", ... }
```

기본 표는 이렇고 `gestalt.json`의 `tierModels`로 바꿀 수 있다.

| tier | model | 쓰는 에이전트 |
|---|---|---|
| `frugal` | `haiku` | proximity-worker |
| `standard` | `sonnet` | 대부분 |
| `frontier` | `opus` | architect, harness-architect, continuity-judge |

## 등록 에이전트가 없는 자리

리뷰 스레드 분류처럼 **역할 정의 없이 기계적으로 읽고 옮겨 적는 작업**을 서브에이전트에 맡길 때가 있다.
이런 자리엔 넘길 에이전트 이름이 없어서 `ges_agent { action: "get" }`을 쓸 수 없다. 대신 `ges_status`가
같은 표를 통째로 준다.

```
ges_status {}
  →  { tierModels: { frugal: "haiku", standard: "sonnet", frontier: "opus" }, ... }
```

여기서 `tierModels.frugal`을 뽑아 Agent 도구의 `model`로 넘긴다. 판단하는 자리가 아니라 모아서 분류하고
정리하는 자리, 그러니까 결과를 사람이 다시 확인하는 작업에만 쓴다 — 확정 판단, 문장 작성, 파일 수정은
이 경로로 내리지 않는다.

## 적용 규칙

**서브에이전트를 띄울 때는 `model`을 그대로 넘긴다.** Agent 도구의 `model` 파라미터에 응답의
`model` 값을 넣는다. 이게 tier가 실제로 효력을 갖는 유일한 지점이다.

**세션에서 직접 수행할 때는 tier가 참고값이다.** systemPrompt를 그대로 입고 이번 세션에서 처리하면
모델은 세션 모델이다. 이때 `tier`가 `frontier`인데 세션 모델이 그보다 낮으면, 그 관점만 서브에이전트로
떼어내 `model`과 함께 위임하는 게 낫다. 판단이 애매하면 사용자에게 한 번 묻는다.

**폴백은 스킬 런타임 책임이다.** Agent 도구가 그 별칭을 지원하지 않아 스폰이 거부되면 `sonnet`으로
1회 재시도한다. 서버는 표만 알려주고 모델 가용성을 감지하지 않는다 (`reasoningModel` 폴백과 같은 결).

## reasoningModel과 겹칠 때

`spec`과 `execute` Phase 1은 **단계 자체가 깊은 추론용**이라 `ges_status`의 `reasoningModel`이
우선한다. tier 모델로 내리지 않는다.

그 밖에 에이전트를 불러 쓰는 자리(리뷰 심급, 코멘트 작성, 문서 작성 등)는 이 문서의 tier 모델을
따른다. 두 값이 다른 질문에 답하기 때문이다 — `reasoningModel`은 "이 **단계**가 얼마나 깊은 추론을
요구하나", tier는 "이 **역할**이 어느 정도 모델을 필요로 하나"다.
