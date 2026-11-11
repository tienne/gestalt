# 마스터 오케스트레이터

마스터 세션 하나가 여러 레포의 주문을 받아 워커에 나눠 주고 주문 범위가 정한 끝 자리(기본은 머지)까지 끌고 간다. 사용법은 `plugin/skills/master/SKILL.md`에 있고 이 문서는 그 밑에서 도는 동작을 적는다.

```
주문 (말, 지라, 외부 큐, PR 감시)
   │
   ▼
gestalt master tick ──► 저장소 (~/.gestalt/master)
   │                       events.jsonl, inbox/, prompts/, deploy/, slack/
   ▼
hostActions ──► 마스터 호스트 세션이 실행 (서브에이전트, 세션 열기, 메시지, 지라, 슬랙)
   │
   ▼
워커 (subagent, orca-worktree, git-worktree)
   └─ solve → ship 같은 기존 스킬 체인
   └─ gestalt master checkpoint save / worker report
```

구조는 마스터와 워커 2계층이다. 워커는 다른 워커를 띄우지 못하고 다음 주문을 스스로 집지 않는다. 워커가 하위 워커를 원하면 보고에 `spawnRequest`를 싣고 마스터가 새 주문으로 받는다.

## 왜 tick이 외부에 직접 쓰지 않나

Execute Engine처럼 마스터도 Passthrough로 돈다. 추론 주체는 호스트 세션이고 tick은 상태를 계산해 할 일만 돌려준다. 지라 전환과 슬랙 게시는 사람 계정의 MCP 연결이 필요해 CLI 프로세스가 직접 하지 못한다. 그래서 `hostActions`에 담아 돌려주고 호스트 세션이 실행한다.

| hostAction | 나오는 때 |
|---|---|
| `spawn-subagent` | 서브에이전트 워커를 띄울 때. `promptFile`에 지시가 있다 |
| `open-session` | 오르카가 없어 git 워크트리에 새 세션을 열 때 |
| `send` | 살아 있는 워커에 사람 결정이나 bypass 결과를 전할 때 |
| `jira-transition` | 주문 단계가 바뀌어 지라 상태를 옮길 때 |
| `slack-post` | 사람이 승인한 슬랙 초안을 게시할 때 |

gh로 읽을 수 있는 PR 목록과 계정 전환은 tick이 직접 한다. 오르카 워커도 오르카 CLI로 직접 띄운다.

## 상태 저장소

주문, 워커, 체크포인트, 사람 확인 자리(gate), bypass 기록은 전부 `events.jsonl`에 이벤트로 한 줄씩 덧붙는다. 상태는 이 로그를 처음부터 다시 재생해서 만든다. 마스터 세션이 압축되거나 새로 떠도 같은 저장소를 열면 같은 상태에서 이어 간다.

| 경로 | 쓰는 쪽 | 내용 |
|---|---|---|
| `events.jsonl` | tick, CLI 명령 | 상태 이벤트 로그 |
| `inbox/` | 워커 | `worker report`가 남긴 결과 파일. 다음 tick이 읽고 지운다 |
| `prompts/` | tick | 워커 첫 지시 파일 |
| `worktrees/` | tick | 오르카가 없을 때 만든 git 워크트리 |
| `deploy/` | 호스트 | `deploy report`가 남긴 배포 결과 |
| `slack/` | 호스트 | 슬랙 초안 본문 |
| `tick.lock` | tick | 겹쳐 도는 tick을 막는 잠금 |

위치는 `--state-dir`, `GESTALT_MASTER_STATE_DIR`, `master.stateDir`, 기본값 `~/.gestalt/master` 순서로 정한다. 워커는 다른 레포에서 돌아 그쪽 `gestalt.json`을 읽기 때문에 워커 지시에는 저장소 절대 경로를 `--state-dir`로 박아 둔다.

## tick 한 번

1. **접수**: 지라 소스와 외부 큐, PR 감시에서 새 주문을 받는다. 출처 키(`sourceRef`)가 같으면 한 번만 받는다.
2. **결과 반영**: `inbox/`의 워커 보고를 읽어 상태를 옮긴다. 요약이 `resultMaxChars`를 넘거나 diff, 스택 트레이스가 섞이면 받지 않고 요약을 다시 달라고 돌려보낸다.
3. **재개**: `staleAfterSec` 동안 보고도 체크포인트도 없는 워커와 `stopped`로 보고한 워커를 마지막 체크포인트부터 다시 띄운다.
4. **띄우기**: 빈 슬롯만큼 큐의 주문을 띄운다. 띄우기 전에 그 레포의 계정을 맞춘다.
5. **머지 뒤 처리**: 지라 상태를 옮기고 배포 결과를 확인한다.
6. **정리**: 끝난 워커의 워크트리와 세션을 거둔다.
7. **슬랙**: 승인된 초안을 `slack-post`로 넘긴다.

`pollIntervalSec` 안에 다시 부르면 `skipped: true`로 바로 끝나서 상태를 자주 물어도 토큰이 늘지 않는다. 응답에는 숫자와 할 일만 담는다.

## 워커 종류 고르기

| 주문 | 오르카 있음 | 오르카 없음 |
|---|---|---|
| 체인이 전부 읽기만 하는 스킬(review, blast-radius, diff-radius, explain) | `subagent` | `subagent` |
| 그 밖의 체인(solve, ship, review-loop, review-reply, local-pr 등) | `orca-worktree` | `git-worktree` |
| `--worker-kind`로 고정 | 그 값. `orca-worktree`인데 오르카가 없으면 `git-worktree` | |

기준은 `handoff` 스킬의 "맡길 곳 고르기" 표를 따른다.

## 동시 상한과 큐

`maxConcurrentWorkers`(기본 10)를 넘는 주문은 `queued`로 남았다가 슬롯이 나면 뜬다. 슬롯은 `starting`과 `running` 워커만 차지한다. 상한은 tick마다 설정을 다시 읽어서 도는 중에 바꿔도 다음 tick부터 적용된다.

## 주문 범위와 사람 확인

| 범위 | 머지 승인 | 인터뷰 답 |
|---|---|---|
| `merge-through` | 마스터가 넘긴다 | 워커가 맥락에서 정한다 |
| `approval` (기본) | 사람에게 묻는다 | 워커가 맥락에서 정한다 |
| `interview-first` | 사람에게 묻는다 | 사람에게 묻는다 |

워커가 혼자 못 넘는 자리를 만나면 `needs`로 보고한다. 마스터는 아래처럼 나눈다.

| 요청 | 처리 |
|---|---|
| `merge-approval` | 위 표대로 |
| `interview-answer` | 위 표대로 |
| `slack-post` | 늘 사람에게 |
| `review-manual-switch` | 늘 사람에게. 리뷰 스킬의 라운드 상한과 수동 전환 지침을 그대로 따른다 |
| `simple-approval` | 마스터가 승인하고 기록한다 |
| `manual-verification`, `cleanup` | 워커가 직접 하고 다음 보고에 남기라고 돌려준다 |
| `auth`, `account-switch` | `master.accounts`에 적힌 레포만 그 계정으로 맞춘다. 없으면 사람에게 |
| `other` | 사람에게 (`no-procedure`) |

사람에게 가는 자리는 확인 자리(gate)로 열리고 그 주문은 `waiting-gate`가 된다. `gestalt master gate resolve`로 닫으면 결정이 그 워커에 바로 전달된다. bypass로 넘긴 일은 저장소에 기록만 남고 마스터가 모아서 사후 보고한다. `gestalt master status`가 주문마다 bypass 내역을 붙여 보여 주고 주문에 묶이지 않은 것은 `unassignedBypasses`로 따로 싣는다. 끝난 주문까지 보려면 `--all`을 붙인다.

## 체크포인트와 재개

워커는 스킬이나 단계가 바뀔 때마다 체크포인트를 남긴다.

```bash
gestalt master checkpoint save --worker <id> --skill solve --next "스펙 확정" --done solve
gestalt master checkpoint save --worker <id> --skill ship --next "라운드 2 반영" --ship-dir .ship
```

ship 단계는 기존 `gestalt ship checkpoint save`와 `check`를 그대로 쓴다. 마스터 체크포인트는 그 자리(`--ship-dir`)만 가리킨다. 재개할 때 ship 체크포인트를 다시 읽어 단계와 라운드를 새 워커 지시에 싣는다. 끝낸 스킬은 다시 돌리지 않고 남은 체인만 이어 간다. 오르카 워커는 같은 손잡이를 다시 써서 워크트리를 새로 만들지 않는다.

아래면 재개하지 않고 원인과 마지막 체크포인트를 붙여 사람에게 올린다.

- 같은 주문을 `maxResumeAttempts`번 재개했는데도 또 멈췄다
- 체크포인트상 체인을 다 끝냈는데 멈췄다
- ship 체크포인트를 읽지 못했다

## 지라 상태

| 주문 단계 | 지라 상태 |
|---|---|
| 접수 | TODO |
| 워커 시작 | In Progress |
| 리뷰 스킬(ship, local-pr, review-reply, review-loop) 시작 | PR |
| 머지 (sub-task) | Done |
| 배포 성공 (bug, task, sub-bug) | In-QA |

주문에 `jiraStatus`가 있으면 사용자가 정한 값이라 기본 규칙보다 먼저다. 배포는 머지 뒤 파이프라인 성공으로 판단한다. 호스트가 결과를 확인해 `gestalt master deploy report`로 남기고 tick이 읽는다. 배포가 실패하면 그 주문만 사람에게 올린다.

## PR 감시

`master.repoPaths`에 적힌 레포의 열린 PR을 gh로 읽는다. 본문은 안 싣고 누가 언제 남겼는지만 본다.

- **내가 올린 PR**: 내가 마지막으로 답한 뒤에 다른 사람 코멘트가 있으면 `review-reply` 주문을 만든다.
- **내가 리뷰한 PR**: 내가 리뷰한 뒤 head가 바뀌었으면 `review-loop` 주문을 만든다. 코드는 그대로인데 답만 달렸으면 `review-manual-switch` 확인 자리로 사람에게 묻고 승인되면 재리뷰 주문을 만든다.

## 효과 재기

`gestalt master metrics --since <날짜>`가 직전 45일 사람 세션 평균과 마스터를 쓰기 시작한 뒤 세션을 같은 셈법으로 비교한다. 끼어든 발화는 스킬 호출 뒤 8턴 안의 사용자 발화에서 도구 결과, 메타 메시지, 압축 요약, 작업 알림, 워커 알림을 뺀 수다. 목표는 끼어든 발화 40% 감소이고 토큰은 +10% 안이 목표치다. 토큰이 넘으면 초과분을 보고만 한다.

## 실환경에서 아직 확인하지 않은 것

테스트는 지라, 슬랙, gh, 오르카를 전부 가짜 어댑터로 돌린다. 아래는 실제 환경에서 처음 쓸 때 확인해야 한다.

- 오르카 `worker-start` 응답 JSON의 손잡이 필드
- gh `pr list --json`의 `reviews[].commit.oid`와 `comments[].id`
- 지라 전환 이름이 프로젝트마다 다를 때 호스트가 고르는 전환
