---
name: handoff
version: "1.0.0"
description: "일을 받으면 어디에 맡길지(메인 직접, 서브에이전트, 같은 워크트리 터미널 워커, 하위 워크트리, 독립 워크트리)를 기준으로 고르고, 고른 경로로 model과 effort를 쌍으로 실어 실제로 넘긴다. 오르카가 있으면 워크트리 위임은 오르카를 먼저 쓴다. 같은 브랜치 안의 병렬 쪼개기는 dispatch, 티켓과 브랜치와 PR 단위로 끝나는 위임은 handoff가 맡는다."
triggers:
  - "handoff"
  - "핸드오프"
  - "핸드오버"
  - "어디에 맡길지"
  - "서브에이전트로 맡겨"
  - "워크트리로 넘겨"
  - "하위 워크트리로"
  - "독립 워크트리로"
inputs:
  task:
    type: string
    required: true
    description: "맡길 일. 목표와 끝나는 모양(브랜치, PR, 결과 텍스트)이 드러나야 한다"
  target:
    type: string
    required: false
    description: "맡길 곳을 사용자가 지정한 경우. subagent, child-worktree, independent-worktree 중 하나. 비우면 이 스킬의 기준으로 고른다"
  mode:
    type: string
    required: false
    description: "supervised(기본, 결과를 이어받아 검증) 또는 full(소유권을 넘기고 원래 에이전트는 멈춤). 사용자가 넘기고 끝이라고 할 때만 full"
outputs:
  - route
  - model
  - effort
  - briefPath
  - launchReceipt
routing:
  note: "맡길 곳 고르기(메인, 서브에이전트, 하위 워크트리, 독립 워크트리) → model과 effort 쌍 → 지시서 → 오르카 또는 Agent 도구로 위임. 같은 브랜치 병렬 쪼개기는 `dispatch`"
---

# Handoff Skill

일을 어디에 맡길지 고르고 고른 경로로 실제로 넘기는 앞단의 판단 스킬이다. 명령 문법은 여기에 복사하지 않는다. 오르카 명령의 기준은 `orca skills get orca-cli`와 `orca skills get orchestration`이고 버전이 오르면 복사본은 낡는다. 이 스킬에는 gestalt만의 것을 담는다. 맡길 곳 고르는 표, model과 effort 쌍 고르기, 지시서 쓰기, 충돌과 정리 규칙, 보고다.

> **도구가 없을 때** → [`../_shared/tool-availability.md`](../_shared/tool-availability.md)
> **model과 effort 고르기** → [`../_shared/agent-model.md`](../_shared/agent-model.md)
> **서브에이전트 위임 절차** → [`../_shared/agent-delegation.md`](../_shared/agent-delegation.md)

## 언제 이 스킬인가

한 줄로 줄이면 이렇다. **결과를 읽고 내가 이어서 쓸 거면 서브에이전트, 일이 하나의 브랜치나 PR로 끝나면 워크트리.**

- 같은 브랜치 안에서 실행 세션의 태스크를 터미널로 쪼개 뿌리는 일은 [`dispatch`](../dispatch/SKILL.md)가 맡는다.
- 사용자와 주고받아야 하는 일(승인 단계, 인터뷰)은 넘기지 않고 메인에서 직접 한다.

## 1단계: 맡길 곳 고르기

| 맡길 곳 | 이럴 때 |
|---|---|
| 메인에서 직접 | 사용자와 주고받아야 하는 일. 승인 단계, 인터뷰 |
| 서브에이전트 | 읽기 전용(리뷰, 조사, 분류, 윤문 초안)이고 15분 안쪽에 끝나며 메인은 결과 텍스트만 필요할 때. 같은 모양의 일을 여럿 병렬로 뿌리는 리뷰어 fan-out도 여기다 |
| 같은 워크트리 터미널 워커 | 같은 브랜치 안에서 쪼갠 병렬이고 파일군이 안 겹칠 때. `dispatch`로 보낸다 |
| 하위 워크트리 | 파일을 쓰고 끝이 브랜치나 PR로 남는 일(티켓 단위 구현). 15분을 넘기거나 사람이 중간에 들여다보고 끼어들어야 하는 일. `ship`이나 `review-loop` 같은 스킬 체인을 처음부터 끝까지 돌리는 일. 다른 레포 작업. 메인과 파일이 안 겹치는 독립 작업 |
| 독립 워크트리 | 현재 브랜치와 무관한 독립 작업. 현재 브랜치 맥락은 프롬프트에 적는다 |

하위 워크트리는 오르카의 `new-child`(`worktree create`로는 `--parent-worktree`), 독립 워크트리는 `new-top-level`(`worktree create`로는 `--no-parent`)에 해당한다.

충돌과 파일 규칙은 어느 경로에서나 같다.

- 같은 파일군을 건드리는 병렬은 어디서든 띄우지 않고 직렬로 돌린다. 병렬로 낸 작업이 같은 파일을 고치면 나중에 합칠 때 충돌한다.
- 서브에이전트에 파일 수정을 맡기는 건 메인이 그 파일을 안 만지는 동안만이다.

이 기준이 필요한 이유는 아래와 같다.

- 15분 넘게 도는 일은 서브에이전트에 맞지 않는다. 메인이 그동안 묶이고 중간 상태도 보기 어렵다.
- 워크트리는 만들기는 쉽고 정리는 잊기 쉽다. 끝난 워크트리는 확인한 뒤 `worktree rm`으로 지운다.
- 지시문을 길게 말로 넘기면 흔들린다. 길면 파일로 쓰고 경로만 넘긴다.

## 2단계: model과 effort는 쌍으로 정한다

서브에이전트든 워크트리든 둘을 함께 정해서 넘긴다. 한쪽만 정하면 상속값이나 기본값이 조용히 들어간다.

**서브에이전트.** [`agent-model.md`](../_shared/agent-model.md#작업별-model과-effort-세트)의 "작업별 model과 effort 세트" 표에서 일의 성격에 맞는 쌍을 고른다. Agent 호출에는 `model`을 반드시 넣는다. 한 줄 꼴 예는 이렇다.

```
Agent { subagent_type: "Explore", model: "<표에서 고른 tier의 모델>", effort: "medium", prompt: "<지시서 경로를 읽고 시작>" }
```

`model` 값은 `ges_agent list`나 `ges_status`의 `tierModels`에서 읽고 스킬 본문에 별칭을 박지 않는다. 위임 절차는 [`agent-delegation.md`](../_shared/agent-delegation.md)를 따른다.

**워크트리(오르카).** `worker-start`의 `--model`과 `--effort`로 싣는다. 직접 돌려서 확인한 것은 아래와 같다.

- `--model`은 별칭(`sonnet`, `opus`)과 전체 ID(`claude-sonnet-5-5`)를 둘 다 받는다.
- effort는 `low`, `medium`, `high`, `xhigh`가 통했다. opus와 xhigh, sonnet과 low, sonnet과 medium을 돌려봤다.
- `--effort`는 `--model`과 같이 줘야 하고 `--terminal`과는 섞지 못한다.
- 지원하지 않는 조합(예: sonnet과 effort ultra)은 `invalid_argument`로 거절되고 워크트리도 만들어지지 않는다. 에러 문구가 같은 명령을 그대로 다시 하지 말라고 알려준다. 쌍을 고쳐서 다시 한다.

haiku에는 effort를 줄 수 없다. `Agent claude model haiku does not support effort low`라는 `invalid_argument`로 거절되고 워크트리도 만들어지지 않는다. haiku는 `--model haiku`만 주고 `--effort`는 뺀다.

## 3단계: 지시서(brief)를 쓴다

긴 지시는 파일로 쓰고 프롬프트에는 경로만 넘긴다. 파일명은 `<티켓>-brief.md` 꼴이 좋다. 지시서에 들어갈 것은 다섯 가지다.

1. 목표
2. 완료 조건
3. 건드릴 파일과 건드리면 안 되는 범위
4. 검증 명령
5. 보고 형식

워크트리에서 도는 워커는 `bypass permissions on`으로 뜬다. 권한 확인 없이 돈다는 뜻이다. 그래서 3번의 범위를 반드시 적는다. 읽기 전용으로 끝나는 일은 서브에이전트로 먼저 보내는 쪽이 안전하다.

## 4단계: 오르카가 있을 때

감지는 [dispatch의 0단계](../dispatch/SKILL.md)를 따른다. 리눅스에서는 `orca`가 GNOME 스크린리더 이름과 겹쳐서 존재 여부만으로 판단하면 안 된다. 절차를 여기에 복사하지 않는다.

기본은 **감독형**이다. 결과를 이어받아 검증하는 경로이고 `orchestration`의 `worker-start`를 쓴다. 사용자가 넘기고 끝이라고 할 때만 full handoff로 간다.

### 감독형

1. 묶인 Run이 있는지 `orca orchestration run-current`로 먼저 본다. 있으면 재사용하고 없을 때만 `orca orchestration run-create --objective <text>`로 만든다.
2. `worker-start`로 워커를 띄운다. 하위 워크트리는 `--worktree new-child`, 독립 워크트리는 `--worktree new-top-level`을 쓴다. `new-top-level`은 부모 없는 독립 워크트리를 만든다. 직접 돌려 확인했다. 지시는 `--spec`에 지시서 경로를 읽고 시작하라는 문장을 넣는다. 형태는 아래와 같고 나머지 플래그는 `orca skills get orchestration`을 본다.

```bash
orca orchestration worker-start --spec "<지시서 경로를 읽고 시작>" --worktree new-child --agent claude --model <별칭|전체ID> --effort <low|medium|high|xhigh> --json
```

3. 접수증의 `result.launch.requested`와 `result.launch.effective`를 비교한다. 같으면 model과 effort가 먹힌 것이다. 다르면 완료 보고에 그대로 적는다.
4. 워커가 끝나면 `worker_done` 메시지가 Run 메일함에 온다. `orca orchestration check --run <id>`로 읽는다.

dispatch는 `worker-start` 대신 `terminal create`와 `orchestration task-create`와 `dispatch --inject`를 쓴다. 두 스킬의 명령이 다른 이유는 용도가 달라서다. dispatch는 `ges_execute` 세션의 태스크를 터미널로 뿌리고 handoff는 하나의 일을 워크트리 워커에 통째로 맡긴다.

### full handoff

소유권을 넘기고 원래 에이전트는 멈춘다. 새 워크트리 id와 에이전트 핸들을 보고하고 전송 영수증이 `accepted: true`면 끝이다. 받는 쪽이 끝나기를 기다리지 않는다.

`worktree create --agent`는 오르카가 설정한 런처를 쓰고 model과 effort 플래그가 없다. 쌍을 실으려면 우회한다.

1. `worktree create --name <이름> --parent-worktree active --json`으로 워크트리를 만든다. 독립 작업이면 `--no-parent`를 쓰고 `--base-branch`는 생략한다.
2. `terminal create --worktree id:<repoId>::<경로> --command 'claude --model <별칭> --effort <low|medium|high|xhigh>' --json`으로 터미널을 띄운다.
3. `terminal wait --terminal <핸들> --for tui-idle --timeout-ms 60000`으로 TUI가 뜨기를 기다린다. 결과의 `wait.satisfied`가 `true`일 때만 다음으로 간다.
4. `terminal send --terminal <핸들> --text "<지시서 경로를 읽고 시작>" --enter --wait-submit 10`으로 지시를 보낸다.

이 4단계는 sonnet과 low로 끝까지 돌려 확인했다. 2단계 직후 터미널 머리글에 `Sonnet 5.5 with low effort`가 떴고 4단계 접수증에는 `turn_started`까지 찍혔다. 값이 먹혔는지는 모델의 답이 아니라 이 머리글로 본다. 모델은 자기 effort를 모른다고 답한다. 이 경로의 워커는 `worker-start`와 달리 `auto mode on`으로 뜬다. 오르카 문서가 경고하는 빈 셸 탭은 이번에는 생기지 않았다.

### 재전송하지 않는다

`terminal send`의 `accepted: true`는 입력이 받아졌다는 뜻이지 시작했다는 증명이 아니다. 조용하다고 다시 보내면 지시가 중복된다. `--wait-submit`으로 확인하고 다시 보내지 않는다.

## 5단계: 오르카가 없을 때

오르카가 붙지 않으면 Agent 도구의 `isolation: "worktree"`로 내려간다. 이때도 model과 effort는 쌍으로 넣는다. 한 줄 꼴 예는 이렇다.

```
Agent { subagent_type: "general-purpose", model: "<표에서 고른 tier의 모델>", effort: "high", isolation: "worktree", prompt: "<지시서 경로를 읽고 시작>" }
```

**오르카로 넘기지 못했으면 오르카로 넘겼다고 보고하지 않는다.** 감지에 실패했다는 사실과 어느 경로로 돌았는지를 완료 보고에 적는다.

## 6단계: 도는 동안과 끝난 뒤

- 워크트리 상태판은 `worktree set --worktree <선택자> --comment "<짧은 현황>"`으로 갱신한다. 짧고 최신으로 유지한다.
- 끝난 child는 결과를 확인한 뒤 `worktree rm --worktree id:<id> --force`로 정리한다. 안 지우면 쌓인다.
- 감독형을 돌렸다면 임시 Run이 오르카에 남는다. 지우지 않고 id를 보고에 적어 사용자가 판단하게 한다.

## 완료 보고

- 어느 경로로 돌았는지: 메인, 서브에이전트, 하위 워크트리, 독립 워크트리, 오르카 여부
- 쓴 model과 effort
- 오르카를 썼다면 접수증의 `launch.requested`와 `effective` 비교 결과
- 지시서 경로
- 정리한 워크트리와 남은 Run
- 값이 먹혔다는 근거: 감독형은 접수증, full handoff 우회는 터미널 머리글

## Do-NOT

- 오르카 플래그 전체 목록을 이 스킬이나 지시서에 베끼지 않는다. `orca skills get`을 가리킨다.
- 같은 파일군을 건드리는 일을 병렬로 띄우지 않는다.
- `terminal send`를 조용하다는 이유로 다시 보내지 않는다.
- 오르카로 안 넘겼는데 넘겼다고 보고하지 않는다.
- Agent 호출에서 `model`을 빼지 않는다.
- 범위를 안 적은 지시서로 워크트리 워커를 띄우지 않는다.
- 사용자와 주고받아야 하는 일을 넘기지 않는다.

## 에러 처리

| 상황 | 처리 |
|---|---|
| `invalid_argument`로 거절 | 워크트리는 안 만들어졌다. model과 effort 쌍을 고쳐서 다시 한다. 같은 명령을 그대로 반복하지 않는다 |
| `launch.requested`와 `effective`가 다름 | 값이 안 먹힌 것이다. 완료 보고에 적고 사용자에게 알린다 |
| `terminal wait`의 `wait.satisfied`가 `false` | 더 큰 `--timeout-ms`로 한 번 다시 기다린다. 그래도 아니면 시작 안 한 것으로 보고하고 보내지 않는다 |
| 오르카 감지 실패 | 사용자에게 알리고 Agent 도구의 `isolation: "worktree"`로 내려간다 |
| 빈 셸 탭이 먼저 생김 | 지시를 보내기 전에 올바른 터미널 핸들인지 확인한다 |
