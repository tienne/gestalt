# 에이전트 tier로 모델 고르기 (공유 규칙)

`ges_agent`의 `get`과 `list`는 둘 다 `tier`와 **해석된 `model`** 을 돌려준다. 에이전트 frontmatter의
tier가 "이 역할이 어느 정도 모델을 필요로 하나"를 선언하고 서버가 그걸 호스트 Agent 도구가 받는
별칭으로 옮겨준 값이다. 둘의 차이는 `systemPrompt`가 딸려오느냐뿐이다. `get`은 한 에이전트의
시스템 프롬프트까지 주며 `list`는 전체 에이전트의 `tier`와 `model`만 준다.

```
ges_agent { action: "get", name: "architect" }
  →  { tier: "frontier", model: "opus", systemPrompt: "...", ... }

ges_agent { action: "list" }
  →  { groups: {
         role:      [{ name: "architect", tier: "frontier", model: "opus", ... }, ...],
         review:    [{ name: "security-reviewer", tier: "standard", model: "sonnet", ... }, ...],
         persona:   [{ name: "trickster", tier: "standard", model: "sonnet", ... }, ...],
         principle: [{ name: "continuity-judge", tier: "frontier", model: "opus", ... },
                     { name: "proximity-worker", tier: "frugal", model: "haiku", ... }, ...]
       } }
```

`principle` 그룹은 `plugin/agents` 소속이다. `tier`가 없는 에이전트는 `standard`로 본다.

기본 표는 이렇고 `gestalt.json`의 `tierModels`로 바꿀 수 있다.

| tier | model | 쓰는 에이전트 |
|---|---|---|
| `frugal` | `haiku` | proximity-worker |
| `standard` | `sonnet` | 대부분 |
| `frontier` | `opus` | architect, harness-architect, continuity-judge, suggestion-verifier |

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

## 작업별 model과 effort 세트

서브에이전트를 띄울 때는 일의 성격을 보고 `model`(tier)과 `effort`를 **한 쌍**으로 고른다. 둘은 서로
독립된 손잡이라 tier에 effort를 묶어두지 않는다. 같은 `standard`여도 취약점 리뷰는 `high`가 맞고
파일 위치 찾기는 `low`가 맞다.

Agent 도구의 `effort`는 지침이 명시할 때만 설정하는 파라미터인데, 이 절이 그 명시 역할을 한다. 값은
`low`, `medium`, `high`, `xhigh` 네 가지만 쓴다. 표에는 tier 이름을 적고 모델 별칭은 괄호로 참고만
단다. `model` 값은 계속 `ges_agent list`나 `ges_status`의 `tierModels`에서 읽는다. 스킬 본문에 별칭을
하드코딩하지 않는 원칙도 그대로다. 표의 값은 시작값이며 측정으로 검증한 값이 아니다.

| 일의 성격 | 예 | tier | effort |
|---|---|---|---|
| 기계적 분류, 추출, 형식 변환 | 리뷰 스레드 분류, proximity-worker | `frugal` (haiku) | `low` |
| 범위가 정해진 조사 | 파일과 심볼 위치 찾기, 호출 경로 따라가기 | `standard` (sonnet) | `low` |
| 규칙 대조형 리뷰 | quality, comment, writing, performance, frontend 리뷰어 | `standard` (sonnet) | `medium` |
| 취약점 리뷰 | security-reviewer | `standard` (sonnet) | `high` |
| 문서, 윤문, PR 본문 작성 | change-context-writer, humanize-monolith, jira-writer, technical-writer | `standard` (sonnet) | `medium` |
| 범위가 명확한 구현 | gestalt-developer, frontend-developer, backend-developer | `standard` (sonnet) | `medium` |
| 해석이 갈리는 구현 | 요구사항이 열려 있거나 파일 여러 곳에 걸치는 변경 | `frontier` (opus) | `high` |
| 판정 (결과가 다음 단계를 막거나 뒤집는 일) | continuity-judge, suggestion-verifier | `frontier` (opus) | `high` |
| 열린 설계, 아키텍처 | architect, harness-architect | `frontier` (opus) | `high` (대형이면 `xhigh`) |

- 표에 맞는 행이 없으면 가장 가까운 행의 쌍을 쓴다. 정말 모르겠으면 `standard`와 `medium`으로 시작한다.
  `model`은 절대 비우지 않는다.
- 이전 시도가 실패했거나 결과가 얕아서 같은 일을 다시 시킬 때는 `model`과 `effort` 중 **하나만**
  올린다. 둘을 한꺼번에 올리면 어느 쪽이 먹혔는지 알 수 없다. 해석이 막혔으면 `model`을 올린다. 같은
  모델이 너무 빨리 끝냈으면 `effort`를 올린다.
- 에이전트 이름이 있으면 `model`은 `list`가 준 값을 우선한다. 표의 tier는 이름이 없는 자리에서 쓴다.
  `effort`는 어느 경우든 이 표에서 고른다.
- haiku에 effort를 줄 수 있는지는 호출 경로마다 다르다. Agent 도구는 에러 없이 받는다. 오르카
  `worker-start`는 `invalid_argument`로 거절하니 그쪽에서는 haiku일 때 effort를 뺀다.

호출은 이런 모양이다. `model`은 `list` 응답에서 가져온 값이고 `effort`는 표에서 고른 값이다.

```
ges_agent { action: "list" }
  →  { name: "security-reviewer", tier: "standard", model: "sonnet", ... }

Agent { subagent_type: "Explore", model: "sonnet", effort: "high", prompt: "...security-reviewer 관점..." }
```

## 적용 규칙

**서브에이전트를 띄울 때는 `model`을 그대로 넘긴다.** Agent 도구의 `model` 파라미터에 응답의
`model` 값을 넣는다. 이게 tier가 실제로 효력을 갖는 유일한 지점이다. 값은 이렇게 구한다.

1. 스폰 전에 `ges_agent { action: "list" }`를 한 번 부르고 에이전트별 `model`을 확보한다. `systemPrompt`가
   안 딸려오므로 메인이 `get`으로 프롬프트를 읽어버려 위임 효과가 깨지는 일이 없다.
2. 넘길 이름이 응답에 없거나 호출이 실패하면 `ges_status`의 `tierModels.standard`로 폴백한다.
3. `model`은 비우지 않는다. 비우면 Agent 도구가 세션 모델을 상속해서 `sonnet`이어야 할 자리가 `opus`로 돈다.

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
