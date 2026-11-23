# 컨덕터 끝난 주문 보관

## 배경

컨덕터 상태 저장소(기본 `~/.gestalt/conductor`)는 이벤트를 `events.jsonl`에 덧붙이기만 하고 지우지 않는다. 2026-11-20에 저장소를 확인한 값은 아래와 같다.

- 11/12부터 8일 동안 전체 18MB가 쌓였다. `events.jsonl`이 4MB(1.36만 줄), `prompts/`가 3.2MB, 조회용 `snapshot.json`이 2.2MB다. 이 속도면 1년에 800MB쯤 된다.
- 이벤트 대부분은 진행 기록이다. `worker-updated` 4천 줄, `order-updated` 2.7천 줄, 체크포인트 1.6천 줄이고 결과 보고(`report-applied`)는 1.5천 줄이다.
- 주문 330개 중 끝난 주문이 330개(done 294, cancelled 32, parked 4)다. 살아 있는 주문 상태를 만드는 데 필요한 이벤트는 몇 줄 안 되는데 tick은 매번 1.36만 줄을 처음부터 재생한다. 지금은 0.3초인데 로그가 커지는 만큼 느려진다.
- `snapshot.json`은 끝난 주문까지 통째로 담아 tick마다 다시 쓴다.

운영 상태(살아 있는 주문을 굴리는 데 필요한 것)와 결과 기록(끝난 주문을 나중에 찾아 읽는 것)을 나눈다. 결과 기록 쪽의 첫 단계인 refs 사본(`refs/<주문 id>/`)은 먼저 들어갔다. 규칙은 [`docs/conductor.md`의 refs 사본](../conductor.md#refs-사본)에 있다.

## 목표와 비목표

목표

- 끝나고 일정 기간이 지난 주문의 이벤트와 결과를 `archive/YYYY-MM/`로 옮기고 `events.jsonl`에는 살아 있는 주문에 필요한 것만 남긴다.
- 재생 비용이 저장소 나이가 아니라 살아 있는 주문 수를 따라가게 한다.
- 옮긴 주문도 같은 출처(지라 티켓, PR, 큐 메시지)로 다시 만들어지지 않게 한다.
- `prompts/`와 `handoffs/` 같은 운영 파일을 보관 시점에 정리한다.

비목표

- 검색 색인(SQLite FTS 등). 보관소는 파일로만 둔다.
- 결과 뷰어가 보관소를 읽게 하는 일. 뷰어(`feat/conductor-results-viewer`)가 main에 들어간 뒤 후속으로 한다.
- 옛 이벤트 고치기. 보관은 이벤트를 옮기기만 하고 내용은 바꾸지 않는다.

## 설계

### 결정 요약

| 항목        | 결정                                                                                               | 근거                                                         |
| ----------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 재생 기준점 | `base.json`(상태 스냅샷)에서 시작해 남은 segment의 반영 길이 뒤와 `events.jsonl`을 이어서 재생한다 | 로그를 잘라도 같은 상태를 만든다                             |
| 자르는 방식 | `events.jsonl`을 `segments/`로 이름 바꿔 떼어 내고 새 파일에 이어 쓴다                             | 워커 프로세스가 잠금 없이 덧붙이므로 파일을 다시 쓰지 않는다 |
| 잠금        | tick과 같은 `tick.lock`을 잡는다                                                                   | tick, `order remove`와 겹치지 않는다                         |
| 중복 판정   | 보관한 주문의 출처를 `base.json`의 `archivedOrders`에 남긴다                                       | `removedOrders`와 같은 방식이다                              |
| 보관 대상   | 아래 [열린 질문](#열린-질문)의 제안 값으로 정했다(2026-11-22)                                      |                                                              |

### 저장소 구성

```
events.jsonl            base.json 이후의 이벤트
base.json               기준점 상태. 어느 segment까지 반영했는지(foldedSegments) 함께 남긴다
segments/               떼어 낸 로그. 반영한 뒤에도 다음 반영까지 남겨 둔다
archive/YYYY-MM/
  <주문 id>/
    events.jsonl        그 주문의 이벤트(주문, 워커, 게이트, 보고, 체크포인트, bypass, 지라 전이)
    order.json          끝 상태의 주문, 워커, 보고 이력(order show --json과 같은 꼴)
    refs/               refs/<주문 id>/ 사본을 옮긴 것
```

`YYYY-MM`은 주문이 끝난 달이다. 주문을 찾을 때 달부터 좁힐 수 있다.

### 재생

`ConductorStore.open`은 아래 순서로 상태를 만든다.

1. `base.json`이 있으면 읽어 시작 상태로 쓴다. 없으면 빈 상태다. 지금 저장소는 `base.json`이 없으니 지금과 같게 돈다.
2. `segments/`에 남은 파일을 이름 순서로 재생한다. `base.json`의 `foldedSegments`에 있는 segment는 적힌 길이 뒤에 붙은 줄만 재생한다. 반영한 뒤 늦게 붙은 줄을 받는 자리다. base.json에 반영하다 죽었을 때 남은 segment도 여기서 다시 재생한다.
3. `events.jsonl`을 재생한다.

`base.json`은 `eventCount`와 `ticks` 같은 누적 값도 담는다. 재생 결과가 반영 전과 같아야 하고 테스트는 "반영 전 상태 = 반영 뒤 다시 연 상태 + 보관한 주문"으로 확인한다.

### 보관 한 번

`gestalt conductor archive [--older-than <일>] [--dry-run]`과 tick 끝의 정리 단계가 같은 함수를 부른다. tick에서는 하루 한 번만 돈다.

1. `tick.lock`을 잡는다. 못 잡으면 이번엔 넘긴다.
2. `events.jsonl`을 `segments/<순번>-<시각>.jsonl`로 이름을 바꾼다. 이 순간부터 덧붙는 이벤트는 새 `events.jsonl`로 간다.
3. 이름을 바꾸기 직전에 파일을 연 워커가 옛 파일에 한 줄을 쓸 수 있다. 1초 기다린 뒤 segment 크기가 더 늘지 않는 걸 확인하고 읽는다.
4. `base.json` + segment를 재생해 상태를 만들고 재생한 이벤트를 주문별로 `order-logs/<주문 id>/`에 옮겨 둔다. 보관할 주문을 고르고 그 주문의 `order-logs/`를 이어 `archive/YYYY-MM/<주문 id>/events.jsonl`로 쓰고 `order.json`을 쓴다. `refs/<주문 id>/`는 `archive/YYYY-MM/<주문 id>/refs/`로 옮긴다. `order.json`의 `refCopies[].path`는 옮긴 자리로 바꿔 적고 `events.jsonl`은 원래 값 그대로 둔다.
5. 상태에서 보관한 주문을 `removeFromSnapshot`과 같은 규칙으로 빼고 `archivedOrders`에 출처를 남긴 뒤 `base.json`을 원자적으로 쓴다. `foldedSegments`는 디스크에 남은 segment 전부의 이름과 반영한 길이로 다시 쓴다.
6. 지난 반영에서 남겨 둔 segment를 지운다(또는 압축해 둔다. 열린 질문 3). 이번에 떼어 낸 segment는 늦게 붙는 줄을 받으려고 다음 반영까지 남긴다.
7. 잠금을 푼다.

어느 단계에서 죽어도 다시 열면 `base.json`과 남은 segment, `events.jsonl`로 같은 상태가 나온다. 4번의 보관 파일은 주문 id로 덮어쓰므로 다시 돌아도 겹치지 않는다.

### 이벤트를 주문에 붙이는 규칙

| 이벤트                       | 주문을 찾는 칸                                             |
| ---------------------------- | ---------------------------------------------------------- |
| `order-*`                    | `orderId`, `order.id`                                      |
| `worker-*`, `report-applied` | `workerId`로 워커를 찾아 `orderId`                         |
| `checkpoint-saved`           | `checkpoint.orderId`                                       |
| `gate-*`, `slack-posted`     | `gate.orderId`, `gateId`로 게이트를 찾아 `orderId`         |
| `bypass`, `jira-transition`  | `record.orderId`                                           |
| `tick`, `tail-repaired`      | 주문에 안 붙는다. `base.json`에 누적 값만 남고 줄은 버린다 |

주문에 안 붙는 컨덕터 게이트는 끝나고 같은 기간이 지나면 버린다. `sourceRef`가 있거나 승인 뒤 할 일(슬랙 게시, 워커 정리 반영)이 남은 게이트는 둔다. 주문도 같은 이유로 안 거둔 워커나 열린 정리 실패 게이트, 안 올린 슬랙 게시가 남았으면 옮기지 않는다. 옮긴 주문에 늦게 붙는 줄은 모으지 않고 버린다. `report` 없이 이름만 있는 옛 `report-applied`도 주문에 안 붙는다. 이 줄은 `appliedReports`에만 쓰이고 그건 `base.json`에 남는다.

### 중복 판정

지라 소스와 PR 감시는 `sourceRef`로 이미 받은 주문인지 본다. 지운 주문은 `removedOrders`가 막는다. 보관한 주문은 `archivedOrders`(`sourceRef`, `parentOrderId`, `archivedAt`, parked 주문이면 사람에게 넘긴 PR `humanPr`)가 같은 일을 한다. 접수와 `hasSourceRef`가 `removedAtOf`와 `archivedAtOf`를 둘 다 본다. 하위 주문 상한(`MAX_SPAWN_PER_ORDER`)도 `parentOrderId`로 보관한 하위 주문을 센다.

`archivedOrders`도 늘기만 한다. 한 줄이 100바이트쯤이라 1년에 주문 1.5만 개가 쌓여도 1.5MB라 지금은 그대로 둔다.

### 운영 파일 정리

| 파일                   | 보관할 때                                                                       |
| ---------------------- | ------------------------------------------------------------------------------- |
| `prompts/<워커 id>.md` | 그 주문의 워커 것을 지운다(열린 질문 4)                                         |
| `handoffs/`            | 주문이 아니라 컨덕터 세션에 붙는다. 같은 기간이 지난 파일을 지운다(열린 질문 4) |
| `inbox/failed/`        | 그대로 둔다. 사람이 볼 자리다                                                   |
| `snapshot.json`        | `base.json`과 별개다. 보관한 주문이 빠지므로 저절로 작아진다                    |

## 열린 질문

사람이 정할 값이다. 괄호 안은 제안 값이고 2026-11-22에 다섯 개 모두 제안 값으로 정했다. 구현은 아래 순서대로 별도 PR로 낸다.

1. **며칠 뒤에 옮길까.** 끝난 시각(`updatedAt`) 기준 N일. (14일. `order show`로 최근 2주 결과는 바로 보고 그보다 오래된 건 보관소에서 찾는다)
2. **상태별로 어떻게 다룰까.**
   - `parked`(사람이 넘겨받은 뒤 오래 안 움직인 주문): PR이 아직 열려 있을 수 있다. (보관하되 `archivedOrders`에 `humanPr`를 남겨 PR 감시가 그 PR로 주문을 새로 만들지 않게 한다. 보관 대상에서 빼는 안도 있었지만 이 안으로 정했다)
   - `human-owned`: 끝 상태가 아니라 대상이 아니다.
   - 열린 gate가 남은 채 끝난 주문: (옮기지 않는다. 사람이 gate를 처리하거나 `order remove`처럼 거절한다. 보관 결과의 `blocked`에 이유가 나오고 tick 보고는 개수와 앞쪽 id를 경고로 싣는다)
   - 멈춘 워커가 남은 주문: (옮기지 않는다. `order remove`와 같은 이유다)
   - `order remove`로 지운 주문: 이벤트가 로그에 남아 있다. (지운 시각 기준 같은 기간 뒤 이벤트를 보관소로 옮기고 `removedOrders` 기록은 그대로 둔다) 구현에서는 그 기록에 옮긴 달(`archived`)을 보탰다. 모아 둔 이벤트가 없으면 달만 적고 한 번 옮긴 주문은 다시 옮기지 않는다.
3. **보관소를 압축할까, 언제 지울까.** (주문 디렉토리는 그대로 두고 달이 끝나고 한 달 지난 `archive/YYYY-MM/`을 `.tar.gz`로 묶는다. 지우기는 자동으로 하지 않고 `gestalt conductor archive prune --before YYYY-MM`으로 사람이 부른다)
4. **`prompts/`와 `handoffs/`.** (`prompts/`는 보관할 때 지운다. 워커 첫 지시라 결과를 읽는 데 필요 없고 주문 설명과 스킬 체인은 `order.json`에 남는다. `handoffs/`는 1번과 같은 기간이 지나면 지운다)
5. **tick이 자동으로 돌릴까.** (하루 한 번 자동. 끄는 설정 `archive.enabled`를 둔다)

## 순서

1. `base.json`과 segment 재생. 보관 없이 "떼어 내고 base.json에 반영하기"만 넣고 재생 결과가 같은지 확인한다. (0.153.0)
2. 주문 보관과 `archivedOrders`, `archive` 명령. 1, 2번 결정을 반영한다. 반영할 때 이벤트를 주문별로 `order-logs/`에 옮겨 두고 보관할 때 거기서 모은다. segment는 다음 반영 때 지워지므로 보관할 때 segment에서 고르면 앞쪽 이벤트가 빠진다.
3. 운영 파일 정리(3, 4번 결정)와 tick 자동 실행(5번 결정). `prompts/`와 `activity/`는 워커가 상태에서 빠지고 하루 지난 파일을 지운다. 보관하는 순간에는 워커가 아직 상태에 남아 있으므로 다음 보관 때 지운다. 그 전에 워커 요약을 보관소 `workers/`로 복사해 둔다.
4. 뷰어가 머지된 뒤 뷰어가 보관소를 읽게 한다.
