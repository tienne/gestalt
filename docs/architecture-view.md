# Architecture View

코드와 맥락 소스에서 찾은 근거로 아키텍처 그림을 그린다. 그림에 그은 실선은 전부 "코드나 스펙에서 확인했다"는 주장이다. 근거를 못 찾은 연결은 점선이나 미해결 질문으로 남는다. 빈칸이 많은 그림이 틀린 그림보다 낫다는 게 출발점이다.

뷰는 둘이다.

| 뷰 | 흐름 |
|---|---|
| `screen-chain` | 화면 → 백엔드 엔드포인트 → 백엔드 앱 모듈 → 외부 서비스와 DB 테이블 |
| `deploy-path` | 배포 단위별 트리거 → 빌드 → 산출물 → 배포 대상 |

`/architecture` 스킬이 이 흐름을 드라이빙하고 `ges_architecture` MCP 도구가 검증과 렌더를 맡는다. 스킬 절차는 [`plugin/skills/architecture/SKILL.md`](../plugin/skills/architecture/SKILL.md)에 있다.

저장소: `.gestalt/architecture/` (뷰별 IR JSON과 HTML 두 개)

---

## 누가 무엇을 하나

`ges_architecture`는 Passthrough 도구다. 서버는 LLM을 부르지 않는다.

| 맡는 쪽 | 하는 일 |
|---|---|
| 세션 (Claude Code 등) | 맥락 소스를 고르고 코드를 탐색한다. 근거 달린 IR을 JSON으로 쓴다. 미해결 질문을 사용자에게 묻는다 |
| 서버 (`ges_architecture`) | IR을 스키마로 검증하고 근거 파일과 줄을 확인한다. 이전 실행과 병합해 노드 id를 물려준다. 좌표를 계산해 HTML을 쓴다 |

탐색은 세션 모델의 판단이 필요한 일이라 세션에 둔다. 검증과 렌더는 같은 입력에 같은 결과가 나와야 하는 일이라 서버에 둔다. 세션이 그린 그림을 서버가 다시 보지 않으면 근거 없는 실선이 그대로 나가게 된다.

---

## IR 구조

IR(중간 표현)은 세션이 서버에 넘기는 JSON이다. 스키마는 [`schemas/architecture-ir.schema.json`](../schemas/architecture-ir.schema.json)에 있고 `start` 응답의 `schemaPath`가 이 파일의 절대 경로를 준다. 서버는 같은 구조를 zod로 다시 파싱한다 (`src/architecture/ir-schema.ts`).

| 필드 | 내용 |
|---|---|
| `schemaVersion` | `"1.0.0"` 고정 |
| `view` | `screen-chain` 또는 `deploy-path` |
| `repos` | `{ id, name, root, remote? }`. `root`는 로컬 경로다. 상대 경로면 `repoRoot` 기준으로 푼다 |
| `nodes` | `{ id, kind, label, repo, parent?, displayName?, displayNameInferred?, description?, evidence[] }`. `parent`는 이 노드를 담는 노드의 id다. [포함 관계](#포함-관계)에서 설명한다. 이름 두 필드는 [표시 이름](#표시-이름)에서 설명한다 |
| `edges` | `{ id, from, to, kind, evidence[], lineStyle }`. `lineStyle`은 `solid` 또는 `dashed` |
| `unresolved` | `{ id, subject: { nodeId?, edgeId? }, question, answer? }` |
| `sourcesUsed` | 이번 실행이 간 본 맥락 소스. `{ via, identifier, readOnly, probeHit, visibility }` |
| `generatedAt` | 생성 시각 문자열. HTML에 그대로 찍힌다 |

근거(`evidence`) 하나는 `{ type, location, visibility, updatedAt?, excerpt? }`다.

짧은 예시다. 레포 이름과 경로는 가짜다.

```json
{
  "schemaVersion": "1.0.0",
  "view": "screen-chain",
  "repos": [
    { "id": "acme-web", "name": "acme-web", "root": "../acme-web" },
    { "id": "acme-api", "name": "acme-api", "root": "../acme-api" }
  ],
  "nodes": [
    {
      "id": "s-orders",
      "kind": "screen",
      "label": "/orders",
      "repo": "acme-web",
      "evidence": [{ "type": "code", "location": "acme-web:src/routes.tsx:42", "visibility": "public" }]
    },
    {
      "id": "e-orders-get",
      "kind": "endpoint",
      "label": "GET /api/v1/orders/{}",
      "repo": "acme-api",
      "evidence": [{ "type": "code", "location": "acme-api:src/orders/controller.ts:18", "visibility": "public" }]
    }
  ],
  "edges": [
    {
      "id": "c-1",
      "from": "s-orders",
      "to": "e-orders-get",
      "kind": "calls",
      "lineStyle": "solid",
      "evidence": [
        {
          "type": "code",
          "location": "acme-web:src/pages/orders.tsx:27",
          "visibility": "public",
          "excerpt": "api.get(`/api/v1/orders/${id}`)"
        }
      ]
    }
  ],
  "unresolved": [],
  "sourcesUsed": [
    { "via": "repo", "identifier": "CLAUDE.md", "readOnly": true, "probeHit": true, "visibility": "public" }
  ],
  "generatedAt": "2026-10-01T09:00:00Z"
}
```

### 노드 kind

| kind | 뷰 | 뜻 |
|---|---|---|
| `service` | screen-chain | 사용자가 쓰는 FE 앱이나 제품 |
| `feature` | screen-chain | 서비스 안의 기능영역. 페이지보다 한 단계 위인 제품 단위 (예: 등록모드, 대시보드, 설정) |
| `screen` | screen-chain | 사용자가 보는 화면이나 페이지 |
| `gateway` | screen-chain | 요청을 받아 다른 서버로 넘기는 서버 |
| `endpoint` | screen-chain | 백엔드 HTTP 엔드포인트. label은 `METHOD /정규화 경로` 꼴 |
| `app_module` | screen-chain | 엔드포인트를 처리하는 백엔드 모듈이나 컨트롤러 |
| `external_service` | screen-chain | 모듈이 부르는 다른 서비스, 외부 API, 메시지 브로커 |
| `db_table` | screen-chain | 모듈이 읽고 쓰는 테이블 |
| `workflow` | deploy-path | 배포를 시작하는 CI 워크플로와 그 트리거 |
| `build` | deploy-path | 빌드 잡이나 스텝 |
| `artifact` | deploy-path | 이미지, 번들, 패키지 같은 빌드 산출물 |
| `deploy_target` | deploy-path | 산출물이 올라가는 클러스터, CDN, 런타임 |

레이아웃은 kind마다 열을 정해 왼쪽부터 놓는다. screen-chain은 `service`, `feature`, `screen`이 한 열, 그다음 `gateway`, `endpoint`, `app_module`이고 `external_service`와 `db_table`이 마지막 한 열이다. deploy-path는 `workflow`, `build`, `artifact`, `deploy_target` 순이다.

### 엣지 kind

| kind | from → to | 근거가 되는 줄 |
|---|---|---|
| `navigates` | screen → screen | `navigate()`, `Link`, `history.push` 줄 |
| `calls` | screen → endpoint | 화면 쪽 API 호출 줄 |
| `calls` | external_service → gateway | 클라이언트 base URL이 게이트웨이 호스트를 가리키는 줄 |
| `routes` | gateway → endpoint, gateway, app_module | 게이트웨이 라우트 설정의 `Path`나 `uri` 줄 |
| `handles` | endpoint → app_module | 라우트 매핑 어노테이션이나 라우터 등록 줄 |
| `uses` | app_module → external_service | 외부 클라이언트 호출 줄 |
| `reads_writes` | app_module → db_table | 쿼리나 엔티티 매핑 줄 |
| `triggers` | workflow → build | 워크플로의 트리거와 잡 정의 줄 |
| `builds` | build → artifact | 빌드 명령 줄 |
| `produces` | build → artifact | 산출물을 내보내는 줄 (이미지 push, 업로드) |
| `deploys_to` | artifact → deploy_target | 배포 명령이나 매니페스트 줄 |

`routes`는 게이트웨이가 요청을 어디로 넘기는지다. 게이트웨이가 여러 단이면 앞 게이트웨이에서 뒤 게이트웨이로 `routes`를 긋고 엔드포인트로 가는 `routes`는 마지막 게이트웨이에만 단다. `gateway → app_module`은 엔드포인트를 노드로 펼치지 않은 클라이언트 호출 사슬에 쓴다.

### 포함 관계

노드의 `parent`는 이 노드를 담는 노드의 id다. 엣지가 아니라서 선으로 그리지 않는다. [드릴다운](#드릴다운) 레벨을 나누는 데만 쓴다.

| kind | parent로 가리킬 수 있는 kind |
|---|---|
| `screen` | `feature`, `service` |
| `feature` | `service` |
| 그 밖 | parent를 가질 수 없다 |

parent 노드가 근거가 없어 그려지지 않으면 자식은 parent가 없는 것으로 친다.

### 표시 이름

`label`은 기술 이름이다. 모듈 이름이나 레포 이름처럼 코드에 있는 그대로 쓴다. 사람이 그 서버를 부르는 이름은 따로 있는 경우가 많아서 `displayName`에 담는다.

| 필드 | 뜻 |
|---|---|
| `displayName` | 사람이 부르는 이름. 예: label이 `acme-order-api`면 `주문 서버` |
| `displayNameInferred` | `true`면 문서에 그대로 있던 이름이 아니라 근거 문장을 줄여 지은 이름이다. `displayName` 없이 쓰면 `IR_PARSE_ERROR`다 |

- 박스는 첫 줄에 `displayName`을 굵게, 둘째 줄에 `label`을 작게 쓴다. `displayName`이 없으면 `label` 한 줄이다.
- 추정 이름이면 박스에 "추정" 배지가 붙고 패널 제목 아래에 지은 이름이라는 문구가 뜬다.
- 패널 제목, 드릴다운 레벨 제목, 빵부스러기, 두 노드 선택 표도 `displayName`을 먼저 쓴다.
- `.shared.html`에도 이름은 그대로 보인다. 가리는 건 근거뿐이다.
- 병합 키가 아니다. `displayName`을 바꾸거나 새로 달아도 노드 id는 유지된다. [재실행과 노드 id](#재실행과-노드-id)를 본다.

---

## 근거와 선 모양

근거는 네 종류다. 선 모양은 근거 종류로 정해진다.

| type | location | 선 |
|---|---|---|
| `code` | `<repoId>:<relPath>:<line>`. `repoId`는 `repos[].id`, `relPath`는 레포 루트 기준 상대 경로 | 실선 |
| `spec` | OpenAPI, proto 같은 API 명세 안의 정의 위치 | 실선 |
| `doc` | 문서 링크나 경로. `updatedAt`에 수정일 | 점선 |
| `user` | 질문 id와 답한 날짜. 답 원문은 질문의 `answer`에 둔다 | 점선 |

엣지에 `code`나 `spec` 근거가 하나라도 있으면 실선이고 없으면 점선이다. 서버는 IR에 적힌 `lineStyle`을 믿지 않고 근거로 다시 계산해 덮어쓴다. 사용자가 "그렇다"고 답한 연결도 점선이다. 코드로 확인했다는 뜻이 아니어서다.

---

## 검증 규칙

`validate`와 `render`는 같은 검증을 탄다 (`src/architecture/validator.ts`). 아래 일곱은 IR 전체를 거부한다.

| 에러 코드 | 언제 |
|---|---|
| `SOLID_EDGE_WITHOUT_EVIDENCE` | `lineStyle: "solid"`인데 `code`나 `spec` 근거가 없다. 근거가 0개인 실선도, `doc`이나 `user` 근거만 있는 실선도 여기 걸린다 |
| `CODE_EVIDENCE_NOT_FOUND` | `code` 근거의 위치가 `<repoId>:<relPath>:<line>` 꼴이 아니거나, `repoId`가 `repos`에 없거나, 경로가 절대 경로이거나 레포 루트 밖을 가리키거나, 파일이 없거나, 줄 번호가 파일 범위 밖이다 |
| `PRIVATE_EXCERPT_PRESENT` | `visibility: "private"` 근거에 `excerpt`가 들어 있다 |
| `DANGLING_EDGE` | 엣지의 `from`이나 `to`가 `nodes`에 없다 |
| `PARENT_NOT_FOUND` | `parent`가 가리키는 노드가 `nodes`에 없다 |
| `PARENT_CYCLE` | `parent`를 따라가면 자기 자신으로 돌아온다 |
| `INVALID_PARENT_KIND` | [포함 관계](#포함-관계) 규칙에 어긋난다. parent를 가질 수 없는 kind에 달았거나 담을 수 없는 kind를 가리킨다 |

`checkFiles: false`를 넘기면 `CODE_EVIDENCE_NOT_FOUND`의 파일 존재와 줄 범위 확인을 건너뛴다. 기본값은 `true`다.

근거 없는 실선을 미해결로 조용히 돌리지 않고 거부하는 이유가 있다. 실선은 확인했다는 주장이라, 근거 없이 나온 실선 하나가 그림 전체를 못 믿게 만든다.

반대로 아래 경우는 에러가 아니다. 그리기 대상에서 빠지고 미해결 질문이 자동으로 생긴다 (`autoUnresolved`).

- 근거가 0개인 점선 엣지. 질문 id는 `auto:edge:<엣지 id>`다.
- 근거가 0개인 노드. 질문 id는 `auto:node:<노드 id>`다.
- 근거가 있어도 양 끝 노드 중 하나가 그리기 대상에서 빠진 엣지. 이 엣지에는 질문을 따로 만들지 않는다.

자동 질문은 노드를 `displayName`(없으면 label)으로 부른다. 문장은 아래 꼴이다.

- 노드: `"X"가 어디에 정의돼 있는지 못 찾았어요. 위치를 알려주실 수 있나요?`
- 엣지: `"A"에서 "B"로 가는 연결을 코드나 문서에서 확인하지 못했어요. 실제로 이어져 있나요?`

같은 대상을 묻는 질문이 IR의 `unresolved`에 이미 있으면 자동 질문을 또 만들지 않는다.

이 밖에 `prepareIr`가 앞에서 거르는 에러가 셋 있다. `ir`이나 액션별 필수 입력이 빠지면 `MISSING_INPUT`, 스키마 위반이면 `IR_PARSE_ERROR`, `view` 인자와 `ir.view`가 다르면 `VIEW_MISMATCH`다.

실패 응답은 모두 같은 꼴이다.

```json
{
  "ok": false,
  "errors": [{ "code": "SOLID_EDGE_WITHOUT_EVIDENCE", "message": "...", "edgeId": "c-1" }]
}
```

`errors[]` 항목에는 해당하면 `nodeId`, `edgeId`, `evidenceIndex`가 붙는다.

---

## 공개 범위와 shared 렌더

근거와 맥락 소스마다 `visibility`가 붙는다.

| 출처 | visibility | excerpt |
|---|---|---|
| 레포에 커밋된 파일 (코드, `CLAUDE.md`, `AGENTS.md`, `docs/`, `.gestalt/memory.json`) | `public` | 실어도 된다 |
| 홈 아래 파일 (`~/.claude/CLAUDE.md`, `~/.claude/projects/*/memory/`) | `private` | 금지 |
| KB 검색 결과, MCP 도구 응답, 스킬 조회 결과 | `private` | 금지 |
| 사용자 답 | `private` | 금지 |

private 근거의 원문은 세 겹으로 막는다.

1. `validate`가 private 근거의 `excerpt`를 `PRIVATE_EXCERPT_PRESENT`로 거부한다.
2. 저장하는 IR에서 private 근거의 `excerpt`를 지운다 (`stripPrivateExcerpts`).
3. 공유용 HTML(`.shared.html`)은 private 근거의 `location`까지 빼고 `type`과 `visibility`만 남긴다 (`redactForSharing`). 패널에는 출처 종류만 보인다.

두 HTML 모두 페이지가 쓰는 필드만 싣는다. `repos`는 `id`와 `name`만 들어가고 `root`와 `remote`는 빠진다. `sourcesUsed`도 HTML에 들어가지 않는다. 그래서 로컬 경로나 사용한 도구 이름이 공유본으로 새지 않는다.

> ⚠️ 다른 사람에게 넘길 때는 `.shared.html`만 넘긴다. `.html`은 private 근거의 위치가 그대로 보이는 본인용이다.

---

## 결정적 렌더

같은 IR을 넣으면 같은 바이트의 HTML이 나온다. 그림을 커밋하거나 diff로 비교할 수 있게 하려는 것이다.

- **좌표는 서버가 계산한다.** elkjs의 `layered` 알고리즘을 쓰고 방향은 오른쪽, `randomSeed`는 `1`로 고정한다. 노드 크기는 실제 폰트 측정 대신 글자 수로 잰다(한글 같은 전각 문자는 두 칸). 실행 환경의 폰트에 결과가 흔들리지 않게 하려는 것이다.
- **입력 순서를 지운다.** 노드와 엣지는 id로 정렬한 뒤 ELK에 넘기고 결과도 다시 id로 정렬한다. 정렬은 로캘을 타지 않는 코드 유닛 비교다. 좌표는 소수 둘째 자리에서 반올림한다.
- **JSON도 키를 정렬해 싣는다.** HTML 안의 IR 데이터는 키 순서를 고정해 직렬화한다.
- **외부 스크립트가 없다.** SVG와 패널 스크립트, 스타일이 HTML 한 파일 안에 다 들어 있다. 오프라인에서도 열린다.
- **시각을 새로 찍지 않는다.** HTML에 나오는 시각은 IR의 `generatedAt`뿐이다.

노드를 누르면 설명과 출처 목록이 패널에 뜬다. `http`나 `https`로 시작하는 근거 위치는 링크가 된다.

---

## 드릴다운

서비스 하나에 화면이 수십 개, 엔드포인트가 수백 개면 평면 그림 한 장은 캔버스가 수천 px로 커져 읽을 수 없다. 그래서 그린 `service` 노드가 하나라도 있으면 render가 레벨을 나눠 HTML 한 장에 담는다 (`src/architecture/drilldown.ts`의 `shouldDrillDown`, `computeDrilldown`). 서비스가 없으면 지금처럼 평면 그림이다. deploy-path에는 서비스가 없으니 늘 평면이다.

### 레벨

| 레벨 | id | 보이는 것 |
|---|---|---|
| 전체 | `root` | 서비스, 게이트웨이, 서버(앱 모듈)만. 엣지는 세부 엣지를 묶은 것이고 굵기와 숫자가 건수다 |
| 서비스 | `service:<id>` | 그 서비스의 기능영역과 서비스에 바로 단 화면, 거기서 닿는 게이트웨이와 서버. 화면 이동은 기능영역 사이 묶음 엣지가 된다 |
| 기능영역 | `feature:<id>` | 그 기능영역의 화면, 화면이 부르는 엔드포인트, 거쳐 가는 게이트웨이, 받는 모듈. 세부 엣지 그대로 |
| 서버 | `server:<id>` | 그 모듈이나 게이트웨이에 걸린 엔드포인트, 모듈이 읽고 쓰는 테이블, 쓰는 클라이언트와 그 클라이언트가 부르는 모듈 |

### 묶음 엣지의 주인

전체 레벨의 묶음 엣지는 세부 노드마다 전체 레벨의 어느 노드에 속하는지(주인)를 정한 뒤 만든다.

| 세부 노드 | 주인 |
|---|---|
| `screen`, `feature` | 조상 중 `service` |
| `endpoint` | `handles`로 받는 `app_module`. 여럿이면 각각 |
| `external_service` (클라이언트) | 그 클라이언트를 `uses`하는 `app_module` |
| `service`, `gateway`, `app_module` | 자기 자신 |
| `db_table` | 전체 레벨에 안 나온다 |

화면이 부르는 엔드포인트에 게이트웨이 사슬이 있으면 서비스 → 맨 앞 게이트웨이 → … → 맨 뒤 게이트웨이 → 모듈로 묶인다. 사슬은 그 엔드포인트로 `routes`하는 게이트웨이에서 `gateway → gateway` `routes`를 거꾸로 따라 올라가, 들어오는 `routes`가 없는 게이트웨이까지다. 게이트웨이가 없는 엔드포인트는 서비스 → 모듈로 바로 묶인다. 모듈 A가 쓰는 클라이언트가 모듈 B를 부르면 A → B다. 클라이언트가 게이트웨이를 부르면 A → 게이트웨이 → B다.

묶음 엣지마다 건수와 멤버 세부 엣지 id 목록이 따라간다. 멤버 경로에 `doc`이나 `user` 근거만 있는 엣지가 하나라도 끼면 묶음 전체를 점선으로 그린다. 확인 안 된 고리가 낀 묶음을 실선으로 그리면 묶음 전체를 확인한 것처럼 읽히기 때문이다.

### 레인

그림은 세로 띠(레인)로 나뉜다. 레인 하나가 레이어 하나이고 왼쪽에서 오른쪽으로 요청이 흐르는 순서로 놓인다. 레인 위쪽에 제목과 그 레인의 카드 수가 붙는다. 카드가 없는 레인은 아예 그리지 않는다. 드릴다운이 아닌 평면 그림도 같은 레인을 쓴다.

| 그림 | 왼쪽부터 |
|---|---|
| 전체 레벨 | 앱 → 게이트웨이 → 서버 → 외부 서비스 |
| 서비스 레벨 | 기능 영역 → 게이트웨이 → 서버 |
| 기능영역 레벨 | 화면 → 게이트웨이 → API → 서버 |
| 서버 레벨 | API → 서버 → 클라이언트 → 외부 서비스 → DB |
| screen-chain 평면 | 화면 → 게이트웨이 → API → 서버 → 클라이언트 → DB |
| deploy-path | 트리거 → 빌드 → 산출물 → 배포 대상 |

- 전체 레벨의 **외부 서비스** 레인에는 서비스 쪽에서는 닿지 않고 서버에서 나가는 선으로만 닿는 게이트웨이와 서버가 선다.
- 서비스 레벨의 **기능 영역** 레인에는 기능영역과 서비스에 바로 단 화면이 함께 선다. 평면 그림에서는 서비스와 기능영역이 **화면** 레인에 선다.
- 서버 레벨의 **외부 서비스** 레인은 이 서버가 클라이언트로 부르는 쪽(다른 서버, 엔드포인트, 게이트웨이)이다. 테이블은 그보다 오른쪽 맨 끝 **DB** 레인에 모은다. 고른 노드가 게이트웨이면 게이트웨이 → API 순서다.

레인 제목은 카드 칩의 종류 이름과 같은 말을 쓴다 (`src/architecture/kind-text.ts`의 `LANE_TITLES`, `NODE_KIND_SHORT`).

### 카드와 위쪽 바

카드 맨 위에는 종류 칩이 붙는다. 칩은 종류별 아이콘과 짧은 이름(앱, 기능 영역, 화면, 게이트웨이, API, 서버, 클라이언트, DB, 트리거, 빌드, 산출물, 배포 대상)이다. 종류마다 색도 다르지만 색만으로 구분하지 않는다. 색을 못 가리는 사람도 칩 글자로 종류를 읽는다. 한 단계 안으로 들어갈 수 있는 카드에는 오른쪽에 `›`가 붙는다.

위쪽 바에는 왼쪽부터 제목, 빵부스러기(드릴다운일 때), 포커스 표시가 있고 오른쪽에 도구가 모여 있다.

| 도구 | 하는 일 | 키 |
|---|---|---|
| **포커스** | 고른 카드가 있을 때만 보인다. [포커스](#포커스) 화면으로 바꾼다 | `F` |
| 이름으로 찾기 | 지금 보이는 화면의 카드만 찾는다. 찾은 수가 옆에 나오고 Enter로 다음 카드, Shift+Enter로 앞 카드로 옮긴다 | `/` |
| 작게 보기, 크게 보기 | 가운데를 기준으로 줄이고 키운다. 사이에 배율이 나온다 | `-`, `+` |
| **맞춤** | 그림 전체를 화면에 맞춘다 | `0` |
| **범례** | 선 모양(실선, 점선, 묶음 선)과 이 그림에 나온 종류의 칩을 보여준다 | |
| **확인할 질문** | 미해결 질문 목록과 건수. 질문을 누르면 그 노드가 있는 레벨로 가서 카드를 고른다 | |
| 테마 | 밝은 화면과 어두운 화면을 바꾼다 | |

테마는 처음에 시스템 설정을 따른다. 토글로 바꾸면 그 값을 브라우저 `localStorage`에 남겨 다음에 열 때도 쓴다. 남긴 값이 없으면 시스템 설정이 바뀔 때 함께 바뀐다.

### 조작

- 노드를 누르면 오른쪽에 상세 패널이 열린다. 패널에는 종류와 레포, 이름, 설명, **출처** 목록이 있다. 들어갈 레벨이 있으면 **상세보기** 버튼이, 포커스할 수 있으면 **포커스** 버튼이 함께 뜬다. 더블클릭하면 상세보기를 누른 것처럼 바로 들어간다. 위쪽 빵부스러기로 위 레벨에 돌아간다.
- 전체 레벨에서 Shift나 ⌘를 누른 채 두 번째 노드를 누르면 두 노드 사이 경로를 경유지까지 펼친다. 화면 → 게이트웨이(사슬 순서) → 엔드포인트 → 모듈 → 클라이언트 → 게이트웨이 → 받는 모듈 → 테이블 순서의 열로 놓고 세부 엣지 표를 함께 보여준다. 경로가 없으면 "두 항목은 서로 이어져 있지 않아요."라고 나온다.
- 경로는 중간에 게이트웨이(몇 단이든)와 모듈 하나까지만 지난다. 출발이 모듈이면 중간 모듈 없이 게이트웨이만 지난다. 화면에서 모듈 하나를 지나 클라이언트로 다른 모듈에 닿는 데까지가 한 요청 흐름이다. 그보다 멀리 돌아가는 길까지 펼치면 두 노드와 상관없는 엔드포인트가 쏟아진다.
- 전체 레벨의 묶음 엣지를 누르면 두 노드를 고른 것과 같은 화면이 뜬다. 다른 레벨에서 묶음 엣지를 누르면 그 묶음의 세부 엣지만 보여준다.
- 지금 보는 화면은 주소 해시에 실린다. 전체는 `#/`, 레벨은 `#/level/<레벨 id>`, 두 노드 화면은 `#/pair/<노드 a>/<노드 b>`, 묶음 세부는 `#/bundle/<레벨 id>/<묶음 id>`, 포커스는 `#/focus/<레벨 id>/<노드 id>`이고 id는 `encodeURIComponent`로 감싼다. 그래서 브라우저 뒤로가기와 앞으로가기, 새로고침이 그 화면으로 돌아온다. 주소를 복사해 보내면 같은 HTML 파일을 가진 사람에게 같은 화면이 열린다. 모르는 주소면 기록을 남기지 않고 전체로 바꾼다. 평면 그림에는 레벨이 `root` 하나뿐이라 `#/`와 `#/focus/root/<노드 id>`만 쓴다.

레벨마다 좌표는 `computeGraphLayout`(`src/architecture/layout.ts`)이 따로 낸다. IR 노드가 아닌 일반 노드와 엣지 목록을 받으므로 묶음 엣지도 그대로 넣는다. 정렬은 전부 id 기준이라 [결정적 렌더](#결정적-렌더) 성질이 그대로 유지된다.

### 포커스

카드가 수십 장인 레벨에서 노드 하나와 이어진 것만 보고 싶을 때 쓴다. 고른 노드에서 화살표를 따라 내려가 닿는 노드 전부(하류)와 고른 노드로 들어오는 선을 거슬러 올라가 닿는 노드 전부(상류)를 남기고 나머지 카드를 숨긴다. 선은 위아래로 따라가며 밟은 것만 남는다.

하류로 내려갔다가 다시 상류로 꺾는 길은 타지 않는다. 화면 A에서 게이트웨이로 내려간 뒤 그 게이트웨이를 부르는 화면 B로 거슬러 올라가지 않는다는 뜻이다. 이 길까지 타면 같은 게이트웨이를 쓰는 다른 앱이 전부 딸려 와서 숨긴 의미가 없어진다. 계산은 `src/architecture/focus.ts`의 `focusSet`이다.

남은 카드는 레벨에 그려 둔 자리에서 가져온다 (`focusLayout`). x는 그대로 두고 같은 열 안에서 원래 위아래 순서대로 위에서부터 다시 쌓는다. 그래서 레인 자리와 카드 순서가 원래 그림과 같다. 카드가 하나도 안 남은 레인은 숨긴다. 고른 노드 카드는 따로 강조한다.

- **들어가기**: 카드를 고른 뒤 상세 패널의 **포커스** 버튼이나 위쪽 바의 **포커스** 버튼을 누르거나 `F` 키를 누른다. 버튼은 지금 레벨에 그 카드가 있을 때만 보이고 두 항목 화면과 묶음 세부 화면에서는 안 뜬다.
- **보이는 것**: 위쪽 바에 `포커스: <이름>` 표시와 ✕ 버튼이 뜬다.
- **나가기**: ✕를 누르거나 ESC를 누르면 원래 레벨로 돌아간다. ESC는 열린 팝오버, 상세 패널, 포커스 순서로 하나씩 닫는다. 브라우저 뒤로가기로도 나간다.
- **다른 노드로 옮기기**: 포커스 화면에서 다른 카드를 고르고 다시 포커스하면 같은 레벨에서 그 노드 기준으로 바뀐다. 주소 기록이 하나 더 쌓이므로 뒤로가기로 앞 포커스에 돌아온다.
- **안으로 들어가기**: 포커스 화면에서 **상세보기**나 더블클릭으로 들어가면 들어간 레벨은 포커스 없이 전체가 보인다. 뒤로가기를 누르면 포커스 화면으로 돌아온다.
- **두 항목 선택과 함께 쓰기**: 전체 레벨을 포커스한 화면에서도 Shift나 ⌘를 누른 채 두 카드를 고르면 두 항목 화면이 뜬다. 묶음 엣지를 누르는 것도 원래 레벨에서와 같다.
- **검색**: 이름으로 찾기는 포커스 화면에 남은 카드만 찾는다.
- **평면 그림**: 드릴다운이 아닌 평면 그림(deploy-path 포함)에서도 같은 규칙으로 동작한다. 평면 그림의 레벨 id는 `root`다.

---

## `ges_architecture` MCP 툴

### Actions

| Action | Description |
|--------|-------------|
| `start` | 이전 실행 요약과 맥락 파일 후보, 스키마 경로, 읽기 전용 판정 단어를 돌려준다 |
| `filter_tools` | 도구 이름을 보고 읽기 전용인지 판정해 `allowed`, `denied`, `ambiguous`로 나눈다 |
| `match_endpoints` | FE 호출과 BE 라우트를 method와 정규화한 경로로 맞춘다 |
| `validate` | IR을 검증만 한다. 저장하지 않는다 |
| `render` | 검증하고 이전 실행과 병합한 뒤 IR과 HTML 두 개를 저장한다. `service` 노드가 있으면 HTML이 드릴다운이 된다 |
| `status` | 두 뷰의 이전 실행 요약을 돌려준다 |

### Common Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `action` | `string` | Y | — | 수행할 액션 (위 테이블 참고) |
| `repoRoot` | `string` | N | 현재 작업 디렉토리 | 그림의 기준 레포. 저장 위치와 상대 `root`의 기준이 된다 |

### `start`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `view` | `"screen-chain" \| "deploy-path"` | Y | 그릴 뷰 |

응답 키는 이렇다.

| 키 | 내용 |
|---|---|
| `view` | 요청한 뷰 |
| `previous` | 이전 실행 요약 `{ generatedAt, nodeCount, edgeCount, unresolvedOpen }`. 처음이면 `null` |
| `previousSourcesUsed` | 지난 실행의 `sourcesUsed`. 처음이면 `[]` |
| `contextCandidates` | 읽어볼 맥락 파일 후보 `{ via, identifier, exists, visibility }[]`. `identifier`는 절대 경로다. [글로벌 맥락 후보](#글로벌-맥락-후보) 참고 |
| `schemaPath` | IR JSON Schema 파일의 절대 경로 |
| `readOnlyRule` | `{ allow, deny }`. 읽기 전용 판정 단어 목록 |
| `nextAction` | `"filter_tools"` |
| `instructions` | 세션이 다음에 할 일 네 줄 |

### `filter_tools`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `toolNames` | `string[]` | Y | 세션에 붙은 도구 이름 |

응답은 `{ allowed, denied, ambiguous }`다. 각각 `string[]`이고 입력 순서를 유지한다. 판정 규칙은 [읽기 전용 도구 걸러내기](#읽기-전용-도구-걸러내기)에 있다.

### `match_endpoints`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `feCalls` | `{ id, method, path, baseUrl? }[]` | Y | FE 쪽 API 호출 |
| `beRoutes` | `{ id, method, path, repo }[]` | Y | BE 쪽 라우트 선언 |
| `prefixCandidates` | `string[]` | N | FE 경로 앞에 붙는 게이트웨이 prefix 후보 |

경로 변수 표기(`{id}`, `:id`, `${expr}`, `<int:id>`, `[id]` 등)는 이름과 무관하게 전부 `{}`로 맞춘 뒤 비교한다. 절대 URL의 스킴과 호스트, 쿼리 문자열, 끝 슬래시도 걷어낸다. method가 `*`, `ANY`, `ALL`인 라우트는 어떤 method로 불러도 받는다.

FE 경로는 그대로 한 번 비교한다. `baseUrl`의 경로 부분과 `prefixCandidates`를 각각 떼어낸 경로로도 따로 비교한다. 떼지 않은 경로로 맞은 쪽이 먼저다.

응답은 `{ matches, unmatched }`다.

| 키 | 꼴 |
|---|---|
| `matches` | `{ feCallId, beRouteId, viaPrefix }[]`. prefix 없이 맞았으면 `viaPrefix`는 `null` |
| `unmatched` | `{ feCallId, reason, candidates }[]`. `reason`은 `no_route`, `ambiguous_prefix`, `multiple_routes` 중 하나 |

`unmatched`는 눈으로 맞춰 실선을 긋지 않는다. `candidates`를 담아 미해결 질문으로 남긴다.

### `validate`

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `ir` | `object` | Y | — | ArchitectureIR JSON |
| `view` | `string` | N | — | 주면 `ir.view`와 같아야 한다 |
| `checkFiles` | `boolean` | N | `true` | `code` 근거의 파일과 줄을 확인할지 |

성공 응답이다.

| 키 | 내용 |
|---|---|
| `ok` | `true` |
| `errors` | `[]` |
| `autoUnresolved` | 근거가 없어 자동으로 만든 질문 |
| `drawable` | `{ nodeIds, edgeIds }`. 그리기 대상 id, 정렬됨 |

실패하면 [검증 규칙](#검증-규칙)의 `{ ok: false, errors }`다.

### `render`

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `ir` | `object` | Y | — | ArchitectureIR JSON |
| `view` | `string` | N | — | 주면 `ir.view`와 같아야 한다 |
| `audience` | `"private" \| "shared"` | N | `"private"` | `openPath`가 가리킬 HTML. 파일은 늘 둘 다 쓴다 |
| `checkFiles` | `boolean` | N | `true` | `code` 근거의 파일과 줄을 확인할지 |

render는 이 순서로 돈다.

1. 받은 IR을 검증한다.
2. 이전 실행 IR이 있으면 병합해 id를 물려준다 ([재실행과 노드 id](#재실행과-노드-id)).
3. 병합 결과를 다시 검증한다. 병합이 id를 바꾸므로 그리기 대상도 다시 뽑는다.
4. 그린 `service` 노드가 있으면 [드릴다운](#드릴다운) 레벨을 계산한다. 없으면 평면 그림 한 장이다.
5. 좌표를 계산해 private HTML과 shared HTML을 쓴다.
6. 자동 질문을 `unresolved`에 합쳐 IR을 저장한다. 사람이 거기 답을 달면 다음 실행이 물려받는다.

성공 응답이다.

| 키 | 내용 |
|---|---|
| `ok` | `true` |
| `irPath` | 저장한 IR 경로 |
| `htmlPath` | 본인용 HTML 경로 |
| `sharedHtmlPath` | 공유용 HTML 경로 |
| `openPath` | `audience`에 따라 둘 중 하나 |
| `levels` | `{ id, title, nodes, edges }[]`. 드릴다운으로 그렸을 때만 온다. `nodes`와 `edges`는 그 레벨에 그린 수다. 엣지는 묶음 엣지 하나를 하나로 센다 |
| `stats` | [render stats](#render-stats) |
| `sourcesUsed` | 병합 결과의 `sourcesUsed` |

### `status`

추가 파라미터가 없다. 응답은 `{ views: { "screen-chain": 요약 | null, "deploy-path": 요약 | null } }`다. 요약은 `{ generatedAt, nodeCount, edgeCount, unresolvedOpen, sourcesUsed }`다.

---

## render stats

| 키 | 뜻 |
|---|---|
| `nodes` | IR의 노드 수 (그리지 않은 것 포함) |
| `edges` | IR의 엣지 수 (그리지 않은 것 포함) |
| `drawnEdges` | 그린 엣지 수 |
| `droppedEdges` | `edges - drawnEdges` |
| `unresolvedOpen` | 답이 안 달린 질문 수. IR의 질문과 자동 질문을 합친다 |
| `screenToEndpointRatio` | 화면 중 엔드포인트로 이어진 비율 |
| `endpointMatchRatio` | 엔드포인트 중 앱 모듈까지 이어진 비율 |

두 비율은 그린 노드와 그린 엣지만 센다.

- **`screenToEndpointRatio`** = (그린 엣지로 `endpoint` 노드에 닿는 그린 `screen` 수) ÷ (그린 `screen` 수)
- **`endpointMatchRatio`** = (그린 `handles` 엣지로 `app_module`에 닿는 그린 `endpoint` 수) ÷ (그린 `endpoint` 수)

분모가 0이면 `null`이다. deploy-path에는 `screen`과 `endpoint`가 없으므로 두 비율이 늘 `null`이다. 점선 엣지도 그린 엣지라 비율에 들어간다.

---

## 저장 위치

`<repoRoot>/.gestalt/architecture/` 아래 뷰마다 파일 세 개가 생긴다. 드릴다운도 레벨을 전부 HTML 한 파일에 담는다.

| 파일 | 내용 |
|---|---|
| `<view>.json` | 병합된 IR. private 근거의 `excerpt`는 지워져 있다 |
| `<view>.html` | 본인용 HTML |
| `<view>.shared.html` | 공유용 HTML |

파일은 전부 임시 파일에 쓴 뒤 이름을 바꿔 갈아 끼운다. 브라우저가 열어둔 HTML을 새로고침해도 반쯤 쓰인 파일을 보지 않는다. 저장된 IR이 깨졌거나 스키마에 안 맞으면 `.corrupt-*`로 옮기고 처음 실행처럼 다룬다.

레포를 넘는 연결에 필요한 레포가 이 머신에 없으면 세션이 묻지 않고 `~/.gestalt/architecture/clones/<host>/<org>/<repo>`에 `git clone --depth 1`로 받는다. 분석 대상 레포 안에 받지 않는 건 그 레포가 `.gestalt`를 ignore하지 않으면 받은 레포가 커밋에 섞이기 때문이다. 이미 있으면 `git fetch --depth 1` 뒤 기본 브랜치로 맞춰 다시 쓴다. 사용자가 체크아웃해 둔 레포는 읽기만 한다. 받기에 실패하면 미해결 질문으로 남는다. 절차는 스킬 Step 5에 있다.

### 재실행과 노드 id

재실행 때마다 id가 새로 매겨지면 사람이 단 답이 끊긴다. 그래서 render가 이전 IR(`<view>.json`)과 새 IR을 맞춰 이전 id를 물려준다 (`mergeWithPrevious`).

- **노드 안정 키**는 `kind`, `repo`, 정규화한 `label`(앞뒤 공백 제거, 연속 공백 하나로, 소문자)이다. 셋이 같으면 같은 노드로 보고 이전 id를 쓴다.
- **엣지 안정 키**는 id를 바꾼 뒤의 `from`, `to`, `kind`다.
- 노드의 `parent`도 바뀐 id를 따라간다.
- 새 IR의 다른 id와 부딪히면 바꾸지 않는다.
- 이전 IR에서 답이 달린 질문은 대상 노드나 엣지가 병합 결과에 남아 있을 때만 이어 붙인다. 같은 대상에 같은 질문이 새로 왔으면 답만 옮긴다.

label을 바꾸면 다른 노드가 된다. 엔드포인트 label을 `METHOD /정규화 경로` 꼴로 고정하는 이유다. 사람이 읽을 이름을 다듬고 싶으면 label 대신 `displayName`을 고친다. 병합 키에 안 들어가서 id가 그대로다.

---

## 읽기 전용 도구 걸러내기

세션은 맥락을 모으려고 MCP 도구를 부른다. 이때 쓰기 도구를 부르면 남의 시스템에 흔적이 남는다. `filter_tools`가 도구 이름만 보고 미리 거른다 (`src/utils/read-only-tools.ts`).

1. 이름을 토큰으로 쪼갠다. camelCase 경계와 `_`, `-`, `.`, `:`, `/`, 공백에서 끊고 소문자로 내린다.
2. 토큰 중 하나라도 금지 단어면 `denied`다. 금지 단어는 `send`, `create`, `update`, `delete`, `post`, `put`, `patch`, `dml`, `ddl`이다.
3. 금지 단어가 없고 허용 단어가 하나라도 있으면 `allowed`다. 허용 단어는 `search`, `get`, `read`, `list`, `query`, `fetch`다.
4. 둘 다 없으면 `ambiguous`다.

금지 단어가 허용 단어보다 먼저다. `getOrCreate`는 `get`이 있어도 `create` 때문에 `denied`다. 토큰 단위로 보므로 `listing`처럼 허용 단어를 품은 다른 단어는 걸리지 않는다.

| 이름 | 결과 |
|---|---|
| `mcp__kb__search_docs` | `allowed` |
| `mcp__kb__create_page` | `denied` |
| `getOrCreateUser` | `denied` |
| `mcp__acme__run` | `ambiguous` |

세션은 `allowed`만 부른다. `ambiguous`도 부르지 않는다.

---

## 글로벌 맥락 후보

`start`의 `contextCandidates`는 세션이 읽어볼 파일 목록이다. 서버는 경로만 모으고 본문은 읽지 않는다 (`src/architecture/global-context.ts`).

| via | 파일 | visibility |
|---|---|---|
| `repo` | `<repoRoot>/CLAUDE.md`, `<repoRoot>/AGENTS.md`, `<repoRoot>/.gestalt/memory.json` | `public` |
| `repo` | `<repoRoot>/docs/` 아래 `.md` 전부 | `public` |
| `global` | `~/.claude/CLAUDE.md` | `private` |
| `global` | 같은 레포로 묶인 `~/.claude/projects/*/memory/` 바로 아래 `.md` | `private` |

정렬은 `repo`가 먼저고 그 안에서는 경로순이다. 홈 아래에서 레포를 연 경우처럼 같은 파일이 두 번 잡히면 `repo` 쪽 하나만 남긴다.

### git remote로 메모리 묶기

Claude Code는 작업 디렉토리 경로마다 `~/.claude/projects/<인코딩된 경로>/memory/`를 따로 둔다. 같은 레포를 워크트리 여러 개로 열면 메모리가 워크트리마다 흩어진다. `src/utils/claude-projects.ts`의 `findClaudeProjectMemoryDirs`가 이걸 한 레포로 모은다.

1. 지금 레포 경로, `git worktree list`로 나온 워크트리 경로를 인코딩해 메모리 디렉토리가 있는지 본다. 인코딩은 영숫자와 `-` 밖의 문자를 전부 `-`로 바꾼 것이다.
2. `origin` remote URL을 정규화해 레포 키로 쓴다. 스킴, 사용자 정보, 포트, 끝의 `.git`과 슬래시를 걷어내고 호스트만 소문자로 내린다. 그래서 `git@github.com:acme/web.git`과 `https://github.com/acme/web`이 같은 키 `github.com/acme/web`이 된다.
3. 1에서 못 본 나머지 프로젝트 디렉토리도 훑는다. 디렉토리 이름에서 원래 경로를 되살린다. 인코딩이 `/`, `.`, `-`를 모두 `-`로 뭉개므로 구분자 후보를 실제 파일 시스템에 대어 보며 존재하는 경로를 찾는다. 되살린 경로의 remote 키가 같으면 같은 레포의 메모리로 묶는다.

remote가 없는 레포는 3을 건너뛰고 1의 경로 일치만 쓴다. 지워진 워크트리처럼 경로를 되살릴 수 없는 디렉토리는 묶이지 않는다.

---

## 미해결 질문 루프

미해결 질문은 근거를 못 찾은 자리다. 숨기지 않고 그림과 함께 남긴다.

1. 세션은 IR의 `unresolved`와 `validate` 응답의 `autoUnresolved`를 모아 사용자에게 묻는다. 한 번에 다섯 개 안쪽으로 묶는다.
2. 답을 받으면 질문의 `answer`에 적는다. 그 답이 확인한 노드나 엣지에 `user` 근거를 단다. `user` 근거는 점선이다.
3. 답이 코드 위치를 알려주면 거기서 코드를 찾아 `code` 근거를 단다. 그때 실선이 된다.
4. 다시 `validate`를 돌고 `render`한다.

render는 자동 질문까지 IR에 저장한다. 답이 안 달린 질문은 HTML의 미해결 목록에 나오고 다음 실행에서 다시 묻는다. 답이 달린 질문은 병합 때 물려받는다.

---

## Skills

| 슬래시 커맨드 | 파일 | 설명 |
|---|---|---|
| `/architecture` | `skills/architecture/SKILL.md` | 뷰 하나를 탐색부터 render까지 드라이빙한다 |

설계 리뷰나 설계 자문은 `architect` 에이전트를 쓴다. 파일 단위 의존성과 영향 범위는 [코드 그래프](./code-graph.md)를 쓴다.
