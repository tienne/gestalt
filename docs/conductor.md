# 컨덕터

컨덕터 세션 하나가 여러 레포의 주문을 받아 워커에 나눠 주고 주문 범위가 정한 끝 자리(기본은 머지)까지 끌고 간다. 처음 쓴다면 [시작하기](#시작하기)부터 본다. 그 뒤 절은 밑에서 도는 동작을 적는다. 컨덕터 세션이 따르는 절차는 `plugin/skills/conductor/SKILL.md`에 있다.

```
주문 (말, 지라, 외부 큐, PR 감시)
   │
   ▼
gestalt conductor tick ──► 저장소 (~/.gestalt/conductor)
   │                       events.jsonl, inbox/, prompts/, deploy/, slack/
   ▼
hostActions ──► 컨덕터 호스트 세션이 실행 (서브에이전트, 세션 열기, 메시지, 지라, 슬랙)
   │
   ▼
워커 (subagent, orca-worktree, git-worktree)
   └─ solve → ship 같은 기존 스킬 체인
   └─ gestalt conductor checkpoint save / worker report
```

구조는 컨덕터와 워커 2계층이다. 워커는 다른 워커를 띄우지 못하고 다음 주문을 스스로 집지 않는다. 워커가 하위 워커를 원하면 보고에 `spawnRequest`를 싣고 컨덕터가 새 주문으로 받는다. 주문 하나에서 생기는 하위 주문은 세 개까지고 한 단계뿐이다. 하위 주문의 워커가 다시 요청하거나 세 개를 넘기면 만들지 않고 그 워커에 이유를 보낸다.

## 시작하기

### 첫 사용 흐름

1. 평소 쓰는 에이전트 세션을 연다. 오르카 안에서 열면 워커 진행을 오르카 화면에서 본다.
2. `/gestalt:conductor`를 치거나 "컨덕터 세션 시작하자"라고 말한다. 이 세션이 컨덕터가 된다.
3. 할 일을 말한다. 예를 들어 "acme/app 배너 문구 고치는 거 머지까지 끌고 가 줘. 지라 APP-101, APP-102도 넣어 줘"라고 하면 세션이 주문 세 개를 넣는다.
4. `/loop /gestalt:conductor tick 돌리고 hostActions 처리`로 반복을 건다.
5. 세션이 머지 승인처럼 사람이 답할 자리를 물으면 답한다. 나머지는 세션과 워커가 이어 간다.

아래는 단계마다 알아 둘 것이다.

### 세션 열기

컨덕터를 띄우는 명령은 따로 없다. 평소 쓰는 에이전트 세션에서 `/gestalt:conductor`를 치거나 그렇게 해 달라고 말하면 그 세션이 컨덕터가 된다. 스킬은 "컨덕터 세션", "컨덕터", "주문 큐 처리해줘", "티켓들 머지까지 끌고 가", "여러 레포 주문 처리", "워커들 감시해줘" 같은 말에 불린다.

### 미리 할 설정

설정은 두 파일에 나눠 적는다.

| 파일 | 적는 칸 |
|---|---|
| `~/.gestalt/conductor.json` (사용자 전역) | `defaultScope`, `accounts`, `repoPaths`. 상태 저장소를 옮기려면 `stateDir`도 |
| 레포의 `gestalt.json` | `maxConcurrentWorkers`, `pollIntervalSec` 같은 조율 값만 |

칸별 뜻과 예시는 [설정 레퍼런스의 컨덕터 절](./configuration.md#컨덕터-conductor)에 있다.

### 어디서 열지

오르카 안에서 열면 코드를 고치는 주문이 `orca-worktree` 워커로 뜬다. 진행은 오르카 화면에서 본다. 오르카 밖에서 열면 같은 주문이 `git-worktree` 워커로 뜬다. 이때는 `repoPaths`에 그 레포의 로컬 경로가 있어야 한다. 경로가 없는 레포의 주문은 띄우지 못하고 `repoPaths`에 적어 달라고 알린다. 읽기만 하는 주문은 어느 쪽이든 서브에이전트로 돈다([워커 종류 고르기](#워커-종류-고르기)).

상태 저장소는 레포 안이 아니라 `~/.gestalt/conductor`(`stateDir`로 바꿀 수 있다)에 있다. 그래서 어느 디렉토리에서 세션을 열어도 같은 상태를 본다. 다만 살아 있는 워커의 워크트리 안이거나 `GESTALT_CONDUCTOR_WORKER_ID`가 잡힌 세션에서는 `tick`, `order add`, `queue add`, `gate resolve`, `deploy report`가 거절된다. 컨덕터 세션은 워커 밖에서 연다.

### 주문 넣기

| 출처 | 넣는 법 |
|---|---|
| 말 | 할 일을 말하면 세션이 `gestalt conductor order add`를 대신 부른다. 출처는 `spoken`으로 남는다 |
| 지라 | "이 티켓들 넣어줘"라고 하면 세션이 Atlassian MCP로 티켓을 읽고 `--source jira --source-ref jira:<KEY> --issue-key <KEY>`를 붙여 넣는다 |
| PR 감시 | `repoPaths`에 적은 레포는 tick마다 열린 PR을 보고 주문을 만든다. 내 PR에 새 코멘트가 달리면 `review-reply`, 내가 리뷰한 PR의 head가 바뀌면 `review-loop` 주문이다. 자세한 조건은 [PR 감시](#pr-감시)에 있다 |
| 외부 큐 | 다른 시스템이 상태 저장소의 `queue/`에 JSON 파일을 두거나 `gestalt conductor queue add`로 넣으면 다음 tick이 주문으로 받는다. 파일 꼴은 [외부 큐](#외부-큐)에 있다 |

범위를 말로 정해 주면 그 값으로 넣고 말하지 않으면 `defaultScope`를 쓴다. 범위마다 사람에게 묻는 자리는 [주문 범위와 사람 확인](#주문-범위와-사람-확인)의 표에 있다.

### 반복 돌리기

스킬은 사람이 멈추라고 할 때까지 tick → hostActions → 확인 자리 점검을 반복한다. Claude Code에서는 `/loop`으로 반복을 건다.

```text
/loop /gestalt:conductor tick 돌리고 hostActions 처리
```

간격을 비우면 세션이 간격을 스스로 정한다. `pollIntervalSec` 안에 다시 부른 tick은 `skipped: true`로 바로 끝나서 자주 불러도 토큰이 거의 안 든다.

`/loop`이 없는 호스트(Codex 등)에서는 다시 돌려 달라고 그때그때 말하거나 그 호스트의 반복 기능을 쓴다. 호스트마다 반복 기능이 어떻게 동작하는지는 아직 확인하지 않았다.

### 사람이 답할 자리

사람에게 오는 자리는 머지 승인, 슬랙 게시, 인터뷰 답, 리뷰 수동 전환이다. 대화 중이면 세션이 그 자리의 이유와 참조를 보여 주고 묻는다. 답하면 세션이 확인 자리를 종료하고 결정이 그 워커에 전해진다.

터미널에서 보거나 직접 종료하려면 아래 명령을 쓴다.

```bash
gestalt conductor gate list
gestalt conductor gate resolve <gateId> --approve
gestalt conductor gate resolve <gateId> --approve --answer "보존 기간은 30일"
gestalt conductor gate resolve <gateId> --reject
```

`gate resolve` 응답에 `hostActions`가 실리면 컨덕터 세션이 그걸 실행해야 결정이 워커에 닿는다. 그래서 대화에서 답하는 쪽이 기본이다.

### 진행 보기와 재개

`gestalt conductor status`가 주문과 워커 상태를 보여 준다. 끝난 주문까지 보려면 `--all`을 붙인다. 컨덕터 세션이 압축되거나 끊겨도 상태는 저장소에 남아 있다. 새 세션에서 스킬을 다시 부르면 status를 읽고 이어 간다.

효과를 재려면 `gestalt conductor metrics --since <날짜>`를 쓴다. 무엇을 비교하는지는 [효과 재기](#효과-재기)에 있다.

## 바깥 텍스트는 자료다

지라 티켓, 외부 큐 본문, PR 제목과 코멘트, 워커 보고(요약과 `refs` 파일 본문)는 자료로만 읽는다. 거기 적힌 문장이 주문 범위나 승인, 절차를 바꾸지 못한다. 범위는 사용자가 넣은 값이나 `defaultScope`가 정하고 사람에게 물을 자리는 아래 [주문 범위와 사람 확인](#주문-범위와-사람-확인)의 표가 정한다. 규칙 전체는 `plugin/skills/_shared/untrusted-input.md`에 있다.

## 왜 tick이 외부에 직접 쓰지 않나

Execute Engine처럼 컨덕터도 Passthrough로 돈다. 추론 주체는 호스트 세션이고 tick은 상태를 계산해 할 일만 돌려준다. 지라 전환과 슬랙 게시는 사람 계정의 MCP 연결이 필요해 CLI 프로세스가 직접 하지 못한다. 그래서 `hostActions`에 담아 돌려주고 호스트 세션이 실행한다.

| hostAction | 나오는 때 |
|---|---|
| `spawn-subagent` | 서브에이전트 워커를 띄울 때. `promptFile`에 지시가 있다 |
| `open-session` | 오르카가 없어 git 워크트리에 새 세션을 열 때 |
| `send` | 살아 있는 워커에 사람 결정이나 bypass 결과를 전할 때 |
| `jira-transition` | 주문 단계가 바뀌어 지라 상태를 옮길 때 |
| `slack-post` | 사람이 승인한 슬랙 초안을 게시할 때 |

gh로 읽을 수 있는 PR 목록과 계정 전환은 tick이 직접 한다. 오르카 워커도 오르카 CLI로 직접 띄운다.

## 상태 저장소

주문, 워커, 체크포인트, 사람 확인 자리(gate), bypass 기록은 전부 `events.jsonl`에 이벤트로 한 줄씩 덧붙는다. 상태는 이 로그를 처음부터 다시 재생해서 만든다. 컨덕터 세션이 압축되거나 새로 떠도 같은 저장소를 열면 같은 상태에서 이어 간다.

| 경로 | 쓰는 쪽 | 내용 |
|---|---|---|
| `events.jsonl` | tick, CLI 명령 | 상태 이벤트 로그 |
| `inbox/` | 워커 | `worker report`가 남긴 결과 파일. 다음 tick이 읽고 지운다 |
| `prompts/` | tick | 워커 첫 지시 파일 |
| `worktrees/` | tick | 오르카가 없을 때 만든 git 워크트리 |
| `deploy/` | 호스트 | `deploy report`가 남긴 배포 결과 |
| `queue/` | 외부 시스템 | 외부 큐 메시지. 다음 tick이 읽고 지운다. 못 읽은 파일은 `queue/failed/`로 옮긴다 |
| `slack/` | 호스트 | 슬랙 초안 본문 |
| `tick.lock` | tick | 겹쳐 도는 tick을 막는 잠금. 낡은 잠금을 걷을 때와 풀 때는 `tick.lock.steal`을 잡아 한 프로세스씩 지운다 |

위치는 `--state-dir`, `GESTALT_CONDUCTOR_STATE_DIR`, `~/.gestalt/conductor.json`의 `stateDir`, 기본값 `~/.gestalt/conductor` 순서로 정한다. 워커는 다른 레포에서 돌아 그쪽 `gestalt.json`을 읽기 때문에 워커 지시에는 저장소 절대 경로를 `--state-dir`로 박아 둔다.

## tick 한 번

1. **결과 반영**: `inbox/`의 워커 보고를 읽어 상태를 옮긴다. 요약이 `resultMaxChars`를 넘거나 diff, 스택 트레이스가 섞이면 받지 않고 요약을 다시 달라고 돌려보낸다. 적용한 보고 파일은 이름을 기록해 두므로 지우기에 실패해 다음 tick에 다시 보여도 두 번 적용하지 않는다.
2. **접수**: 지라 소스와 외부 큐, PR 감시에서 새 주문을 받는다. 출처 키(`sourceRef`)가 같으면 한 번만 받는다. 결과 반영보다 뒤에 도는 건 PR 감시가 워커가 방금 보고한 PR 주소를 알아야 같은 PR에 주문을 또 만들지 않기 때문이다.
3. **재개**: `staleAfterSec`(기본 1800초) 동안 보고도 체크포인트도 없는 워커와 `stopped`로 보고한 워커를 마지막 체크포인트부터 다시 띄운다. 사람 결정을 기다리는 `waiting-gate` 주문의 워커는 오래 조용해도 끊긴 것으로 보지 않는다.
4. **띄우기**: 빈 슬롯만큼 큐의 주문을 띄운다. 띄우기 전에 그 레포의 계정을 맞춘다.
5. **머지 뒤 처리**: 지라 상태를 옮기고 배포 결과를 확인한다.
6. **슬랙**: 승인된 초안을 `slack-post`로 넘긴다.
7. **정리**: 끝난 워커의 워크트리와 세션을 거둔다.

`pollIntervalSec` 안에 다시 부르면 `skipped: true`로 바로 끝나서 상태를 자주 물어도 토큰이 늘지 않는다. 응답에는 숫자와 할 일만 담는다.

## 워커 종류 고르기

| 주문 | 오르카 있음 | 오르카 없음 |
|---|---|---|
| 체인이 전부 읽기만 하는 스킬(review, blast-radius, diff-radius, explain) | `subagent` | `subagent` |
| 그 밖의 체인(solve, ship, review-loop, review-reply, local-pr 등) | `orca-worktree` | `git-worktree` |
| `--worker-kind`로 고정 | 그 값. `orca-worktree`인데 오르카가 없으면 `git-worktree` | |

기준은 `handoff` 스킬의 "맡길 곳 고르기" 표를 따른다.

### 부모 워크트리와 기준 브랜치

기존 워크트리 아래 하위로 워커를 띄우려면 주문에 `--parent-worktree`를 준다. 어느 ref에서 갈라질지는 `--base-branch`로 정한다.

```bash
gestalt conductor order add --repo acme/app --title "쿠폰 목록 하위 작업" \
  --parent-worktree ~/orca/workspaces/app/feat-coupon --base-branch feat-coupon
```

`--parent-worktree`는 경로나 오르카 선택자(`branch:feat-coupon`, `id:...` 같은 것)를 받는다. 선택자면 `orca worktree show`로 경로를 받아 온다. `path:`로 시작하면 접두어를 떼고 로컬 경로로 본다. 접수할 때 워크트리 루트의 절대 경로로 풀고 주문 레포의 워크트리인지 확인한다. `repoPaths`에 그 레포가 있으면 git 공용 디렉토리가 같은지 보고 없으면 `origin` 주소가 `owner/name`과 맞는지 본다. 경로가 없거나 git 워크트리가 아니거나 레포가 다르면 주문을 받지 않는다. `origin`으로 맞출 때는 호스트를 안 본다. SSH 별칭(`git@github-work:acme/app.git`)도 받으려는 것이고 호스트가 다른 동명 레포를 가려야 하면 `repoPaths`에 그 레포 경로를 적는다.

`--base-branch`는 브랜치 이름이나 `origin/main` 같은 ref를 받는다. `-`로 시작하거나 `..`, `@{`, 공백이 있거나 `/`로 나눈 조각이 비었거나 `.`으로 시작하거나 `.lock`으로 끝나면 거절한다. 부모 없이 단독으로 줘도 된다.

외부 큐는 `baseBranch`만 받고 `parentWorktree`는 확인 자리로 올린다. 부모 경로는 이 머신에서 확인한 값이어야 해서 `order add`로 넣은 주문만 받는다. 말로 받은 주문이 아닌데 기준 브랜치가 있으면 새 워크트리의 셋업을 건너뛴다(`--setup skip`). 바깥에서 고른 브랜치의 셋업 스크립트를 이 호스트에서 돌리지 않으려는 것이다.

| 워커 | `--parent-worktree` | `--base-branch` |
|---|---|---|
| `orca-worktree` | `orca worktree create --parent-worktree`로 그 아래 하위 워크트리를 먼저 만들고 `worker-start --worktree`로 그 워크트리에 띄운다 | 하위 워크트리나 `new-top-level` 워크트리를 그 ref에서 갈라낸다 |
| `git-worktree` | 무시하고 tick 보고의 `warnings`에 남긴다 | 워커 브랜치를 새로 만들 때 그 ref에서 갈라낸다. 재개 때 남은 브랜치를 다시 붙이면 쓰지 않는다 |
| `subagent` | 무시하고 `warnings`에 남긴다 | 무시하고 `warnings`에 남긴다 |

`worker-start --worktree new-child`는 호출한 쪽(컨덕터) 워크스페이스 아래에 붙어서 임의 부모를 고를 수 없다. 그래서 워크트리를 먼저 만드는 두 단계로 띄운다. 워크트리를 만든 뒤 워커가 못 뜨면 오르카가 `failed`로 답하고 남은 자원이 없을 때만 만든 워크트리를 지운다. 시간 초과나 `outcome_unknown`처럼 워커가 떴는지 모르면 지우지 않는다. 그때나 지우기가 실패했을 때는 남은 워크트리와 `orca worktree rm` 명령을 실패 사유에 붙여 확인 자리로 올린다. 실패한 띄우기는 회차를 안 올리므로 남은 워크트리를 지우기 전에는 같은 이름으로 다시 만들다 실패한다. 부모만 주고 기준 브랜치를 비우면 어디서 갈라질지는 오르카 기본값을 따른다. 부모 브랜치에서 이어 가려면 `--base-branch`에 그 브랜치를 같이 준다.

재개와 정리는 부모가 없는 오르카 워커와 같다. 재개하면 같은 부모 아래 `<주문 id>-<회차>` 이름으로 하위 워크트리를 새로 만든다. 정리는 `worker-release`로 워커 터미널만 거두고 워크트리는 남긴다.

## 동시 상한과 큐

`maxConcurrentWorkers`(기본 10)를 넘는 주문은 `queued`로 남았다가 슬롯이 나면 뜬다. 슬롯은 `starting`과 `running` 워커만 차지한다. 상한은 tick마다 설정을 다시 읽어서 도는 중에 바꿔도 다음 tick부터 적용된다.

## 주문 범위와 사람 확인

| 범위 | 머지 승인 | 인터뷰 답 |
|---|---|---|
| `merge-through` | 컨덕터가 넘긴다 | 워커가 맥락에서 정한다 |
| `approval` (기본) | 사람에게 묻는다 | 워커가 맥락에서 정한다 |
| `interview-first` | 사람에게 묻는다 | 사람에게 묻는다 |

워커가 혼자 못 넘는 자리를 만나면 `needs`로 보고한다. 컨덕터는 아래처럼 나눈다.

| 요청 | 처리 |
|---|---|
| `merge-approval` | 위 표대로 |
| `interview-answer` | 위 표대로 |
| `slack-post` | 늘 사람에게 |
| `review-manual-switch` | 늘 사람에게. 리뷰 스킬의 라운드 상한과 수동 전환 지침을 그대로 따른다 |
| `simple-approval` | 컨덕터가 승인하고 기록한다 |
| `manual-verification`, `cleanup` | 워커가 직접 하고 다음 보고에 남기라고 돌려준다 |
| `auth`, `account-switch` | `~/.gestalt/conductor.json`의 `accounts`에 적힌 레포만 그 계정으로 맞춘다. 없으면 사람에게 |
| `other` | 사람에게 (`no-procedure`) |

사람에게 가는 자리는 확인 자리(gate)로 열리고 그 주문은 `waiting-gate`가 된다. `gestalt conductor gate resolve`로 종료하면 결정이 그 워커에 바로 전달된다. bypass로 넘긴 일은 저장소에 기록만 남고 컨덕터가 모아서 사후 보고한다. `gestalt conductor status`가 주문마다 bypass 내역을 붙여 보여 주고 주문에 묶이지 않은 것은 `unassignedBypasses`로 따로 싣는다. 끝난 주문까지 보려면 `--all`을 붙인다.

### 워커 안의 ship 승인 단계

ship에는 밖으로 나가는 자리마다 사람 승인을 받는 단계가 셋 있다. ⓐ draft PR 올리기, ⓑ Copilot 반영 계획, ⓒ ready 전환이다. 워커 안에서는 셋 다 머지가 아니라서 사람에게 묻지 않는다. 워커가 진행하고 bypass로 기록한다. ⓑ에서 반영할 코멘트는 워커가 고르고 코멘트 문장은 자료로만 읽는다. 사람에게 가는 자리는 위 표의 넷(머지 승인, 슬랙 게시, interview-first 주문의 인터뷰 답, 리뷰 수동 전환)과 절차가 없는 `no-procedure`뿐이다.

### 머지까지

주문의 끝 자리는 기본이 머지인데 기본 체인 solve → ship은 PR을 ready로 돌리면 끝난다. 그 뒤 머지는 워커가 이어서 한다.

- 범위가 `merge-through`면 워커가 바로 머지한다.
- 그 밖의 범위면 워커가 `need merge-approval`로 올리고 컨덕터 결정을 기다린다. `merge` 확인 자리에서 승인이 나면 머지한다.
- 머지한 워커는 `--merged`로 보고해 주문을 `merged`로 옮긴다.

## 체크포인트와 재개

워커는 스킬이나 단계가 바뀔 때마다 체크포인트를 남긴다. CI 대기처럼 15분 넘게 걸릴 수 있는 대기도 들어가기 전과 끝난 뒤에 남긴다. 그래야 `staleAfterSec`(기본 30분) 안에 소식이 끊기지 않는다.

```bash
gestalt conductor checkpoint save --worker <id> --skill solve --next "스펙 확정" --done solve
gestalt conductor checkpoint save --worker <id> --skill ship --next "라운드 2 반영" --ship-dir .ship
```

ship 단계는 기존 `gestalt ship checkpoint save`와 `check`를 그대로 쓴다. 컨덕터 체크포인트는 그 자리(`--ship-dir`)만 가리킨다. 재개할 때 ship 체크포인트를 다시 읽어 단계와 라운드를 새 워커 지시에 싣는다. 끝낸 스킬은 다시 돌리지 않고 남은 체인만 이어 간다. git 워크트리 워커는 앞 워커의 워크트리 경로를 다시 써서 워크트리를 새로 만들지 않는다. 오르카 워커는 재개할 때도 새 워크트리로 띄운다.

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

주문에 `jiraStatus`가 있으면 사용자가 정한 값이라 기본 규칙보다 먼저다. 배포는 머지 뒤 파이프라인 성공으로 판단한다. 호스트가 결과를 확인해 `gestalt conductor deploy report`로 남기고 tick이 읽는다. 배포가 실패하면 그 주문만 사람에게 올린다.

## PR 감시

`~/.gestalt/conductor.json`의 `repoPaths`에 적힌 레포의 열린 PR을 gh로 읽는다. 본문은 안 싣고 누가 언제 남겼는지만 본다.

- **내가 올린 PR**: 내가 마지막으로 답한 뒤에 다른 사람 코멘트가 있으면 `review-reply` 주문을 만든다.
- **내가 리뷰한 PR**: 내가 리뷰한 뒤 head가 바뀌었으면 `review-loop` 주문을 만든다. 코드는 그대로인데 답만 달렸으면 `review-manual-switch` 확인 자리로 사람에게 묻고 승인되면 재리뷰 주문을 만든다.

워커는 PR을 다루면 결과 보고에 `--pr owner/name#번호`를 싣는다. PR 감시는 끝나지 않은 주문에 붙은 이 값으로 이미 처리 중인 PR을 건너뛰므로 빠지면 같은 PR에 주문이 또 생긴다. ship이 draft PR을 만들면 Copilot 리뷰를 요청하기 전에 `--status progress --skill ship`으로 바로 보고한다. 끝 보고까지 미루면 그 사이 Copilot 코멘트가 달린 PR을 감시가 새 PR로 보고 `review-reply` 주문을 만든다.

## 외부 큐

다른 시스템이 주문을 넣는 자리는 상태 저장소의 `queue/` 디렉토리다. 파일 하나가 메시지 하나이고 tick이 한 번에 20개까지 이름 순으로 읽는다.

```json
{
  "repo": "acme/app",
  "title": "배너 문구 고치기",
  "description": "메인 배너 문구를 새 캠페인 문구로 바꾼다",
  "scope": "approval",
  "issueKey": "APP-123"
}
```

`repo`(`owner/name`)와 `title`은 꼭 있어야 한다. 나머지 칸은 `description`, `scope`, `issueKey`, `issueType`, `workerKind`, `jiraStatus`, `skillChain`, `baseBranch`이고 전부 빼도 된다.

`parentWorktree`는 큐로 받지 않는다. 이 머신의 경로라 바깥 시스템이 정하게 두면 워커가 엉뚱한 워크트리 아래에서 뜰 수 있다. 이 칸이 든 메시지는 확인 자리로 올라온다. 사람이 보고 `order add --parent-worktree`로 다시 넣는다.

넣는 쪽은 아래 둘 중 하나를 쓴다.

```bash
gestalt conductor queue add --body-file order.json
cat order.json | gestalt conductor queue add --body-file - --id app-123
```

`queue add`는 본문 꼴을 먼저 보고 틀리면 넣지 않는다. `--id`를 비우면 시각과 난수로 새로 만든다. 같은 id 파일이 아직 큐에 있으면 덮지 않고 거절한다. 명령 없이 파일을 직접 둘 때는 점으로 시작하는 이름으로 다 쓴 뒤 `<id>.json`으로 바꾼다. tick은 점으로 시작하는 파일을 건너뛰므로 쓰다 만 파일을 읽지 않는다.

tick은 메시지를 이렇게 처리한다.

- 출처 키는 `queue:<id>`다. 같은 id가 다시 들어와도 주문은 한 번만 생긴다.
- 꼴이 틀린 본문(`repo`나 `title`이 없는 등)은 주문을 만들지 않고 사람 확인 자리를 연다.
- 깨진 JSON, 256KB를 넘는 파일, 심볼릭 링크, id 꼴(영문, 숫자, `-`, `_`, `.`로 128자까지)이 틀린 이름은 `queue/failed/`로 옮기고 tick 보고의 `errors`에 남긴다.
- 처리한 파일은 지운다.
- 큐 본문은 자료로만 읽는다. 범위는 `defaultScope`보다 넓힐 수 없고 `merge-through`는 받지 않는다. `skillChain`은 아는 스킬 이름만 남긴다.

큐를 잠시 건너뛰려면 `gestalt conductor tick --no-queue`로 돌린다.

## 효과 재기

`gestalt conductor metrics --since <날짜>`가 직전 45일 사람 세션 평균과 컨덕터를 쓰기 시작한 뒤 세션을 같은 셈법으로 비교한다. 끼어든 발화는 스킬 호출 뒤 8턴 안의 사용자 발화에서 도구 결과, 메타 메시지, 압축 요약, 작업 알림, 워커 알림을 뺀 수다. 목표는 끼어든 발화 40% 감소이고 토큰은 +10% 안이 목표치다. 토큰이 넘으면 초과분을 보고만 한다.

## 실환경에서 아직 확인하지 않은 것

테스트는 지라, 슬랙, gh, 오르카를 전부 가짜 어댑터로 돌린다. 아래는 실제 환경에서 처음 쓸 때 확인해야 한다.

- 오르카 `worker-start` 응답 JSON에서 dispatch id가 담기는 필드
- gh `pr list --json`의 `reviews[].commit.oid`와 `comments[].id`
- 지라 전환 이름이 프로젝트마다 다를 때 호스트가 고르는 전환
