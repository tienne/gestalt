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
4. 세션이 첫 tick을 돌린 뒤 반복을 직접 건다. Claude Code에서는 따로 `/loop`을 칠 필요가 없다. 한 번만 돌려 보려면 "한 번만"이나 `--once`를 붙인다.
5. 세션이 머지 승인처럼 사람이 답할 자리를 물으면 답한다. 나머지는 세션과 워커가 이어 간다.

아래는 단계마다 알아 둘 것이다.

### 세션 열기

컨덕터를 띄우는 명령은 따로 없다. 평소 쓰는 에이전트 세션에서 `/gestalt:conductor`를 치거나 그렇게 해 달라고 말하면 그 세션이 컨덕터가 된다. 스킬은 "컨덕터 세션", "컨덕터", "주문 큐 처리해줘", "티켓들 머지까지 끌고 가", "여러 레포 주문 처리", "워커들 감시해줘" 같은 말에 불린다.

### 미리 할 설정

설정은 두 파일에 나눠 적는다.

| 파일                                      | 적는 칸                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `~/.gestalt/conductor.json` (사용자 전역) | `defaultScope`, `defaultAgent`, `repoAgents`, `accounts`, `repoPaths`, `prWatchRepos`. 상태 저장소를 옮기려면 `stateDir`도 |
| 레포의 `gestalt.json`                     | `maxConcurrentWorkers`, `pollIntervalSec` 같은 조율 값만                                                                   |

칸별 뜻과 예시는 [설정 레퍼런스의 컨덕터 절](./configuration.md#컨덕터-conductor)에 있다.

### 어디서 열지

오르카 안에서 열면 코드를 고치는 주문이 `orca-worktree` 워커로 뜬다. 진행은 오르카 화면에서 본다. 오르카 밖에서 열면 같은 주문이 `git-worktree` 워커로 뜬다. 이때는 `repoPaths`에 그 레포의 로컬 경로가 있어야 한다. 경로가 없는 레포의 주문은 띄우지 못하고 `repoPaths`에 적어 달라고 알린다. 읽기만 하는 주문은 어느 쪽이든 서브에이전트로 돈다([워커 종류 고르기](#워커-종류-고르기)).

상태 저장소는 레포 안이 아니라 `~/.gestalt/conductor`(`stateDir`로 바꿀 수 있다)에 있다. 그래서 어느 디렉토리에서 세션을 열어도 같은 상태를 본다. 다만 살아 있는 워커의 워크트리 안이거나 `GESTALT_CONDUCTOR_WORKER_ID`가 잡힌 세션에서는 `tick`, `order add`, `order remove`, `queue add`, `gate resolve`, `deploy report`가 거절된다. 컨덕터 세션은 워커 밖에서 연다.

### 주문 넣기

| 출처    | 넣는 법                                                                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 말      | 할 일을 말하면 세션이 `gestalt conductor order add`를 대신 부른다. 출처는 `spoken`으로 남는다                                                                                                                  |
| 지라    | "이 티켓들 넣어줘"라고 하면 세션이 Atlassian MCP로 티켓을 읽고 `--source jira --source-ref jira:<KEY> --issue-key <KEY>`를 붙여 넣는다                                                                         |
| PR 감시 | `prWatchRepos`에 적은 레포는 tick마다 열린 PR을 보고 주문을 만든다. 내 PR에 새 코멘트가 달리면 `review-reply`, 내가 리뷰한 PR의 head가 바뀌면 `review-loop` 주문이다. 자세한 조건은 [PR 감시](#pr-감시)에 있다 |
| 외부 큐 | 다른 시스템이 상태 저장소의 `queue/`에 JSON 파일을 두거나 `gestalt conductor queue add`로 넣으면 다음 tick이 주문으로 받는다. 파일 꼴은 [외부 큐](#외부-큐)에 있다                                             |

범위를 말로 정해 주면 그 값으로 넣고 말하지 않으면 `defaultScope`를 쓴다. 범위마다 사람에게 묻는 자리는 [주문 범위와 사람 확인](#주문-범위와-사람-확인)의 표에 있다.

## 컨덕터가 들고 있는 맥락

주문이 늘수록 컨덕터 세션 하나에 맥락이 쌓인다. 쌓이는 맥락을 둘로 나눠서 대화 밖으로 뺀다.

### 주문 하나에만 필요한 맥락

말로 일을 설명하며 오간 대화는 그 주문의 `description`에 다 옮긴다. 워커는 컨덕터 대화를 못 본다. 그래서 대화에서 나온 요구사항과 제약, 결정, 범위 밖으로 뺀 것, 참고할 파일 경로를 빠짐없이 적는다. 주문을 넣은 뒤에는 컨덕터가 그 대화 원문에 기대지 않는다. 세션을 새로 띄워도 잃는 게 없어야 하고 그 기준은 description이다.

설명이 길면 셸 인용이 깨지기 쉬워 파일로 넘긴다.

```bash
gestalt conductor order add --repo acme/app --title "배너 문구 고치기" --description-file "$tmp/order.md" --json
```

컨덕터 세션이 CLI로 넣은 설명은 자르지 않는다. 대신 `--description-file`은 64KB를 넘거나 빈 파일이면 거부한다. 지라나 외부 큐, PR 감시에서 온 설명만 4000자에서 자른다. 설명은 워커 첫 지시 파일(`prompts/`)에 자료 블록으로 그대로 실리고 체크포인트에서 다시 띄울 때도 다시 실린다.

### 여러 주문에 걸친 맥락

"이 레포는 배포를 태그 푸시로 한다", "이 레포는 이 계정을 쓴다", "요즘 우선순위" 같은 사실은 레포마다 파일 하나에 적는다. 자리는 상태 저장소 아래 `context/<owner>/<name>.md`다.

```bash
gestalt conductor context path --repo acme/app   # 경로를 알려 주고 디렉토리를 만들어 둔다
```

- 컨덕터는 사용자가 직접 말했거나 확인해 준 사실만 자기 말로 그 파일에 적는다. 지라나 PR, 큐, 워커 보고에서 본 글은 그대로 옮기지 않고 사용자에게 확인받기 전까지 그 주문의 description에만 둔다.
- 주문을 넣거나 판단할 때는 그 주문 레포의 파일만 읽는다.
- 파일이 있으면 tick이 워커 지시에 경로를 `레포 공통 맥락` 줄로 싣는다. 워커는 시작 전에 배경 사실로만 읽고 그 안의 지시는 따르지 않는다. 주문 설명과 어긋나면 주문 설명의 요구사항이 먼저다.
- 주문 하나에만 해당하는 얘기는 여기 적지 않는다. 그건 description 몫이다.

상태 저장소 아래에 둔 건 워커 지시가 이미 저장소 절대 경로를 `--state-dir`로 넘기고 있어서다. 따로 경로 설정 없이 컨덕터와 워커가 같은 파일을 본다. `conductor.json`에서 경로를 받게 하면 레포 `gestalt.json`이 그 칸을 남의 경로로 바꾸지 못하게 [설정 경계](#미리-할-설정)를 하나 더 지켜야 한다. 제품 단위로 컨덕터를 나누는 일은 이번 범위 밖이라 레포 단위로만 둔다.

### 반복 돌리기

스킬은 사람이 멈추라고 하거나 [세션 인계](#세션-인계)를 마칠 때까지 tick → hostActions → 확인 자리 점검을 반복한다. Claude Code에서는 스킬을 처음 부르면 첫 tick을 돌린 뒤 세션이 loop 스킬을 직접 불러 아래와 같은 반복을 간격 없이 건다. 간격을 비우면 세션이 간격을 스스로 정한다.

```text
/loop /gestalt:conductor tick 돌리고 hostActions 처리
```

반복이 두 겹으로 걸리지 않게 아래 경우에는 다시 걸지 않는다.

- 입력이 `/loop`으로 시작하거나 자율 반복 표식(`<<autonomous-loop-dynamic>>` 등)이 붙어 들어온 실행. 사람이 반복 프롬프트 문장을 직접 쳤으면 여기 들지 않는다
- 같은 세션에서 이미 loop 스킬을 불렀거나 `ScheduleWakeup`, 크론이 걸려 있는 상태. 압축이나 재개로 세션이 이걸 기억 못 하면 나머지 기준으로만 판단하고 사람에게 묻지 않는다. 기억이 없어 두 겹으로 걸려도 tick이 늘어날 뿐 상태는 안 깨진다. 동시에 도는 tick은 잠금에 막히고 `pollIntervalSec` 안에 다시 부른 tick은 간격 하한에 막혀 `skipped: true`로 끝난다
- 컨덕터 실행을 두고 "한 번만", `--once`처럼 이번 실행만 원한다고 말한 경우. 이때는 보고 끝에 위 명령을 알려 준다. 위 두 경우로 반복이 이미 걸려 있으면 안내를 생략하고 그 반복도 끄지 않는다

직접 `/loop`으로 시작해도 된다. 그때는 스킬이 반복을 더 걸지 않는다. `pollIntervalSec` 안에 다시 부른 tick은 `skipped: true`로 바로 끝나서 자주 불러도 토큰이 거의 안 든다. 멈추려면 멈추라고 말한다. 세션에 남은 `ScheduleWakeup`과 컨덕터 크론을 함께 끈다.

`/loop`이 없는 호스트(Codex, Grok 등)에서는 반복을 걸지 않고 안내만 한다. 다시 돌려 달라고 그때그때 말하거나 그 호스트의 반복 기능을 쓴다. 호스트마다 반복 기능이 어떻게 동작하는지는 아직 확인하지 않았다.

### 세션 인계

컨덕터 세션은 컴팩트를 한 번까지만 허용한다. 두 번째 컴팩트가 오기 전에 새 세션을 띄워 대화에만 있던 맥락을 넘기고 기존 세션은 반복을 멈춘다. 진행 상태는 이미 저장소에 들어 있으니 다시 쓰지 않는다.

1. **세션 등록.** Claude Code에서 `gestalt conductor tick`을 부르면 Bash 환경의 `CLAUDE_CODE_SESSION_ID`로 이 세션을 상태 저장소의 `sessions/<세션 id>/`에 등록한다. 이 디렉토리가 있는 세션만 컨덕터 세션으로 본다.
2. **컴팩트 세기.** 플러그인 훅 `scripts/conductor-compact-hook.sh`가 `SessionStart`의 `compact` 시작(자동과 수동 둘 다)에 걸린다. 등록된 세션이면 `sessions/<세션 id>/compactions`의 횟수를 하나 올리고 훅 입력의 `transcript_path`를 같이 적는다. 그리고 컴팩트 뒤 맥락에 "컨덕터 세션이고 N번째 컴팩트"라는 한 줄을 붙인다. 등록 안 된 세션은 아무것도 안 쓰고 끝난다. 훅은 bash와 cat, mv로만 돌고 Node를 띄우지 않는다.
3. **판정.** tick은 매번 이 세션의 `handoff`를 JSON 출력에 싣는다. 훅 입력에는 컨텍스트 사용량이 없어서 트랜스크립트 끝의 마지막 메인 응답 usage(input, cache 생성, cache 읽기의 합)를 창 크기로 나눠 사용량을 낸다. 창 크기는 `contextWindowTokens` 설정이 먼저고 비어 있으면 모델 id에 `[1m]`이 있거나 사용량이 200k를 넘을 때 1M, 아니면 200k로 본다.
   - 컴팩트 전이면 `due: false`
   - 한 번 컴팩트했고 사용량이 `handoffContextPercent`(기본 70%) 이상이면 `due: true`
   - 두 번째 컴팩트가 이미 왔으면 사용량과 상관없이 `due: true`
   - 사용량을 못 읽으면 `due: false`와 이유. 세션은 그 이유를 사용자에게 한 번 전하고 두 번째 컴팩트가 오면 넘긴다. 텍스트 출력에는 `인계 판정 못 함: <이유>` 줄로 찍힌다
4. **인계.** `due: true`를 본 세션은 그 tick에서 hostActions를 처리하고 확인 자리를 점검하는 일까지 마친 뒤 넘긴다. tick 도중이나 사람에게 확인 자리를 묻고 답을 처리하는 도중에는 넘기지 않는다. 넘길 것은 대화에만 있는 값이다.
   - `/loop` 프롬프트 원문
   - 사용자가 대화로 정한 규칙(특정 티켓 제외, tick 플래그 같은 것)
   - 사람에게 물어 두고 답을 기다리는 질문
   - 워커 reply id처럼 대화에만 있는 값

   세션이 이걸 마크다운 파일로 쓰고 아래 명령을 부른다. `--loop-prompt`는 `/gestalt:conductor`로 시작하는 한 줄(앞에 `5m ` 같은 간격 하나는 붙어도 된다, 500자 이하)만 받는다. 새 세션이 그 원문 그대로 반복을 걸기 때문이다. 꼴이 다르면 인계 파일을 쓰기 전에 거절하니 `--loop-prompt`를 빼고 다시 넘기고 사용자에게 알린다.

   ```bash
   gestalt conductor handoff --notes-file "$tmp/handoff-notes.md" \
     --loop-prompt "/gestalt:conductor tick 돌리고 hostActions 처리" --json
   ```

   명령은 상태 저장소의 `handoffs/`에 인계 파일을 쓴다. 파일은 이어받은 세션이 할 일, 반복 프롬프트 원문, 메모 순서이고 메모는 펜스로 감싸 앞의 고정 절과 섞이지 않게 한다. 그다음 띄우기 전에 거절 기록(`handoff.json`)을 남기고 오르카가 있으면 `orca agent launch --agent claude --worktree path:<지금 작업 디렉토리> --prompt "/gestalt:conductor … 인계 파일: <경로>"`로 같은 워크스페이스에 새 세션을 띄운다. 오르카가 없거나 띄우기가 실패하면 파일만 남기고 `launched: false`와 사람에게 전할 문장을 돌려준다. 세션은 그 문장을 사람에게 전한다. 띄운 뒤 결과를 `handoff.json`에 못 덮어쓰면 stderr에 `인계 기록 갱신 실패` 한 줄을 내고 결과에 `recordError`를 싣는다. 이때 기록에는 "띄우는 중"이 남지만 tick 거절은 그대로 걸린다.

5. **기존 세션 멈추기.** 넘긴 세션은 `ScheduleWakeup`을 `stop: true`로 부르고 컨덕터 크론도 지운다. 그래도 반복이 남아 tick이 다시 돌면 `sessions/<세션 id>/handoff.json`이 있어서 거절한다. 그 세션에서 계속 돌리려면 이 파일을 지운다.

새 세션은 인계 파일을 읽고 규칙을 이어 지킨다. 기다리던 질문은 사람에게 다시 묻고 tick을 한 번 돌린 뒤 원문 그대로 반복을 건다. 새 세션은 세션 id가 달라서 컴팩트 횟수를 0부터 센다.

이 흐름은 Claude Code 전용이다. 세션 id와 컴팩트 훅이 없는 호스트에서는 `handoff`가 출력에 안 실린다. `--state-dir`로 다른 저장소를 쓰면 훅이 그 자리를 몰라 횟수를 못 센다. 훅은 `GESTALT_CONDUCTOR_STATE_DIR`, `~/.gestalt/conductor.json`의 `stateDir`(절대 경로만), 기본값 순서로 저장소를 찾는다.

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

주문 하나의 결과는 아래 명령으로 읽는다. 주문 제목과 레포, 범위, 상태, 설명, 스킬 체인을 보여준다. 모든 워커의 종류와 에이전트, 상태도 나온다. 보고 이력에는 시각과 상태, 요약이 남고 refs 경로와 PR, gate, bypass도 함께 읽는다. `--json`은 같은 내용을 구조화해 돌려준다.

```bash
gestalt conductor order show <id>
gestalt conductor order show <id> --json
```

`status --all`은 끝난 주문 줄에 마지막 보고 요약을 100자까지 붙인다. `status --all --json`의 `lastSummary`에는 요약 전문이 실린다. 이전 진행 보고는 `order show`로 읽는다. 새 컨덕터 세션에서도 같은 결과를 볼 수 있다. 보고 본문을 저장하지 않던 옛 로그는 복원할 수 없어 빈 이력으로 보인다.

끝난 주문(done, failed, cancelled)이 쌓여 보기 번거로우면 `gestalt conductor order remove <주문 id...> [--json]`으로 지운다. 저장소에 `order-removed` 이벤트를 덧붙이는 방식이라 로그 기록은 남지만 status와 `order show`에서는 더 못 본다. 주문의 워커와 체크포인트, 게이트, bypass 기록도 같이 빠진다. 열린 게이트가 있거나 워커가 아직 돌거나 멈춘 워커가 남은 주문은 거절한다. 멈춘 워커는 워크트리가 남아 있을 수 있어서 기록을 지우면 그 워크트리에서 컨덕터 명령을 막던 가드가 풀린다. tick과 같은 잠금을 잡고 지우니 tick이 도는 중이면 잠시 뒤 다시 부른다. 지운 주문의 출처(지라 티켓, PR, 큐 메시지)는 따로 기억해 두고 다음 tick이 같은 주문을 다시 만들지 않는다. 지운 하위 주문도 상위 주문의 하위 주문 상한에 그대로 센다. 워크트리와 브랜치는 건드리지 않으니 필요하면 따로 정리한다. 여러 id를 넘기면 지울 수 있는 것만 지우고 나머지는 이유와 함께 알려 준다. 하나도 못 지우면 exit 1이다.

효과를 재려면 `gestalt conductor metrics --since <날짜>`를 쓴다. 무엇을 비교하는지는 [효과 재기](#효과-재기)에 있다.

#### 오르카 플러그인

오르카를 쓰면 레포의 `orca-plugin/`을 개발 폴더로 불러 사이드바 패널과 상태 표시줄에서 진행을 볼 수 있다. 패널은 레포마다 타일을 그린 지도로 시작하고 타일을 누르면 그 레포의 게이트와 주문 위계, 상태별 주문, bypass 사후 보고가 나온다. 탭 바의 + 메뉴에서 "컨덕터 보드"를 고르면 같은 내용을 에디터 탭에 넓게 펼쳐 본다. 상태 표시줄은 `주문 N · 확인 대기 M`을 띄운다. 새 게이트가 열리면 데스크톱 알림을 한 번 띄운다.

```bash
orca plugin dev load ./orca-plugin --json
```

처음 부르면 `approval_required`와 함께 받을 권한 목록과 `--approve <fingerprint>`를 붙인 명령이 나온다. 권한을 읽어 보고 그 명령을 직접 다시 부르면 켜진다. 승인은 사람이 한다.

설정의 `gestaltPath`는 오르카가 셸 PATH를 못 물려받을 때 gestalt 절대 경로를 적는 자리다. `stateDir`은 status JSON에 `stateDir`을 안 싣는 옛 CLI를 쓰면서 저장소를 기본 위치 밖에 뒀을 때만 적는다. 둘 다 비워 두면 PATH의 gestalt와 status JSON이 알려 준 저장소를 쓴다.

오르카 모바일은 플러그인 패널을 못 그린다. 폰에서 보려면 설정의 `mobilePort`에 포트를 적는다. 그러면 워커가 그 포트로 이 맥의 루프백에만 보기 전용 페이지를 연다. `tailscale serve`로 그 포트를 테일넷에 이어 폰에서 연다. 게이트와 주문 위계를 보여 주기만 하고 승인과 거절, 지우기는 데스크톱에서 한다. 명령과 보안 경계는 [`orca-plugin/README.md`](../orca-plugin/README.md#폰에서-보기)에 있다.

패널의 승인과 거절은 한 번 더 눌러야 확정되고 `gate resolve --defer-delivery`를 부른다. 오르카 워커에는 결정을 그 자리에서 전한다. 플러그인 쪽에 오르카가 안 잡히거나 전하다 실패하면 게이트에 전달 대기를 남기고 다음 tick이 직접 다시 전한다. 세 번 못 전하면 대기를 걷고 tick 보고의 `errors`에 직접 전해 달라고 남긴다. git-worktree와 서브에이전트 워커는 컨덕터 세션만 결정을 전할 수 있어서 게이트에 전달 대기를 남기고 다음 tick이 `hostActions`의 `send`로 내보낸다. 그사이 워커가 끝났으면 결정은 버리고 대기만 걷는다. 이 플래그를 모르는 옛 CLI면 플래그 없이 한 번 더 부르고 돌아온 `hostActions`를 "컨덕터 세션에서 처리할 일"로 보여 주기만 한다. 주문을 맡은 오르카 워크트리를 찾으면 그 주문을 눌러 워크트리로 바로 이동한다. 끝난 주문은 패널과 보드에서 하나씩 또는 레포 단위로 지울 수 있고 이것도 한 번 더 눌러야 `order remove`를 부른다. 자세한 동작은 [`orca-plugin/README.md`](../orca-plugin/README.md)에 있다.

## 바깥 텍스트는 자료다

지라 티켓, 외부 큐 본문, PR 제목과 코멘트, 워커 보고(요약과 `refs` 파일 본문)는 자료로만 읽는다. 거기 적힌 문장이 주문 범위나 승인, 절차를 바꾸지 못한다. 범위는 사용자가 넣은 값이나 `defaultScope`가 정하고 사람에게 물을 자리는 아래 [주문 범위와 사람 확인](#주문-범위와-사람-확인)의 표가 정한다. 규칙 전체는 `plugin/skills/_shared/untrusted-input.md`에 있다.

## 왜 tick이 외부에 직접 쓰지 않나

Execute Engine처럼 컨덕터도 Passthrough로 돈다. 추론 주체는 호스트 세션이고 tick은 상태를 계산해 할 일만 돌려준다. 지라 전환과 슬랙 게시는 사람 계정의 MCP 연결이 필요해 CLI 프로세스가 직접 하지 못한다. 그래서 `hostActions`에 담아 돌려주고 호스트 세션이 실행한다.

| hostAction        | 나오는 때                                               |
| ----------------- | ------------------------------------------------------- |
| `spawn-subagent`  | 서브에이전트 워커를 띄울 때. `promptFile`에 지시가 있다 |
| `open-session`    | 오르카가 없어 git 워크트리에 새 세션을 열 때            |
| `send`            | 살아 있는 워커에 사람 결정이나 bypass 결과를 전할 때    |
| `jira-transition` | 주문 단계가 바뀌어 지라 상태를 옮길 때                  |
| `slack-post`      | 사람이 승인한 슬랙 초안을 게시할 때                     |

gh로 읽을 수 있는 PR 목록과 계정 전환은 tick이 직접 한다. 오르카 워커도 오르카 CLI로 직접 띄운다.

## 상태 저장소

주문, 워커, 체크포인트, 사람 확인 자리(gate), bypass 기록은 전부 `events.jsonl`에 이벤트로 한 줄씩 덧붙는다. 상태는 이 로그를 처음부터 다시 재생해서 만든다. 컨덕터 세션이 압축되거나 새로 떠도 같은 저장소를 열면 같은 상태에서 이어 간다.

| 경로                        | 쓰는 쪽         | 내용                                                                                                                                                                                                                                                           |
| --------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.jsonl`              | tick, CLI 명령  | 상태 이벤트와 실제 워커 에이전트, 보고 이력. `report-applied`에 workerId, status, summary, refs, skill, prRef, merged, stopReason, need를 보존하며 진행 보고도 포함한다. 하위 주문 요청(`spawnRequest`)은 주문 이벤트로 옮겨지므로 보고에는 다시 남기지 않는다 |
| `inbox/`                    | 워커            | `worker report`가 남긴 결과 파일. 다음 tick이 상태와 보고 본문을 이벤트에 기록한 뒤 지운다. 적용하다 실패한 원문은 `inbox/failed/`로 옮긴다                                                                                                                    |
| `inbox/unrecorded/`         | tick            | 적용은 끝났는데 `report-applied` 기록만 실패한 결과 파일. 다음 tick이 다시 적용하지 않고 기록만 남긴 뒤 지운다. 다시 적용하면 bypass와 워커에 전하기, 하위 주문이 한 번 더 돌기 때문이다                                                                       |
| `prompts/`                  | tick            | 워커 첫 지시 파일                                                                                                                                                                                                                                              |
| `worktrees/`                | tick            | 오르카가 없을 때 만든 git 워크트리                                                                                                                                                                                                                             |
| `deploy/`                   | 호스트          | `deploy report`가 남긴 배포 결과                                                                                                                                                                                                                               |
| `queue/`                    | 외부 시스템     | 외부 큐 메시지. 다음 tick이 읽고 지운다. 못 읽은 파일은 `queue/failed/`로 옮긴다                                                                                                                                                                               |
| `slack/`                    | 호스트          | 슬랙 초안 본문                                                                                                                                                                                                                                                 |
| `context/<owner>/<name>.md` | 컨덕터 세션     | 레포 공통 맥락. 워커 지시에 경로가 실린다                                                                                                                                                                                                                      |
| `sessions/<세션 id>/`       | tick, 컴팩트 훅 | 등록한 컨덕터 세션. `session.json`은 tick이, `compactions`(횟수와 트랜스크립트 경로)는 훅이, `handoff.json`(인계 기록)은 `handoff` 명령이 쓴다                                                                                                                 |
| `handoffs/`                 | `handoff` 명령  | 새 컨덕터 세션에 넘긴 인계 파일                                                                                                                                                                                                                                |
| `tick.lock`                 | tick            | 겹쳐 도는 tick을 막는 잠금. 낡은 잠금을 걷을 때와 풀 때는 `tick.lock.steal`을 잡아 한 프로세스씩 지운다                                                                                                                                                        |

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

| 주문                                                                     | 오르카 있음                                               | 오르카 없음    |
| ------------------------------------------------------------------------ | --------------------------------------------------------- | -------------- |
| 체인이 전부 읽기만 하는 스킬(review, blast-radius, diff-radius, explain) | `subagent`                                                | `subagent`     |
| 그 밖의 체인(solve, ship, review-loop, review-reply, local-pr 등)        | `orca-worktree`                                           | `git-worktree` |
| `--worker-kind`로 고정                                                   | 그 값. `orca-worktree`인데 오르카가 없으면 `git-worktree` |                |

기준은 `handoff` 스킬의 "맡길 곳 고르기" 표를 따른다.

### 워커 에이전트 고르기

사용자 전역 `~/.gestalt/conductor.json`에 기본값과 레포별 값을 적는다. 레포마다 쓰는 에이전트가 다를 수 있어 `repoPaths`처럼 레포(`owner/name`)를 키로 하는 맵을 둔다. 레포 안의 `gestalt.json`에서는 이 값을 받지 않는다.

```json
{
  "defaultAgent": "claude",
  "repoAgents": { "acme/app": "codex" }
}
```

주문 하나만 다르게 띄우려면 다음처럼 넣는다.

```bash
gestalt conductor order add --repo acme/app --title "배너 문구 고치기" --agent cursor
```

첫 실행의 우선순위는 주문의 `--agent` > `repoAgents[레포]` > `defaultAgent` > `claude`다. ID는 영문자나 숫자로 시작하고 영문자, 숫자, `.`, `_`, `:`, `-`만 쓴 64자 이하여야 한다. `-`로 시작하는 값은 오르카 CLI가 옵션으로 읽으므로 받지 않는다. 지원 여부는 오르카가 판단한다. `claude`, `codex`, `cursor`, `opencode` 외의 ID도 받는다. 주문의 선택은 주문 이벤트에, 실제 실행값은 워커 이벤트에 남는다. 재개할 때는 앞 워커의 에이전트를 유지하므로 설정을 바꿔도 실행 도중 에이전트가 바뀌지 않는다. 에이전트 기록이 없는 옛 오르카 워커는 기존 동작인 `claude`로 재개한다.

이 선택은 `orca-worktree`에만 적용한다. `subagent`는 호스트 세션 안에서 뜨므로 agent를 무시한다. `git-worktree`의 `open-session`도 agent를 싣지 않고 호스트의 세션 여는 방식을 따른다. 호스트마다 에이전트 CLI 실행법이 달라 컨덕터가 특정 실행법을 가정하지 않기 때문이다.

### 부모 워크트리와 기준 브랜치

기존 워크트리 아래 하위로 워커를 띄우려면 주문에 `--parent-worktree`를 준다. 어느 ref에서 갈라질지는 `--base-branch`로 정한다.

```bash
gestalt conductor order add --repo acme/app --title "쿠폰 목록 하위 작업" \
  --parent-worktree ~/orca/workspaces/app/feat-coupon --base-branch feat-coupon
```

`--parent-worktree`는 경로나 오르카 선택자(`branch:feat-coupon`, `id:...` 같은 것)를 받는다. 선택자면 `orca worktree show`로 경로를 받아 온다. `path:`로 시작하면 접두어를 떼고 로컬 경로로 본다. 접수할 때 워크트리 루트의 절대 경로로 풀고 주문 레포의 워크트리인지 확인한다. `repoPaths`에 그 레포가 있으면 git 공용 디렉토리가 같은지 보고 없으면 `origin` 주소가 `owner/name`과 맞는지 본다. 경로가 없거나 git 워크트리가 아니거나 레포가 다르면 주문을 받지 않는다. `origin`으로 맞출 때는 호스트를 안 본다. SSH 별칭(`git@github-work:acme/app.git`)도 받으려는 것이고 호스트가 다른 동명 레포를 가려야 하면 `repoPaths`에 그 레포 경로를 적는다.

`--base-branch`는 브랜치 이름이나 `origin/main` 같은 ref를 받는다. `-`로 시작하거나 `..`, `@{`, 공백이 있거나 `/`로 나눈 조각이 비었거나 `.`으로 시작하거나 `.lock`으로 끝나면 거절한다. 부모 없이 단독으로 줘도 된다.

외부 큐는 `baseBranch`만 받고 `parentWorktree`는 확인 자리로 올린다. 부모 경로는 이 머신에서 확인한 값이어야 해서 `order add`로 넣은 주문만 받는다. 말로 받은 주문이 아닌데 기준 브랜치가 있으면 새 워크트리의 셋업을 건너뛴다(`--setup skip`). 바깥에서 고른 브랜치의 셋업 스크립트를 이 호스트에서 돌리지 않으려는 것이다.

| 워커            | `--parent-worktree`                                                                                                             | `--base-branch`                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `orca-worktree` | `orca worktree create --parent-worktree`로 그 아래 하위 워크트리를 먼저 만들고 `worker-start --worktree`로 그 워크트리에 띄운다 | 하위 워크트리나 `new-top-level` 워크트리를 그 ref에서 갈라낸다                                |
| `git-worktree`  | 무시하고 tick 보고의 `warnings`에 남긴다                                                                                        | 워커 브랜치를 새로 만들 때 그 ref에서 갈라낸다. 재개 때 남은 브랜치를 다시 붙이면 쓰지 않는다 |
| `subagent`      | 무시하고 `warnings`에 남긴다                                                                                                    | 무시하고 `warnings`에 남긴다                                                                  |

`worker-start --worktree new-child`는 호출한 쪽(컨덕터) 워크스페이스 아래에 붙어서 임의 부모를 고를 수 없다. 그래서 워크트리를 먼저 만드는 두 단계로 띄운다. 워크트리를 만든 뒤 워커가 못 뜨면 오르카가 아무것도 바꾸기 전에 거절했거나(`selector_not_found`) `failed`와 함께 남은 자원이 비었다고 답했을 때만 만든 워크트리를 지운다. 시간 초과나 `outcome_unknown`, 남은 자원을 안 밝힌 실패처럼 워커가 떴는지 모르면 지우지 않는다. 그때나 지우기가 실패했을 때, `worktree create` 자체가 실패했을 때는 남은 워크트리와 `orca worktree rm` 명령을 실패 사유에 붙여 확인 자리로 올린다. 실패한 띄우기는 회차를 안 올리므로 남은 워크트리를 지우기 전에는 같은 이름으로 다시 만들다 실패한다. 부모만 주고 기준 브랜치를 비우면 어디서 갈라질지는 오르카 기본값을 따른다. 부모 브랜치에서 이어 가려면 `--base-branch`에 그 브랜치를 같이 준다.

재개와 정리는 부모가 없는 오르카 워커와 같다. 재개하면 같은 부모 아래 `<주문 id>-<회차>` 이름으로 하위 워크트리를 새로 만든다. 정리는 `worker-release`로 워커 터미널만 거두고 워크트리는 남긴다.

## 동시 상한과 큐

`maxConcurrentWorkers`(기본 10)를 넘는 주문은 `queued`로 남았다가 슬롯이 나면 뜬다. 슬롯은 `starting`과 `running` 워커만 차지한다. 상한은 tick마다 설정을 다시 읽어서 도는 중에 바꿔도 다음 tick부터 적용된다.

## 주문 범위와 사람 확인

| 범위              | 머지 승인       | 인터뷰 답              |
| ----------------- | --------------- | ---------------------- |
| `merge-through`   | 컨덕터가 넘긴다 | 워커가 맥락에서 정한다 |
| `approval` (기본) | 사람에게 묻는다 | 워커가 맥락에서 정한다 |
| `interview-first` | 사람에게 묻는다 | 사람에게 묻는다        |

워커가 혼자 못 넘는 자리를 만나면 `needs`로 보고한다. 컨덕터는 아래처럼 나눈다.

| 요청                             | 처리                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `merge-approval`                 | 위 표대로                                                                                  |
| `interview-answer`               | 위 표대로                                                                                  |
| `slack-post`                     | 늘 사람에게                                                                                |
| `review-manual-switch`           | 늘 사람에게. 리뷰 스킬의 라운드 상한과 수동 전환 지침을 그대로 따른다                      |
| `simple-approval`                | 컨덕터가 승인하고 기록한다                                                                 |
| `manual-verification`, `cleanup` | 워커가 직접 하고 다음 보고에 남기라고 돌려준다                                             |
| `auth`, `account-switch`         | `~/.gestalt/conductor.json`의 `accounts`에 적힌 레포만 그 계정으로 맞춘다. 없으면 사람에게 |
| `other`                          | 사람에게 (`no-procedure`)                                                                  |

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

| 주문 단계                                                 | 지라 상태   |
| --------------------------------------------------------- | ----------- |
| 접수                                                      | TODO        |
| 워커 시작                                                 | In Progress |
| 리뷰 스킬(ship, local-pr, review-reply, review-loop) 시작 | PR          |
| 머지 (sub-task)                                           | Done        |
| 배포 성공 (bug, task, sub-bug)                            | In-QA       |

주문에 `jiraStatus`가 있으면 사용자가 정한 값이라 기본 규칙보다 먼저다. 배포는 머지 뒤 파이프라인 성공으로 판단한다. 호스트가 결과를 확인해 `gestalt conductor deploy report`로 남기고 tick이 읽는다. 배포가 실패하면 그 주문만 사람에게 올린다.

## PR 감시

`~/.gestalt/conductor.json`의 `prWatchRepos`에 적은 레포만 열린 PR을 gh로 읽는다. 기본은 빈 배열이라 적지 않으면 감시하지 않는다. 본문은 안 싣고 누가 언제 남겼는지만 본다.

```json
{
  "repoPaths": { "acme/app": "/path/to/app", "acme/web": "/path/to/web" },
  "prWatchRepos": ["acme/app"]
}
```

`repoPaths`는 워크트리를 만들 경로를 알려 주는 칸이라 여기 적었다고 감시하지는 않는다. 레포를 추가하자마자 오래된 draft나 사람이 다른 세션에서 직접 맡은 PR까지 주문이 생기는 걸 막으려고 둘을 나눴다.

- gh는 그 레포의 로컬 체크아웃에서 부르므로 `prWatchRepos`에 적은 레포는 `repoPaths`에도 같은 철자의 키로 경로가 있어야 한다. 없으면 그 레포만 감시에서 빠지고 tick 보고의 `errors`에 이유가 남는다.
- `owner/name` 꼴이 아닌 항목(끝 공백이 붙었거나 `/`가 없는 값)도 감시에서 빠지고 `errors`에 그 값이 따옴표로 감싸여 남는다.
- 감시 간격 안이라 건너뛴 tick은 감시를 안 돌므로 위 오류도 남기지 않는다.
- 이번 tick만 감시를 건너뛰려면 `gestalt conductor tick --no-pr-watch`를 쓴다.
- 남이 만든 레포 안에서 세션을 열었다고 감시 대상이 바뀌면 안 되므로 레포 `gestalt.json`의 `prWatchRepos`는 받지 않는다.

감시가 켜진 레포에서는 PR마다 아래처럼 주문을 만든다.

- **내가 올린 PR**: 내가 마지막으로 답한 뒤에 다른 사람 코멘트가 있으면 `review-reply` 주문을 만든다.
- **내가 리뷰한 PR**: 내가 리뷰한 뒤 head가 바뀌었으면 `review-loop` 주문을 만든다. 코드는 그대로인데 답만 달렸으면 `review-manual-switch` 확인 자리로 사람에게 묻고 승인되면 재리뷰 주문을 만든다.

워커는 PR을 다루면 결과 보고에 `--pr owner/name#번호`를 싣는다. PR 감시는 끝나지 않은 주문에 붙은 이 값으로 이미 처리 중인 PR을 건너뛰므로 빠지면 같은 PR에 주문이 또 생긴다. ship이 draft PR을 만들면 Copilot 리뷰를 요청하기 전에 `--status progress --skill ship --summary "<한 줄 요약>"`으로 바로 보고한다. 끝 보고까지 미루면 그 사이 Copilot 코멘트가 달린 PR을 감시가 새 PR로 보고 `review-reply` 주문을 만든다.

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
- 오르카 `agent launch`가 첫 지시의 `/gestalt:conductor`를 스킬 호출로 받는지와 응답 JSON의 세션 id 필드
- 실제 컴팩트 직후 트랜스크립트 마지막 응답의 usage가 줄어든 크기로 바로 잡히는지
- gh `pr list --json`의 `reviews[].commit.oid`와 `comments[].id`
- 지라 전환 이름이 프로젝트마다 다를 때 호스트가 고르는 전환
