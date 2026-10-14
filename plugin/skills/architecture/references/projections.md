```json
{
  "id": "checkout", "shape": "sequence", "title": "결제 승인 순서",
  "question": "앱에서 결제를 누르면 누가 무엇을 어떤 순서로 주고받나요?",
  "participants": ["app", "api", "pg"],
  "blocks": [{ "id": "b-result", "kind": "alt", "label": "승인 결과" }],
  "messages": [
    { "id": "m1", "from": "app", "to": "api", "label": "POST /orders/pay", "edge": "e-app-api", "evidence": [], "lineStyle": "solid" },
    { "id": "m2", "from": "pg", "to": "api", "label": "승인됨", "edge": "e-api-pg", "evidence": [], "lineStyle": "solid", "reply": true, "block": "b-result", "branch": "승인" }
  ],
  "phases": [
    { "id": "p-pay", "label": "결제 요청", "from": "m1", "to": "m1" },
    { "id": "p-result", "label": "승인 결과 받기", "from": "m2", "to": "m2" }
  ]
}
```

- `id`는 소문자, 숫자, 하이픈만 쓴다. 저장 파일 이름이 된다. 메시지 id는 모든 질문별 그림을 통틀어 겹치지 않게 짓는다.
- `title`과 `question`, 메시지 `label`은 [페이지 글](../SKILL.md#페이지-글)이다. `question`에는 사용자가 물은 문장을 그대로 옮긴다.
- **메시지마다 지도의 엣지를 `edge`로 가리킨다.** 그 엣지의 근거가 메시지 근거로 따라오므로 `evidence`를 비워도 된다. 엣지는 메시지의 두 끝을 이어야 하고 방향은 상관없다. 응답처럼 엣지와 거꾸로 가는 메시지도 같은 엣지를 가리킨다.
- 엣지로 안 잡히는 일(같은 노드 안의 검증, 문서에만 적힌 단계)은 `edge` 없이 자기 `evidence`를 단다. 자기 호출은 `from`과 `to`를 같게 쓴다.
- 근거가 하나도 없는 메시지는 그려지지 않고 `auto:message:<id>` 질문이 된다. 메시지를 지어내 채우지 말고 Step 7로 넘긴다.
- **sequence**: `participants`로 세로줄 순서를 정한다. 적으면 메시지 끝이 전부 여기 있어야 한다. 묶음은 `blocks`에 두고 메시지 `block`으로 건다. `alt`는 경우에 따라 하나만 도는 묶음, `opt`는 조건이 맞을 때만 도는 묶음, `loop`는 되풀이, `par`는 동시에 도는 묶음이다. `alt` 안의 경우 이름은 `branch`에 적는다. 한 묶음의 메시지는 붙여서 적는다.
- **sequence 구간**: `phases`는 순서도를 단계로 나눈다. 그림 위 보기 전환의 **단계별 카드**와 **따라가기**가 이 구간대로 카드를 나누고 띠를 깐다. 구간 하나는 `{ id, label, from, to }`이고 `from`과 `to`는 이 그림의 메시지 id다. 두 메시지 다 그 구간에 든다.
  - `label`은 사람이 읽는 단계 이름이다. 노드 id나 도구 이름(`ges_interview`) 말고 "요구사항 인터뷰", "스펙 만들기"처럼 그 구간에서 무슨 일이 벌어지는지를 쓴다. [페이지 글](../SKILL.md#페이지-글) 규칙을 따른다.
  - 첫 메시지부터 마지막 메시지까지 빈틈도 겹침도 없이 메시지 순서대로 적는다. 배열 순서도 메시지 순서와 같아야 하고 한 메시지는 한 구간에만 든다. 구간 경계가 묶음 한가운데를 지나는 건 괜찮다.
  - 안 적으면 render가 알아서 자른다. 맨 위 참여자가 지금 구간에서 처음 만나는 대상을 부르는 자리에서 새 구간이 열리고 구간 이름은 그 대상의 표시 이름이다. 그래서 모든 호출이 한 진입점을 거치는 흐름은 구간 하나로 뭉친다. 세션 모델이나 스킬 하나가 모든 호출을 내보내는 하네스 순서도가 그렇다. 같은 대상을 여러 번 오가는 흐름은 같은 이름 구간이 되풀이된다. 이런 흐름과 참여자가 많은 순서도에는 `phases`를 적는다.
- **dataflow**: `messages`만 쓴다. 데이터가 한 노드에서 다른 노드로 옮겨 가는 것 하나가 메시지 하나다. `blocks`와 메시지의 `reply`, `block`, `branch`는 쓰지 않는다.
- **compare**: `messages`는 빈 배열로 두고 `sides`에 견줄 두 묶음을 적는다. `{ id, label, nodes[] }` 둘이고 id는 달라야 한다. 그림은 "첫 묶음에만", "둘 다", "둘째 묶음에만" 세 열로 선다.
- **lifecycle**: `messages`는 빈 배열로 두고 `flow`에 `flows`의 흐름 id 하나를 적는다. `participants`, `blocks`, `phases`, `sides`는 쓰지 않는다. 흐름 단계의 `state`를 상태 하나씩으로 모아 다시 그린 그림이라 새로 적을 사실은 없다.

  ```json
  { "id": "queue-life", "shape": "lifecycle", "title": "줄서기 상태",
    "question": "줄서기 항목은 어떤 상태를 거치나요?", "messages": [], "flow": "queue" }
  ```

  - 상태 카드는 세 띠에 선다. `main` 길의 상태는 맨 위 **진행 단계**, `side` 길에서만 닿는 상태는 가운데 **대기와 복구**, 끝 단계(`terminal: true`)의 상태는 맨 아래 **끝 상태**다. 정상 흐름이 끝나는 상태(`main`에 있고 `outcome`이 없거나 `done`)는 진행 단계 띠 끝에 남는다.
  - `state`가 없는 단계는 그리지 않고 지나간다. 그 단계를 거치는 전이는 앞뒤 상태를 잇는 선 하나로 합쳐진다. 그래서 끝 단계에도 `state`를 달아야 끝 상태 카드가 선다. 같은 상태 안에서 앞으로만 가는 전이는 빠지고 같은 상태로 되돌아오는 전이만 자기 고리로 남는다.
  - 선 글자는 합쳐진 전이마다 `condition`과 `trigger`를, 둘 다 없으면 `label`을 꺼내 쉼표로 잇는다. 하나도 없으면 도착 단계 이름을 흐린 기울임꼴로 빌려 쓴다. 되돌아가는 선에는 ↩가 붙는다.
  - 끝 단계에 `outcome`을 달면 끝 상태 카드에 배지가 붙는다. `done`은 완료, `cancel`은 취소, `fail`은 실패다. 안 달면 "끝"이다. `outcome`은 끝 단계에만 단다.
  - 한 장에 읽히는 양은 진행 단계 5개, 대기와 복구 2개, 끝 상태 2개, 상태 전체 9개, 전이 10개다. 넘어도 그리지만 validate가 `LIFECYCLE_OVER_BUDGET` 경고를 낸다. 세부 상태를 합치거나 흐름을 나눈다.
- **blueprint**: `messages`는 빈 배열로 두고 `flow`에 `flows`의 흐름 id 하나를 적는다. `participants`, `blocks`, `phases`, `sides`는 쓰지 않는다. 흐름 단계와 지도에 이미 적은 사실을 층으로 다시 나눈 그림이라 새로 적을 사실은 없다.

  ```json
  { "id": "queue-bp", "shape": "blueprint", "title": "줄서기 블루프린트",
    "question": "손님이 줄을 서는 동안 뒤에서는 무엇이 일하나요?", "messages": [], "flow": "queue" }
  ```

  - 열은 `main` 길의 단계다. 흐름 그림에서 같은 열에 서는 단계는 한 열로 묶이고 갈림길(`kind: "decision"`)과 `side` 길 단계는 빠진다. 열 머리는 그 열 단계의 `state` 이름이고 없으면 첫 단계 이름이다.
  - 층은 위에서 아래로 **고객 행동**, **프론트스테이지**, **가시선**, **백스테이지**, **지원**이다. 흐름의 첫 `person` 행위자가 고객이라 그 단계는 고객 행동에 선다. 다른 사람의 단계는 프론트스테이지, 시스템과 에이전트의 단계는 백스테이지다.
  - 단계 `refs`가 칸을 채운다. 화면과 스킬은 프론트스테이지, API와 MCP 도구는 백스테이지에 선다. 프론트스테이지 화면과 스킬이 `calls`로 부르는 API도 백스테이지에 더한다. 백스테이지 API를 처리하는 모듈이 닿는 테이블, 저장소, 외부 서비스, 큐, 잡은 지원에 선다.
  - 근거 없는 엣지는 따라가지 않는다. 연결이 안 보이는 칸은 지어내지 않고 `—`로 비운다. 칸을 채우고 싶으면 단계에 `refs`를 달거나 지도에 근거와 함께 엣지를 넣는다. 층 사이에 선은 긋지 않는다.
  - 칸 하나에 카드는 셋까지다. 나머지는 "+N"으로 접고 이름은 툴팁에 있다. 문서로만 닿은 카드는 테두리가 점선이다.
  - 한 장에 읽히는 양은 단계 6열이다. 넘어도 그리지만 validate가 `BLUEPRINT_OVER_BUDGET` 경고를 낸다. 같은 화면에서 이어지는 단계를 합치거나 흐름을 나눈다.
- **er**: `messages`는 빈 배열로 두고 `participants`에 그릴 `db_table` id를 적는다. `blocks`, `phases`, `sides`, `flow`는 쓰지 않는다. 선은 지도 엣지가 아니라 테이블 노드 `columns`의 `references`에서 나온다. 그래서 그림을 얹기 전에 테이블마다 `columns`부터 채운다.

  ```json
  { "id": "order-schema", "shape": "er", "title": "주문 테이블 구조",
    "question": "주문을 지우면 어떤 행이 같이 지워지나요?",
    "participants": ["tbl:users", "tbl:orders", "tbl:order-items"], "messages": [] }
  ```

  ```json
  { "id": "tbl:orders", "kind": "db_table", "label": "orders", "parent": "ds:main", "repo": "api",
    "evidence": [{ "type": "code", "location": "api:db/migrations/003_orders.sql:1", "visibility": "public" }],
    "columns": [
      { "name": "id", "type": "uuid", "pk": true },
      { "name": "user_id", "type": "uuid",
        "references": { "table": "tbl:users", "column": "id", "onDelete": "CASCADE" },
        "evidence": [{ "type": "code", "location": "api:db/migrations/003_orders.sql:4", "visibility": "public" }] }
    ] }
  ```

  - 컬럼은 마이그레이션 파일, ORM 엔티티, 스키마 덤프에서 읽는다. 여러 곳이 다르면 마이그레이션을 따른다. 실제로 DB에 들어간 순서가 거기 있어서다.
  - 테이블 상자에는 컬럼이 행 하나씩 서고 PK, FK, UQ, NULL 배지가 붙는다. 테이블 하나에 8행까지 보이고 나머지는 "컬럼 N개 더" 한 행으로 접는다. PK와 선이 붙는 컬럼이 먼저 남는다.
  - 외래 키 선은 출발 컬럼 행에서 대상 컬럼 행으로 간다. 컬럼 `evidence`에 code나 spec이 있으면 실선, 문서 근거뿐이면 점선이다. 근거가 없으면 선을 긋지 않고 배지가 `FK?`로 서며 `auto:fk:<테이블 id>:<컬럼>` 질문이 생긴다. 이름이 `_id`로 끝난다고 짐작해 잇지 않는다.
  - `onDelete`는 근거가 있는 외래 키에서만 선 위에 `ON DELETE …`로 보인다. 몇 대 몇인지는 그리지 않는다. 컬럼 정의만으로는 확실히 알 수 없어서다.
  - `participants`에 없는 테이블을 가리키는 외래 키는 선 없이 FK 배지만 남는다. 그 테이블이 질문에 필요하면 `participants`에 더한다.
  - 한 장에 읽히는 양은 테이블 5개, 한 테이블의 컬럼 8개, 외래 키 선 6개다. 넘어도 그리지만 validate가 `ER_OVER_BUDGET` 경고를 낸다. 질문에 걸린 테이블만 남기거나 그림을 나눈다.
- **흐름 그림, lifecycle, sequence 고르기**: 셋 다 "어떻게 진행되나"에 답하지만 보는 축이 다르다.
  - "누가 무엇을 하나"면 흐름 그림이다. 행위자 줄마다 단계가 놓여 사람과 시스템이 일을 주고받는 자리가 보인다. `flows`만 쓰면 된다.
  - "이 대상이 어떤 상태를 거쳐 어디서 끝나나"면 lifecycle이다. 행위자를 걷고 상태만 남겨 대기, 재시도, 취소, 실패가 정상 흐름과 어떻게 갈리는지 한눈에 보인다. 상태가 셋 이하면 흐름 그림 위쪽 상태 구간으로 충분하니 얹지 않는다.
  - "어느 모듈이 무엇을 어떤 순서로 부르나"면 sequence다. 상태가 아니라 호출과 응답이 줄거리다.
- **blueprint, dataflow, sequence 고르기**: "고객이 한 걸음 갈 때 화면 뒤에서 무엇이 일하나"면 blueprint다. 고객 단계가 열이라 단계마다 보이는 쪽과 안 보이는 쪽이 함께 읽힌다. 데이터가 어디서 와서 어디로 가는지면 dataflow이고 누가 누구를 어떤 순서로 부르는지면 sequence다. 둘은 선을 따라 읽는 그림이고 blueprint는 칸을 읽는 그림이다.
- **er, dataflow 고르기**: "어떤 테이블이 어떤 컬럼으로 서로를 가리키나", "이걸 지우면 무엇이 같이 지워지나"면 er이다. 테이블 안쪽 구조와 외래 키가 줄거리다. "데이터가 어느 모듈을 거쳐 어느 테이블에 쌓이나"면 dataflow다. 코드가 테이블을 읽고 쓰는 길을 따라가는 그림이라 컬럼은 안 나온다.
- 질문 하나에 그림 하나다. 질문이 여럿이면 그림도 여럿 단다.
- 하네스 레포는 묻지 않아도 진입 경로마다 순서도를 하나씩 얹는다. 자세한 건 [Step 3.5](../SKILL.md#step-35--도메인-흐름)의 하네스 흐름 항목에 있다.
