---
name: master
version: "1.0.0"
description: "마스터 세션 하나가 말로 받은 요청과 지라 티켓, 외부 큐의 주문을 여러 레포에 걸쳐 받아 워커에 배정하고 머지(또는 주문 범위가 정한 끝 자리)까지 끌고 간다. 상태는 대화 밖 저장소에 두고 감시 주기마다 주문 접수, 워커 결과 반영, 끊긴 워커 재개, 머지 뒤 지라와 배포 처리를 돈다. 사람에게는 머지 승인, 슬랙 게시, 인터뷰 답처럼 정해진 자리만 묻는다."
triggers:
  - "마스터 세션"
  - "마스터 오케스트레이터"
  - "주문 큐 처리해줘"
  - "티켓들 머지까지 끌고 가"
  - "여러 레포 주문 처리"
  - "워커들 감시해줘"
inputs:
  scope:
    type: string
    required: false
    description: "주문 범위. merge-through, approval, interview-first 중 하나. 비우면 설정의 defaultScope"
outputs:
  - tick_report
  - gate_decisions
routing:
  note: "주문 넣기 → tick → hostActions 실행 → 사람 확인 자리는 사람에게 → 다음 tick. 태스크 하나 맡기기는 `handoff`, 같은 실행 세션 병렬은 `dispatch`"
---

# Master Skill

> **호스트별 도구와 모델 호출** → [`../_shared/host-runtime.md`](../_shared/host-runtime.md). 실행 전에 읽고 현재 호스트에 맞게 적용한다.
>
> **CLI 실행** → 본문의 `gestalt master ...` 예시는 [`../_shared/cli-launcher.md`](../_shared/cli-launcher.md)의 런처로 실행한다.

이 세션이 마스터다. 주문을 받아 워커에 나눠 주고 워커가 혼자 못 넘는 자리에만 들어간다. 티켓 하나를 끝까지 끌고 가는 일은 워커가 기존 스킬 체인(solve, ship, review-loop, review-reply, local-pr)으로 한다. 마스터는 코드를 직접 고치지 않는다.

상세 동작과 상태 저장소 구조는 게슈탈트 레포의 `docs/master-orchestrator.md`에 있다.

## 지켜야 할 것

- **워커 결과는 요약과 참조로만 받는다.** 워커 대화를 열어 로그나 diff를 읽지 않는다. 원문이 필요하면 보고의 `refs`에 적힌 파일 경로만 읽는다.
- **상태는 저장소에 있다.** 세션이 압축되거나 다시 떠도 `gestalt master status`로 이어 간다. 대화 기억으로 진행 상황을 복원하지 않는다.
- **워커 생성은 마스터만 한다.** 워커가 하위 워커를 원하면 보고의 `spawnRequest`로 올라오고 다음 tick이 새 주문으로 받는다.
- **이 스킬 자신은 워커 안에서 돌지 않는다.** 오르카가 디스패치한 세션이면 `tick`이 거절한다.

## 1. 주문 넣기

말로 받은 요청은 바로 넣는다.

```bash
gestalt master order add --repo acme/app --title "배너 문구 고치기" --scope merge-through --json
```

지라 티켓은 호스트가 Atlassian MCP로 읽어 같은 명령에 `--source jira --source-ref jira:<KEY> --issue-key <KEY> --issue-type <type>`을 붙여 넣는다. `--source-ref`가 같으면 두 번 받지 않는다. 사용자가 지라 상태를 정해 줬으면 `--jira-status`로 넘긴다. 기본 규칙보다 먼저다.

외부 큐는 `ExternalQueue` 어댑터를 붙인 호스트에서만 tick이 직접 읽는다.

범위를 사용자가 말하지 않았으면 설정의 `defaultScope`를 쓴다. 주문마다 다를 수 있으니 묻지 않고 넣은 값을 보고에 적는다.

## 2. tick

```bash
gestalt master tick --json
```

한 번에 접수, 워커 보고 반영, 끊긴 워커 재개, 빈 슬롯만큼 띄우기, 머지 뒤 지라와 배포 처리, 정리를 돈다. `pollIntervalSec` 안에 다시 부르면 `skipped: true`로 바로 끝난다. 사람이 방금 확인 자리를 닫았거나 주문을 넣은 직후면 `--force`를 붙인다.

응답은 짧은 숫자와 할 일만 담는다. 그대로 대화에 붙이지 말고 아래 `hostActions`만 처리한다.

## 3. hostActions 실행

tick 프로세스는 외부에 쓰지 못한다. 할 일을 `hostActions`로 돌려주면 이 세션이 실행한다.

| type | 할 일 |
|---|---|
| `spawn-subagent` | `promptFile`을 읽어 Agent 도구로 서브에이전트를 띄운다. 프롬프트 원문을 대화에 다시 적지 않는다 |
| `open-session` | `cwd`에서 새 에이전트 세션을 열고 `promptFile`을 첫 지시로 넘긴다. 오르카가 없을 때만 나온다 |
| `send` | 그 워커 세션에 `message`를 보낸다 |
| `jira-transition` | Atlassian MCP로 `issueKey`를 `to` 상태로 옮긴다. 전환 이름이 다르면 가장 가까운 전환을 고르고 보고에 적는다 |
| `slack-post` | 이미 사람이 승인한 초안이다. 슬랙 MCP로 `channel`에 게시한다 |

실행하다 실패하면 그 주문만 사람에게 올리고 나머지는 계속한다.

## 4. 사람 확인 자리

```bash
gestalt master gate list --json
```

사람이 답할 자리는 넷이다. `merge`(merge-through가 아닌 주문의 머지 승인), `slack-post`(초안 게시), `interview`(interview-first 주문의 인터뷰 답), `review-manual-switch`(리뷰 스킬 지침이 사람에게 올리라고 한 자리). `no-procedure`는 마스터가 처리 절차를 못 세운 경우다.

사람에게 물을 때는 그 자리의 `reason`과 `refs`만 보여준다. 답을 받으면 닫는다.

```bash
gestalt master gate resolve <gateId> --approve --json
gestalt master gate resolve <gateId> --approve --answer "보존 기간은 30일" --json
gestalt master gate resolve <gateId> --reject --json
```

닫으면 결정이 그 워커에 바로 전달된다. 응답에 `hostActions`가 있으면 3번처럼 실행한다.

그 밖의 요청(단순 승인, 수동 검증, 정리, 인증, 계정 전환)은 tick이 bypass로 넘기고 기록만 남긴다. 사람에게 묻지 않는다.

## 5. 슬랙 초안

초안을 맡으면 `slack-messenger`로 쓰고 파일에 둔 뒤 사람 승인 단계로 올린다.

```bash
gestalt master slack draft --channel "#release" --text-file "$tmp/draft.txt" --json
```

승인되면 다음 tick의 `hostActions`에 `slack-post`가 나온다.

## 6. 배포 결과

bug, task, sub-bug 주문은 머지 뒤 배포 파이프라인이 성공해야 In-QA로 옮긴다. 이 세션이 배포 결과를 확인해 남긴다.

```bash
gestalt master deploy report --order <orderId> --status success --ref <pipeline-url>
```

`failed`면 그 주문을 사람에게 올린다.

## 7. 루프

사람이 멈추라고 할 때까지 tick → hostActions → 사람 확인 자리 점검을 반복한다. 반복 간격은 `pollIntervalSec`를 따른다. 기다리는 동안 상태를 다시 묻지 않는다.

진행을 보고할 때는 `gestalt master status`의 숫자와 바뀐 주문만 짧게 말한다. bypass로 넘긴 일은 모아서 사후 보고한다.

## 8. 효과 재기

```bash
gestalt master metrics --since 2026-11-11 --json
```

직전 45일 사람 세션 평균과 마스터 세션의 끼어든 발화 수, 토큰을 같은 셈법으로 비교한다. 끼어든 발화 40% 감소가 먼저이고 토큰 +10%는 목표치라 넘으면 초과분을 보고한다.
