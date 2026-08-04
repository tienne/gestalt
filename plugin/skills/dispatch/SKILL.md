---
name: dispatch
version: "1.0.0"
description: "실행 세션의 착수 가능 태스크를 외부 에이전트 런타임(Orca)의 터미널로 뿌려 병렬 실행한다. 워커별로 다른 에이전트 CLI를 쓰거나, 진행을 터미널로 들여다봐야 하거나, 오래 걸리는 실행을 추적해야 할 때 쓴다. opt-in 대안 백엔드다 — 외부 런타임이 없으면 execute 스킬의 기본 병렬 경로(호스트 Agent 도구)가 그대로 낫고, 이 스킬은 그 사실을 밝히고 물러난다. 계획 수립이나 평가는 execute 스킬이 담당한다."
triggers:
  - "orca로 실행"
  - "orca로 병렬"
  - "워커로 뿌려"
  - "터미널로 뿌려"
  - "병렬 디스패치"
  - "다른 에이전트로 실행"
  - "codex로 실행"
  - "워커 띄워서 실행"
inputs:
  sessionId:
    type: string
    required: false
    description: "실행 세션 ID. active 또는 latest도 가능. 비우면 active로 본다"
  agent:
    type: string
    required: false
    description: "워커에 띄울 에이전트 CLI(claude, codex, gemini 등). 비우면 확인 후 결정"
  maxConcurrent:
    type: number
    required: false
    description: "동시에 띄울 워커 수 상한. 비우면 ready 집합 크기와 4 중 작은 값"
outputs:
  - dispatched_tasks
  - worker_results
---

# Dispatch Skill

실행 세션에서 지금 착수 가능한 태스크를 외부 에이전트 런타임의 터미널로 뿌려 병렬 실행한다. 게슈탈트가 무엇을 언제 할 수 있는지 계산하고, 외부 런타임이 워커를 띄우고 생애주기를 추적한다.

> **도구가 없을 때** → [`../_shared/tool-availability.md`](../_shared/tool-availability.md)
> 이 스킬은 외부 CLI에 의존한다. 없으면 흉내내지 않고, 어느 경로로 갈지 밝히고 기본 경로로 넘긴다.

## 이 스킬을 쓸 이유가 없는 경우가 많다

`execute` 스킬은 이미 `parallelGroups`를 읽어 호스트의 Agent 도구로 병렬 실행한다. 외부 런타임 없이 동작하고 더 가볍다. **기본값은 그쪽이다.**

이 스킬로 얻는 것은 병렬 자체가 아니라 세 가지다.

| 얻는 것 | 기본 경로로는 |
|---------|---------------|
| 워커별로 다른 에이전트 CLI (codex, gemini 등 혼용) | 불가 — 호스트 모델 하나 |
| 사람이 워커 진행을 터미널로 들여다보기 | 불가 — Agent 도구 내부는 안 보임 |
| `worker_done` 생애주기, 결정 게이트, 연속 실패 차단 | 없음 |

셋 다 필요하지 않으면 이 스킬을 쓰지 않는다. 사용자가 "orca로", "codex로", "워커 띄워서"처럼 **명시적으로 외부 런타임이나 다른 CLI를 지목했을 때만** 발동한다. 단지 병렬로 빠르게 돌리고 싶다는 요청은 execute 스킬로 보낸다.

## 0단계: 런타임 감지 — 없으면 여기서 끝낸다

**존재 여부만으로 판단하지 않는다.** 리눅스에서 `orca`는 GNOME 스크린리더 이름이다. `which orca`로 찾으면 엉뚱한 프로그램에 명령을 보내게 된다.

실행 파일 결정 순서:

1. 리눅스이고 Orca 관리 터미널 밖이면 `orca-ide`
2. 그 외에는 `orca`

결정한 실행 파일로 런타임이 실제로 응답하는지 확인한다.

```bash
<실행파일> status --json
```

이 응답이 정상 JSON이고 런타임이 도달 가능할 때만 진행한다. 이후 모든 명령에 같은 실행 파일을 쓴다.

**감지에 실패하면 아래를 사용자에게 말하고 멈춘다.**

```
Orca 런타임이 붙지 않아 워커 디스패치는 못 합니다.
대신 execute 스킬의 기본 병렬 경로(호스트 Agent 도구)로 진행할 수 있어요 — 이건 외부 도구 없이 동작합니다.
그쪽으로 갈까요?
```

**감지 실패를 성공으로 보고하지 않는다.** Agent 도구로 돌렸으면 "Orca로 디스패치했다"고 말하지 않는다. 어느 경로로 돌았는지 완료 보고에 명시한다.

## 1단계: 착수 가능한 태스크 읽기

```json
{ "action": "status", "sessionId": "active" }
```

응답의 `nextTaskIds`가 지금 동시에 착수 가능한 태스크 집합이다. `sessionId`에는 `active`나 `latest`를 그대로 넣을 수 있다.

- `nextTaskIds`가 비어 있으면 진행할 게 없다. 모든 태스크가 끝났으면 evaluate로 넘기고, 아니면 왜 비었는지(의존성 미충족, 실패 태스크) 확인해 보고한다.
- `nextTaskIds`가 1개면 디스패치 이득이 없다. 그 사실을 말하고 기본 경로를 권한다.
- 2개 이상일 때만 아래로 간다.

## 2단계: 워커를 어디에 띄울지 — 기본은 같은 워크트리

**병렬 실행은 워크트리를 나눌 이유가 아니다.** 같은 워크트리에 에이전트 터미널을 여럿 띄우는 것이 기본이다. 이유가 둘이다.

1. Orca 자체 가이드가 그렇게 말한다 — 독립 태스크, 병렬 실행, 편의, 체크아웃 분리 선호는 모두 격리 요건이 아니다. 파일 충돌로 공유가 불가능할 때만 워크트리를 만든다.
2. 같은 워크트리면 `.gestalt/`를 공유한다. 코드 그래프와 memory가 그대로 살아 있다. 워크트리를 나누면 워커마다 그래프가 비어 blast-radius를 못 쓰고 memory도 빈 상태로 시작한다.

```bash
<실행파일> terminal create --worktree active --title <task-id> --command "<agent>" --json
<실행파일> terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
```

`tui-idle`을 기다리는 건 프롬프트가 씹히는 것을 막기 위한 것이다. 항상 `--timeout-ms`를 넘긴다.

워크트리를 새로 만드는 것은 **ready 집합의 태스크들이 같은 파일을 건드릴 때만**이다. 그 경우 먼저 사용자에게 충돌을 짚고 워크트리 분리가 필요하다고 말한 뒤 진행한다. 워크트리를 나눴다면 그 워커는 코드 그래프와 memory가 비어 있다는 사실도 함께 알린다.

## 3단계: 태스크를 디스패치한다

태스크마다 Orca 오케스트레이션 태스크를 만들고 워커에 넣는다. `--inject`가 워커에게 생애주기 프리앰블을 붙여 `worker_done`을 보내게 한다.

```bash
<실행파일> orchestration task-create --spec "<태스크 브리핑>" --json
<실행파일> orchestration dispatch --task <task_id> --to <handle> --inject --json
```

**태스크 브리핑에 반드시 담을 것:**

- 게슈탈트 실행 세션 ID(UUID 원문 — 워커는 다른 프로세스라 `active`가 다르게 해석될 수 있다)
- 이 워커가 맡은 게슈탈트 taskId
- `taskContext.taskPrompt` 내용
- 완료 후 `ges_execute action=execute_task`로 결과를 제출하라는 지시
- **다른 태스크는 건드리지 말라는 경계** — 워커가 ready 집합을 보고 남의 태스크까지 하려 들면 충돌한다

동시 워커 수는 `maxConcurrent`로 제한한다. 지정이 없으면 ready 집합 크기와 4 중 작은 값을 쓴다. 워커마다 에이전트 프로세스와 게슈탈트 MCP 서버가 하나씩 뜨므로 무제한으로 띄우지 않는다.

## 4단계: 기다린다 — 폴링하지 않는다

```bash
<실행파일> orchestration check --wait --types worker_done,escalation,decision_gate --timeout-ms 900000 --json
```

- **타임아웃은 실패가 아니라 체크포인트다.** 코딩 태스크는 15~60분이 흔하다. `worker_done`이나 `escalation`을 받거나, 터미널이 사라지거나, 사용자가 멈추라고 하기 전까지 대기를 계속 건다.
- 하트비트와 터미널 활동은 살아 있다는 뜻이지 끝났다는 뜻이 아니다. 완료 메시지가 없다는 이유로 워커를 죽이거나 재시작하지 않는다.
- `check --wait`는 한 번에 하나를 돌려준다. 워커 N개가 동시에 끝날 수 있으면 N번 돌린다.
- `decision_gate`가 오면 사용자에게 판단을 받아 `orchestration reply`로 답하고 계속 기다린다.

## 5단계: `worker_done`마다 ready 집합을 다시 읽는다

**캐시된 세션 상태를 믿지 않는다.** 워커마다 게슈탈트 MCP 서버 프로세스가 따로 뜨고, 각 프로세스가 인메모리 세션을 따로 들고 있다. 이벤트는 append-only라 replay하면 수렴하지만, 다른 프로세스가 방금 넣은 결과는 이쪽 파생 상태(`nextTaskIds`)에 아직 반영되지 않는다.

그래서 `worker_done`을 받을 때마다 다시 읽는다.

```json
{ "action": "status", "sessionId": "<UUID>" }
```

새로 ready가 된 태스크가 있으면 2~3단계로 디스패치한다. **ready 집합을 앞으로 굴리는 것은 이 코디네이터 한 명만 한다.** 워커에게 다음 태스크를 알아서 집으라고 시키면 둘이 같은 태스크를 잡는다.

## 6단계: 막힌 것은 게이트로 올린다

게슈탈트가 human escalation으로 세션을 끝냈으면(`terminationReason: 'human_escalation'`) 그 사실을 Orca 게이트로 올려 사람 눈에 보이게 한다.

```bash
<실행파일> orchestration gate-create --task <task_id> --question "<막힌 지점과 필요한 판단>" --json
<실행파일> worktree set --worktree active --comment "blocked: 사람 판단 필요" --json
```

카드 코멘트를 남기면 터미널을 열지 않고도 `worktree ps`나 모바일에서 상태가 보인다. 의미 있는 체크포인트마다 코멘트를 갱신한다.

## Do-NOT

- **execute 스킬을 대체하지 않는다.** 계획 수립(Planning), 평가(Evaluate), 개선(Evolve)은 execute가 한다. 이 스킬은 Phase 2 실행을 다른 백엔드로 돌리는 것뿐이다.
- **런타임이 없을 때 흉내내지 않는다.** 0단계에서 멈추고 기본 경로를 권한다.
- **병렬 실행을 이유로 워크트리를 만들지 않는다.** 파일 충돌만이 사유다.
- **워커에게 ready 집합을 굴리게 하지 않는다.** 코디네이터만 한다.
- **`worker_done` 없이 완료로 보고하지 않는다.** 터미널이 조용한 것은 완료가 아니다.
- **워커를 무제한으로 띄우지 않는다.** 워커마다 에이전트와 MCP 서버 프로세스가 하나씩 붙는다.

## 에러 처리

| 상황 | 대응 |
|------|------|
| CLI 없음 또는 `status --json` 실패 | 0단계에서 멈추고 기본 경로 제안 |
| `ready` 집합이 0개 | 이유(전체 완료/의존성 미충족/실패 태스크)를 확인해 보고 |
| `ready` 집합이 1개 | 디스패치 이득 없음을 말하고 기본 경로 권유 |
| 터미널 핸들이 `terminal_handle_stale` | `terminal list`로 다시 조회해 교체 핸들만 쓴다. 낡은 핸들과 새 핸들에 이중 전송하지 않는다 |
| 워커가 같은 태스크를 3회 연속 실패 | 그 태스크 디스패치를 멈추고 사용자에게 보고. evolve 파이프라인으로 넘길지 확인 |
| `check --wait` 타임아웃 | 실패가 아니다. `task-list`나 `terminal read`로 생존을 확인하고 대기를 다시 건다 |
| DB 잠금 오류(`SQLITE_BUSY`) | 워커 수를 줄이고 재시도. 게슈탈트 이벤트 DB는 홈 글로벌이라 프로세스가 겹친다 |

## 완료 보고

- 어느 경로로 실행했는지 (외부 런타임 워커 / 호스트 Agent 도구)
- 디스패치한 태스크와 각 결과
- 워커별로 어떤 에이전트를 썼는지
- 실패한 태스크와 다음 행동
- 워크트리를 나눴다면 그 워커의 코드 그래프와 memory가 비어 있었다는 사실
