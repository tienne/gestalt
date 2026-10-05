# Architecture View

코드와 맥락 소스에서 찾은 근거로 아키텍처 그림을 그린다. 그림에 그은 실선은 전부 "코드나 스펙에서 확인했다"는 주장이다. 근거를 못 찾은 연결은 점선이나 미해결 질문으로 남는다. 빈칸이 많은 그림이 틀린 그림보다 낫다는 게 출발점이다.

뷰는 둘이다.

| 뷰             | 흐름                                                                |
| -------------- | ------------------------------------------------------------------- |
| `screen-chain` | 화면 → 백엔드 엔드포인트 → 백엔드 앱 모듈 → 외부 서비스와 DB 테이블 |
| `deploy-path`  | 배포 단위별 트리거 → 빌드 → 산출물 → 배포 대상                      |

`/architecture` 스킬이 이 흐름을 드라이빙하고 `ges_architecture` MCP 도구가 검증과 렌더를 맡는다. 스킬 절차는 [`plugin/skills/architecture/SKILL.md`](../plugin/skills/architecture/SKILL.md)에 있다.

웹 제품 말고 다른 대상도 그린다. 네트워크와 실행 환경, 데이터 파이프라인, 조직과 업무 시스템은 IR에 [어휘 팩](#어휘-팩)을 적어 그 분야의 kind로 그린다. "누가 무엇을 어떤 순서로 주고받나"처럼 질문 하나에 답하는 그림은 [질문별 그림](#질문별-그림)으로 같은 뷰 안에 얹는다. 질문별 그림은 세 번째 뷰가 아니다. 뷰의 노드와 엣지를 가리켜 다시 그린 그림이라 같은 IR, 같은 HTML에 들어간다.

저장소: `.gestalt/architecture/` (뷰별 IR JSON과 HTML 두 개, 질문별 그림이 있으면 `views/` 아래 JSON)

---

## 누가 무엇을 하나

`ges_architecture`는 Passthrough 도구다. 서버는 LLM을 부르지 않는다.

| 맡는 쪽                   | 하는 일                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 세션 (Claude Code 등)     | 맥락 소스를 고르고 코드를 탐색한다. 근거 달린 IR을 JSON으로 쓴다. 미해결 질문을 사용자에게 묻는다                  |
| 서버 (`ges_architecture`) | IR을 스키마로 검증하고 근거 파일과 줄을 확인한다. 이전 실행과 병합해 노드 id를 물려준다. 좌표를 계산해 HTML을 쓴다 |

탐색은 세션 모델의 판단이 필요한 일이라 세션에 둔다. 검증과 렌더는 같은 입력에 같은 결과가 나와야 하는 일이라 서버에 둔다. 세션이 그린 그림을 서버가 다시 보지 않으면 근거 없는 실선이 그대로 나가게 된다.

---

## IR 구조

IR(중간 표현)은 세션이 서버에 넘기는 JSON이다. 스키마는 [`schemas/architecture-ir.schema.json`](../schemas/architecture-ir.schema.json)에 있고 `start` 응답의 `schemaPath`가 이 파일의 절대 경로를 준다. 서버는 같은 구조를 zod로 다시 파싱한다 (`src/architecture/ir-schema.ts`).

| 필드            | 내용                                                                                                                                                                                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | `"1.0.0"` 고정                                                                                                                                                                                                                                                                                                                                      |
| `view`          | `screen-chain` 또는 `deploy-path`                                                                                                                                                                                                                                                                                                                   |
| `packs`         | 선택. 이 IR이 쓰는 [어휘 팩](#어휘-팩) id 목록. 안 적으면 `web-product`와 `harness`로 읽는다                                                                                                                                                                                                                                                       |
| `repos`         | `{ id, name, root?, remote? }`. `root`는 로컬 경로다. 상대 경로면 `repoRoot` 기준으로 푼다. `root`가 없으면 [문서 묶음 레포](#문서-묶음-레포)다                                                                                                                                                                                                      |
| `nodes`         | `{ id, kind, label, repo, parent?, displayName?, displayNameInferred?, description?, environment?, engine?, account?, platforms?, platformEvidence?, displayKind?, renderClass?, evidence[] }`. `parent`는 이 노드를 담는 노드의 id다. [포함 관계](#포함-관계)에서 설명한다. 이름 두 필드는 [표시 이름](#표시-이름)에서, 인프라 필드는 [서빙 인프라](#서빙-인프라)에서, `displayKind`와 `renderClass`는 [범용 component](#범용-component)에서 설명한다. `description`은 카드의 설명 줄과 서랍에 나온다. 비우면 validate가 경고한다 ([검증 규칙](#검증-규칙)) |
| `edges`         | `{ id, from, to, kind, evidence[], lineStyle }`. `lineStyle`은 `solid` 또는 `dashed`                                                                                                                                                                                                                                                                |
| `unresolved`    | `{ id, subject: { nodeId?, edgeId?, stepId?, transitionId?, messageId? }, question, answer? }`. `messageId`는 질문별 그림의 메시지 id다                                                                                                                                                                                                             |
| `flows`         | 선택. 도메인 흐름이다. 보통 서비스 하나에 딸리고 서비스 없이 따로 설 수도 있다. [도메인 흐름](#도메인-흐름)에서 설명한다                                                                                                                                                                                                                             |
| `projections`   | 선택. 질문 하나에 답하는 그림이다. [질문별 그림](#질문별-그림)에서 설명한다                                                                                                                                                                                                                                                                         |
| `stages`        | 선택. 기술 그림을 왼쪽에서 오른쪽으로 나누는 구간이다. `{ id, label, nodes?, kinds?, repos? }`이고 배열 순서가 왼쪽부터다. [구간](#구간)에서 설명한다                                                                                                                                                                                               |
| `groups`        | 합친 IR에만 있다. `{ id, name, members }`이고 `members`는 그 제품 분석에 있던 노드 id다. [분석 합치기](#분석-합치기)에서 설명한다                                                                                                                                                                                                                   |
| `sourcesUsed`   | 이번 실행이 간 본 맥락 소스. `{ via, identifier, readOnly, probeHit, visibility }`                                                                                                                                                                                                                                                                  |
| `generatedAt`   | 생성 시각 문자열. HTML에 그대로 찍힌다                                                                                                                                                                                                                                                                                                              |

근거(`evidence`) 하나는 `{ type, location, visibility, updatedAt?, excerpt?, command?, observedAt? }`다. 뒤의 두 필드는 `live` 근거에만 쓴다.

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
      "evidence": [
        { "type": "code", "location": "acme-web:src/routes.tsx:42", "visibility": "public" }
      ]
    },
    {
      "id": "e-orders-get",
      "kind": "endpoint",
      "label": "GET /api/v1/orders/{}",
      "repo": "acme-api",
      "evidence": [
        {
          "type": "code",
          "location": "acme-api:src/orders/controller.ts:18",
          "visibility": "public"
        }
      ]
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
    {
      "via": "repo",
      "identifier": "CLAUDE.md",
      "readOnly": true,
      "probeHit": true,
      "visibility": "public"
    }
  ],
  "generatedAt": "2026-10-01T09:00:00Z"
}
```

### 노드 kind

아래 표는 `web-product`와 `harness` 팩의 kind다. `packs`를 안 적은 IR이 쓰는 어휘가 이것이다. 다른 팩의 kind는 [어휘 팩](#어휘-팩)에 있다.

| kind               | 뷰           | 뜻                                                                                                                                                     |
| ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `service`          | screen-chain | 사용자가 쓰는 FE 앱이나 제품                                                                                                                           |
| `micro_app`        | screen-chain | 서비스를 이루는 마이크로 프론트엔드 앱 하나. label은 federation 설정의 `name`이다                                                                      |
| `feature`          | screen-chain | 서비스 안의 기능영역. 페이지보다 한 단계 위인 제품 단위 (예: 등록모드, 대시보드, 설정)                                                                 |
| `screen`           | screen-chain | 사용자가 보는 화면이나 페이지                                                                                                                          |
| `gateway`          | screen-chain | 요청을 받아 다른 서버로 넘기는 서버                                                                                                                    |
| `endpoint`         | screen-chain | 백엔드 HTTP 엔드포인트. label은 `METHOD /정규화 경로` 꼴. `protocol: "mcp"`면 MCP 도구이고 label은 도구 이름이다 ([MCP 도구](#mcp-도구))                |
| `app_module`       | screen-chain | 엔드포인트를 처리하는 백엔드 모듈이나 컨트롤러                                                                                                         |
| `external_service` | screen-chain | 모듈이 부르는 다른 서비스, 외부 API, 메시지 브로커                                                                                                     |
| `datastore`        | screen-chain | 테이블이 사는 DB 클러스터나 캐시 클러스터 (RDS, Aurora, Redis 등). `repo`는 클라우드 조회용 가짜 레포로 두고 label은 `<엔진>:<클러스터 식별자>` 꼴이다 |
| `db_table`         | screen-chain | 모듈이 읽고 쓰는 테이블                                                                                                                                |
| `client`           | screen-chain | 플러그인을 읽어 들이는 AI 클라이언트 (Claude Code, Codex, Grok 등). 근거는 그 클라이언트가 읽는 매니페스트 줄이다                                          |
| `skill`            | screen-chain | SKILL.md 하나. 사용자가 고르는 입구라 웹의 화면 자리에 선다                                                                                             |
| `agent`            | screen-chain | AGENT.md 하나. 스킬이나 다른 에이전트가 띄우는 서브에이전트                                                                                             |
| `workflow`         | deploy-path  | 배포를 시작하는 CI 워크플로와 그 트리거                                                                                                                |
| `build`            | deploy-path  | 빌드 잡이나 스텝                                                                                                                                       |
| `artifact`         | deploy-path  | 이미지, 번들, 패키지 같은 빌드 산출물                                                                                                                  |
| `deploy_target`    | deploy-path  | 산출물이 올라가는 클러스터, 런타임, 네이티브 앱 배포처                                                                                                 |
| `domain`           | 둘 다        | 사용자가 접속하는 도메인                                                                                                                               |
| `cdn`              | 둘 다        | CDN 배포                                                                                                                                               |
| `bucket`           | 둘 다        | 정적 번들이나 코드푸시 번들이 올라가는 버킷                                                                                                            |
| `cloud_account`    | 둘 다        | 클라우드 계정. 다른 노드의 `account`가 이 노드를 가리킨다                                                                                              |

레이아웃은 kind마다 열을 정해 왼쪽부터 놓는다. screen-chain은 `service`, `micro_app`, `feature`, `screen`이 한 열, 그다음 `gateway`, `endpoint`, `app_module`이고 `external_service`가 그 뒤, `datastore`와 `db_table`이 마지막 한 열이다. deploy-path는 `workflow`, `build`, `artifact`, `deploy_target` 다음에 인프라 레인 `bucket`, `cdn`, `domain`, `cloud_account`가 붙는다. 하네스 kind는 웹과 열을 나눠 쓴다. `client`가 서비스보다 왼쪽, `skill`이 화면 열, `agent`가 게이트웨이 열이고 MCP 도구는 엔드포인트 열에 자기 레인으로 선다 (`src/architecture/layout.ts`의 `PARTITION_RANK`).

### 엣지 kind

노드 kind처럼 `web-product`와 `harness` 팩의 엣지다. 다른 팩의 엣지는 [어휘 팩](#어휘-팩)에 있다.

| kind           | from → to                                  | 근거가 되는 줄                                                                                                                |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `navigates`    | screen → screen                            | `navigate()`, `Link`, `history.push` 줄                                                                                       |
| `calls`        | screen → endpoint                          | 화면 쪽 API 호출 줄                                                                                                           |
| `calls`        | external_service → gateway                 | 클라이언트 base URL이 게이트웨이 호스트를 가리키는 줄                                                                         |
| `calls`        | skill, agent → endpoint (MCP 도구)         | 지시문의 도구 호출 줄. `actions`에 그 호출이 넘기는 action 값을 단다                                                          |
| `routes`       | gateway → endpoint, gateway, app_module    | 게이트웨이 라우트 설정의 `Path`나 `uri` 줄                                                                                    |
| `handles`      | endpoint → app_module                      | 라우트 매핑 어노테이션이나 라우터 등록 줄. MCP 도구면 도구 등록에서 핸들러로 넘기는 줄                                        |
| `uses`         | app_module → external_service, app_module  | 외부 클라이언트 호출 줄. 모듈끼리면 같은 프로세스 안의 호출 줄이다 (MCP 핸들러 → 엔진)                                        |
| `reads_writes` | app_module → db_table, datastore           | 쿼리나 엔티티 매핑 줄. 테이블 단위로 못 내려가는 캐시는 저장소로 바로 긋는다. 근거는 datasource URL이나 캐시 host 설정 줄이다 |
| `triggers`     | workflow → build                           | 워크플로의 트리거와 잡 정의 줄                                                                                                |
| `builds`       | build → artifact                           | 빌드 명령 줄                                                                                                                  |
| `produces`     | build → artifact                           | 산출물을 내보내는 줄 (이미지 push, 업로드)                                                                                    |
| `deploys_to`   | artifact → deploy_target, bucket           | 배포 명령이나 매니페스트 줄                                                                                                   |
| `resolves_to`  | domain → cdn, deploy_target                | 인프라 코드의 도메인 줄이나 CDN 별칭 조회                                                                                     |
| `origin`       | cdn → bucket, deploy_target                | 인프라 코드의 원본 정의 줄이나 CDN 원본 조회                                                                                  |
| `serves`       | bucket, deploy_target → service, micro_app | 그 번들을 버킷에 올리는 줄이나 서버로 띄우는 배포 매니페스트 줄. `micro_app`이 달린 서비스는 가리킬 수 없고 앱을 가리킨다     |
| `loads`        | micro_app → micro_app                      | 호스트 federation 설정의 `remotes` 항목 줄이나 single-spa `registerApplication` 줄                                            |
| `loads`        | client → service                           | 클라이언트가 플러그인을 읽는 매니페스트 줄                                                                                    |
| `loads`        | app_module → agent                         | 레지스트리가 에이전트 디렉토리를 훑어 AGENT.md를 읽는 줄                                                                      |
| `spawns`       | skill, agent → agent                       | 지시문에서 그 에이전트를 띄우는 줄                                                                                            |
| `invokes`      | skill → skill                              | 지시문에서 다른 스킬을 부르는 줄                                                                                              |

`routes`는 게이트웨이가 요청을 어디로 넘기는지다. 게이트웨이가 여러 단이면 앞 게이트웨이에서 뒤 게이트웨이로 `routes`를 긋고 엔드포인트로 가는 `routes`는 마지막 게이트웨이에만 단다. `gateway → app_module`은 엔드포인트를 노드로 펼치지 않은 클라이언트 호출 사슬에 쓴다.

### 포함 관계

노드의 `parent`는 이 노드를 담는 노드의 id다. 엣지가 아니라서 선으로 그리지 않는다. [드릴다운](#드릴다운) 레벨을 나누는 데만 쓴다.

| kind        | parent로 가리킬 수 있는 kind      |
| ----------- | --------------------------------- |
| `screen`    | `feature`, `micro_app`, `service` |
| `feature`   | `micro_app`, `service`            |
| `micro_app` | `service`                         |
| `skill`     | `feature`, `service`              |
| `db_table`  | `datastore`                       |
| `endpoint`  | `service` (MCP 도구만)            |
| 그 밖       | parent를 가질 수 없다             |

`infra`, `data`, `process` 팩의 포함 규칙은 [어휘 팩](#어휘-팩)의 kind 표에 함께 적었다. 범용 `component`는 parent를 가질 수 없다.

parent 노드가 근거가 없어 그려지지 않으면 자식은 parent가 없는 것으로 친다.

#### 마이크로 프론트엔드

서비스 하나가 따로 배포하는 앱 여럿으로 이뤄져 있으면 앱마다 `micro_app`을 두고 서비스에 단다. 호스트가 리모트를 불러오는 관계는 `loads` 엣지다. 호스트인지 리모트인지는 따로 적지 않는다. 그 서비스 안에서 들어오는 `loads`가 없는 앱이 호스트다. 호스트가 정확히 하나면 그 앱이 사용자 진입 앱이 되고 서비스 카드의 웹 칩과 도메인은 진입 앱 것을 쓴다. 계산은 `src/architecture/micro-app.ts`의 `indexMicroApps`다.

호스트를 `loads` 근거 줄 하나로 끌어내는 이유가 있다. 호스트와 리모트를 필드로 따로 적게 하면 `remotes` 설정과 그 필드가 어긋날 자리가 하나 더 생긴다.

화면을 어느 기능영역에 넣을지는 앱 메뉴나 네비게이션 정의를 먼저 본다. 그다음이 라우트 트리의 중첩이다. 레이아웃은 실제로 씌워진 것만 마지막에 본다. 메뉴에 단독 항목으로 있는 화면은 그 하나로 기능영역이 된다. 메뉴와 라우트가 엇갈리면 두 화면이 같은 API를 공유하는지도 본다. 그래도 애매할 때만 미해결 질문으로 돌린다. 사용자가 답한 경계는 `user` 근거로 남아 재실행 때 다시 묻지 않고 parent도 바꾸지 않는다.

### 표시 이름

`label`은 기술 이름이다. 모듈 이름이나 레포 이름처럼 코드에 있는 그대로 쓴다. 사람이 그 서버를 부르는 이름은 따로 있는 경우가 많아서 `displayName`에 담는다.

| 필드                  | 뜻                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `displayName`         | 사람이 부르는 이름. 예: label이 `acme-order-api`면 `주문 서버`                                                       |
| `displayNameInferred` | `true`면 문서에 그대로 있던 이름이 아니라 근거 문장을 줄여 지은 이름이다. `displayName` 없이 쓰면 `IR_PARSE_ERROR`다 |

- 박스는 첫 줄에 `displayName`을 굵게, 둘째 줄에 `label`을 작게 쓴다. `displayName`이 없으면 `label` 한 줄이다.
- 추정 이름이면 박스에 "추정" 배지가 붙고 패널 제목 아래에 지은 이름이라는 문구가 뜬다.
- 패널 제목, 드릴다운 레벨 제목, 빵부스러기, 두 노드 선택 표도 `displayName`을 먼저 쓴다.
- `.shared.html`에도 이름은 그대로 보인다. 가리는 건 근거뿐이다.
- 병합 키가 아니다. `displayName`을 바꾸거나 새로 달아도 노드 id는 유지된다. [재실행과 노드 id](#재실행과-노드-id)를 본다.

### MCP 도구

AI 하네스나 MCP 서버 레포에서는 MCP 도구가 API 자리에 선다. 따로 kind를 두지 않고 `endpoint`에 필드를 단다. 매칭과 드릴다운, 핸들러로 가는 `handles`를 HTTP 엔드포인트와 같은 길로 태우려는 것이다. 읽는 사람에게만 API 대신 **MCP 도구** 칩과 레인으로 보인다 (`src/architecture/types.ts`의 `displayKindOf`).

| 필드        | 쓰는 노드         | 뜻                                                                     |
| ----------- | ----------------- | ---------------------------------------------------------------------- |
| `protocol`  | `endpoint`        | `http`(기본) 또는 `mcp`. 다른 kind에 달면 `IR_PARSE_ERROR`다           |
| `mcpServer` | `mcp` endpoint    | 도구를 등록한 MCP 서버 이름                                            |
| `actions`   | `mcp` endpoint    | 도구가 `action` 인자로 받는 값. 서버의 enum이나 분기 그대로 적는다     |

- `parent`에는 그 도구를 내놓는 서비스를 단다. 서버 패키지를 서비스로 따로 세웠으면 그 서비스, 아니면 플러그인 `service`다. 스킬 없이 클라이언트가 도구를 바로 부르는 순수 MCP 서버 레포에서 서비스와 서버를 잇는 선이 이 값에서 나온다 ([하네스 레포](#하네스-레포)). HTTP 엔드포인트에는 parent를 못 단다. 달면 `INVALID_PARENT_KIND`다.
- 노드는 도구 하나에 하나다. action마다 나누면 카드가 action 수만큼 늘어 어느 스킬이 어느 도구를 쓰는지가 묻힌다.
- 스킬이나 에이전트에서 도구로 가는 `calls`에는 그 호출이 넘기는 action을 엣지 `actions`에 단다. 도구의 `actions`에 없는 값이면 `UNKNOWN_MCP_ACTION`이다.
- `client`, `skill`, `agent`가 하나라도 든 IR을 **하네스 IR**로 본다. 하네스에만 거는 규칙(아래 [근거와 선 모양](#근거와-선-모양)의 md 근거)이 이걸로 켜진다. 웹 IR은 예전대로 돈다.

### 서빙 인프라

정적 웹 서비스는 도메인 → CDN → 버킷 → 서비스 순으로 요청을 받는다. SSR 웹 서비스는 버킷 자리에 서버(`deploy_target`)가 서고 CDN 없이 도메인이 서버를 바로 가리키기도 한다. 이 사슬을 노드로 두면 서비스가 어디서 서빙되는지 그림에서 읽힌다. 범위는 AWS 하나이고 비용과 트래픽은 싣지 않는다.

| 필드               | 쓰는 노드                                                                | 뜻                                                                                                         |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `environment`      | `domain`, `cdn`, `bucket`, `cloud_account`, `deploy_target`, `datastore` | 환경 이름. 같은 레인 안에서 `prod`, `stage`, `qa`, `dev` 순으로 놓이고 그 밖의 환경, 환경 없음이 뒤에 선다 |
| `engine`           | `datastore`                                                              | `mysql`, `redis` 같은 엔진 이름. 아는 엔진이면 종류 칩에 그 로고가 선다. 비우면 `label`에서 찾는다         |
| `account`          | 아무 노드 (`cloud_account` 제외)                                         | 이 노드가 속한 `cloud_account` 노드의 id. 양 끝 노드의 계정이 다른 선은 다른 색으로 그린다                 |
| `platforms`        | `service`                                                                | `web`, `android`, `ios` 중 이 서비스가 배포되는 것                                                         |
| `platformEvidence` | `service`                                                                | 플랫폼별 근거 목록. `{ "android": [근거], "ios": [근거] }` 꼴                                              |

마이크로 프론트엔드면 사슬을 앱마다 따로 싣고 `serves`는 각자 자기 앱을 가리킨다. 호스트 사슬의 도메인이 사용자가 들어오는 진입 도메인이고 리모트 사슬은 호스트가 런타임에 번들을 받아 오는 곳이다. 앱이 달린 서비스를 `serves`로 가리키면 거부한다. 서비스 하나로 모으면 어느 도메인이 진입이고 어느 CDN이 리모트인지 그림에서 안 갈려서다.

플랫폼은 근거가 있어야 칩이 붙는다. 웹은 버킷이나 배포 대상이 `serves`로 그 서비스를 서빙하면 따로 적지 않아도 웹으로 친다. Android와 iOS는 `platforms`에 적고 `platformEvidence`에 근거를 달아야 한다. `platforms`에 적었는데 근거가 없으면 칩을 안 붙이고 `auto:platform:<노드 id>:<플랫폼>` 질문을 만든다.

웹 칩은 서빙 방식에 따라 "웹"과 "웹(SSR)"으로 갈린다. 정적 웹이 흔한 경우라 괄호를 붙이지 않는다. 서빙하는 노드 중 prod나 환경 없는 것만 먼저 보고 하나도 없으면 전체를 본다. 그중 배포 대상이 하나라도 있으면 SSR이고 버킷만 있으면 정적이다. 정적 파일은 버킷에 두고 일부 경로만 서버가 받는 구성도 서버가 렌더를 맡는 쪽이라 SSR로 친다. stage에만 SSR 서버가 있고 prod는 버킷이면 정적이다. 전체보기가 prod 기준이라 칩도 prod를 따른다. 앱 카드는 자기 사슬로 칩을 따로 판정한다.

id에는 클라우드 계정 ID(12자리 숫자)와 CDN 배포 ID, 저장소의 클러스터 식별자를 넣지 않는다. id는 공유본에서도 가릴 수 없어서다. `prod-web`이나 `ds:redis-common`처럼 별칭으로 짓고 실제 ID는 `label`에 둔다.

---

## 어휘 팩

웹 제품 kind로는 서브넷이나 데이터셋, 결재 양식을 그릴 수 없다. 그래서 kind 목록과 레인, 열 순위, parent 규칙, 색, 아이콘, 칩 글자, 엣지 양 끝 규칙을 팩 단위로 묶었다 (`src/architecture/packs/`). IR은 최상위 `packs`에 쓰는 팩을 적는다.

```json
{ "schemaVersion": "1.0.0", "view": "screen-chain", "packs": ["infra"], "repos": [ ... ], "nodes": [ ... ] }
```

- `packs`를 안 적으면 `web-product`와 `harness`로 읽는다 (`LEGACY_PACK_IDS`). 팩을 나누기 전 어휘 전부라서 옛 IR이 그대로 읽힌다.
- 팩은 `requires`로 다른 팩을 끌어온다. `infra`를 적으면 `generic`도 함께 쓰는 셈이다.
- 적은 팩(끌어온 팩 포함)에 없는 kind를 노드나 엣지에 쓰면 `KIND_NOT_IN_PACKS`로 거부한다. 어느 범례로 읽을지 정할 수 없어서다. 없는 팩 id를 적으면 `UNKNOWN_PACK`이다.
- 페이지에는 IR이 쓰는 팩의 색과 아이콘, 칩 글자만 싣는다. 그래서 팩을 더해도 `packs`를 안 적은 그림의 HTML은 바이트까지 예전과 같다. 서비스 구조, 흐름, 하네스, 배포 경로, 합친 그림을 가짜 IR로 그린 해시가 `tests/unit/architecture/legacy-snapshot.test.ts`에 있다.

| 팩            | 끌어오는 팩   | 드릴다운      | 그리는 대상                                                  |
| ------------- | ------------- | ------------- | ------------------------------------------------------------ |
| `web-product` | 없음          | `web-product` | 웹 제품. 서비스, 기능영역, 화면, API, 서버, 저장소, 배포 경로 |
| `harness`     | `web-product` | `web-product` | AI 하네스와 MCP 서버. 클라이언트, 스킬, 에이전트             |
| `generic`     | 없음          | `none`        | 맞는 팩이 없는 구성 요소. [범용 component](#범용-component)  |
| `infra`       | `generic`     | `tree`        | 네트워크, 서브넷, 클러스터, 워크로드, 방화벽                 |
| `data`        | `generic`     | `tree`        | 원천, 토픽, 처리 작업, 데이터셋, 리포트                      |
| `process`     | `generic`     | `tree`        | 조직, 역할, 양식, 업무 시스템                                |
| `knowledge`   | `generic`     | `tree`        | 문서 묶음, 문서, 화면 문서. [knowledge 팩](#knowledge-팩)    |

드릴다운 전략은 팩마다 하나다. `web-product`는 전체에서 서비스, 기능영역, 화면으로 내려가는 지금 그림이고 `tree`는 parent 포함 관계로 레벨을 나눈다([tree 드릴다운](#tree-드릴다운)). `none`은 평면 한 장이다. 팩을 섞으면 `web-product`, `tree`, `none` 순으로 앞선 것을 고른다 (`packs/index.ts`의 `vocabularyOf`). `generic`을 끌어와도 `tree` 팩의 전략이 덮이지 않는다.

### 범용 component

`generic` 팩의 kind는 `component` 하나다. 맞는 팩이 없을 때 무엇이든 이 kind로 그린다. 종류는 노드에 직접 적는다.

| 필드          | 뜻                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `displayKind` | 칩에 그대로 찍히는 종류 이름 (예: 배치 잡, 결재 문서)                                                                                       |
| `renderClass` | 색과 아이콘을 고르는 분류. `actor`, `client`, `service`, `gateway`, `store`, `queue`, `external`, `infra`, `step`, `state`, `document` 중 하나 |

- `component`에는 두 필드가 다 있어야 한다. 하나라도 빠지면 `IR_PARSE_ERROR`다.
- `component`가 아닌 노드에는 두 필드를 쓸 수 없다. 팩 kind는 자기 색과 아이콘이 따로 있다.
- `component`는 parent를 가질 수 없다. parent 없는 `component`는 드릴다운 전체 레벨에 서고 그 사이 선은 묶지 않고 그대로 긋는다.
- 흐름 단계의 `refs`로 가리킬 수 있다.

엣지 kind는 셋이고 양 끝을 가리지 않는다.

| kind         | 뜻   |
| ------------ | ---- |
| `connects`   | 연결 |
| `sends`      | 보냄 |
| `depends_on` | 의존 |

같은 종류의 `component`를 여러 그림에서 반복해 쓰게 되면 팩을 따로 만드는 편이 낫다. 팩은 데이터만 더하면 되고 렌더러와 드릴다운 코드는 안 고친다 (`packs/types.ts`의 `VocabularyPack`).

### infra 팩

네트워크 안에 서브넷이, 그 안에 클러스터와 워크로드가 들어간다. 포함 관계가 깊어서 parent 나무로 한 단계씩 내려가며 본다.

| kind       | 칩       | 레인     | parent로 가리킬 수 있는 kind       |
| ---------- | -------- | -------- | ---------------------------------- |
| `firewall` | 방화벽   | 경계     | `network`, `subnet`                |
| `network`  | 네트워크 | 네트워크 | 없음                               |
| `subnet`   | 서브넷   | 네트워크 | `network`                          |
| `cluster`  | 클러스터 | 실행     | `network`, `subnet`                |
| `workload` | 워크로드 | 실행     | `network`, `subnet`, `cluster`     |

| 엣지 kind | 뜻        | from → to                                 |
| --------- | --------- | ----------------------------------------- |
| `peers`   | 피어링    | network → network                         |
| `allows`  | 통신 허용 | firewall → subnet, cluster, workload      |

### data 팩

원천에서 토픽과 처리 작업을 지나 데이터셋에 쌓이고 리포트로 나간다. 파이프라인 안에 처리 작업이, 웨어하우스 안에 데이터셋이 들어간다.

| kind        | 칩         | 레인 | parent로 가리킬 수 있는 kind |
| ----------- | ---------- | ---- | ---------------------------- |
| `source`    | 원천       | 원천 | 없음                         |
| `topic`     | 토픽       | 통로 | 없음                         |
| `pipeline`  | 파이프라인 | 처리 | 없음                         |
| `job`       | 처리 작업  | 처리 | `pipeline`                   |
| `warehouse` | 웨어하우스 | 저장 | 없음                         |
| `dataset`   | 데이터셋   | 저장 | `warehouse`                  |
| `report`    | 리포트     | 활용 | 없음                         |

| 엣지 kind   | 뜻          | from → to                |
| ----------- | ----------- | ------------------------ |
| `feeds`     | 데이터 공급 | 가리지 않는다            |
| `publishes` | 발행        | source, job → topic      |

### process 팩

누가 어느 조직에 있고 어떤 시스템과 양식으로 일을 넘기는지 그린다. 순서가 중요한 업무 절차는 [도메인 흐름](#도메인-흐름)으로 그린다. 이 팩은 그 흐름에 나오는 사람과 시스템이 어디 속하는지를 잡는다.

| kind       | 칩          | 레인   | parent로 가리킬 수 있는 kind |
| ---------- | ----------- | ------ | ---------------------------- |
| `org_unit` | 조직        | 사람   | `org_unit`                   |
| `role`     | 역할        | 사람   | `org_unit`                   |
| `form`     | 양식        | 양식   | 없음                         |
| `system`   | 업무 시스템 | 시스템 | 없음                         |

| 엣지 kind    | 뜻   | from → to                                   |
| ------------ | ---- | ------------------------------------------- |
| `hands_over` | 넘김 | org_unit, role → org_unit, role             |
| `approves`   | 승인 | org_unit, role → form                       |
| `records`    | 기록 | org_unit, role, system → form, system       |

엣지 양 끝 규칙을 어기면 하네스 엣지와 같은 `INVALID_HARNESS_EDGE_ENDS`로 거부한다. 규칙을 팩의 `edgeKinds.ends` 한 곳에서 읽어서다.

### knowledge 팩

문서 레포를 지도로 그린다. 분류나 도메인 같은 묶음 안에 문서가, 디자인 영역 안에 화면 문서가 들어간다. 세션이 IR을 손으로 쓰지 않는다. [`scan_docs`](#scan_docs)와 [`link_docs`](#link_docs)가 이 팩으로 초안을 쓴다.

| kind            | 칩        | 레인      | parent로 가리킬 수 있는 kind |
| --------------- | --------- | --------- | ---------------------------- |
| `doc_group`     | 문서 묶음 | 묶음      | `doc_group`                  |
| `document`      | 문서      | 문서      | `doc_group`                  |
| `design_screen` | 화면 문서 | 화면 문서 | `doc_group`                  |

| 엣지 kind   | 뜻   | from → to                                  |
| ----------- | ---- | ------------------------------------------ |
| `describes` | 설명 | 지식 문서 → 기술 노드. 늘 점선이다          |
| `indexes`   | 안내 | document → document, design_screen, doc_group |

- 문서 노드는 파일 하나이고 label이 레포 기준 경로다. 그래서 재실행 병합 키가 경로를 따른다.
- 뷰는 둘이다. `knowledge`는 문서 지도만 그리고 `knowledge-link`는 기술 그림에 문서를 엮는다. `knowledge-link`에서 문서는 카드로 서지 않고 기술 카드의 배지와 서랍으로 보인다.

### 문서 묶음 레포

업무 절차나 조직처럼 코드가 없는 대상은 근거가 위키 문서와 사람 말뿐이다. 그런 출처는 `root` 없는 레포로 적는다.

```json
"repos": [{ "id": "wiki", "name": "acme-wiki" }]
```

- 노드의 `repo`는 이 별칭을 가리킨다.
- 이 레포를 가리키는 `code` 근거는 확인할 파일이 없어서 `CODE_EVIDENCE_IN_DOC_REPO`로 거부한다. 문서면 `doc` 근거로 적는다.
- 근거가 `doc`과 `user`뿐이라 선은 전부 점선이다.
- `packs`를 적었고 `web-product`가 빠진 IR은 제목을 따로 단다. 노드 없이 흐름만 있으면 "업무 흐름"이고 그 밖은 "구성 요소 연결"이다.

---

## 근거와 선 모양

근거는 다섯 종류다. 선 모양은 근거 종류로 정해진다.

| type   | location                                                                                                                 | 선   |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | ---- |
| `code` | `<repoId>:<relPath>:<line>`. `repoId`는 `repos[].id`, `relPath`는 레포 루트 기준 상대 경로                               | 실선 |
| `spec` | OpenAPI, proto 같은 API 명세 안의 정의 위치                                                                              | 실선 |
| `doc`  | 문서 링크나 경로. `updatedAt`에 수정일                                                                                   | 점선 |
| `user` | 질문 id와 답한 날짜. 답 원문은 질문의 `answer`에 둔다                                                                    | 점선 |
| `live` | 조회로 찾은 리소스 종류 (예: `aws:cloudfront`). `command`에 실행한 명령, `observedAt`에 조회 시각(ISO 8601, 시간대 포함) | 점선 |

엣지에 `code`나 `spec` 근거가 하나라도 있으면 실선이고 없으면 점선이다. 서버는 IR에 적힌 `lineStyle`을 믿지 않고 근거로 다시 계산해 덮어쓴다. 사용자가 "그렇다"고 답한 연결도 점선이다. 코드로 확인했다는 뜻이 아니어서다.

`live`도 같은 이유로 점선이다. 조회 결과는 지금 클라우드가 그렇게 돼 있다는 사실이지 코드가 그렇게 만든다는 증거는 아니다. 인프라 코드 줄이 함께 있으면 실선이 된다.

하네스 IR에서는 SKILL.md와 AGENT.md 줄을 `code` 근거로 받는다. 세션이 실제로 읽고 따르는 지시문이라 코드와 같은 자리다. 다만 `skill`, `agent` 노드와 그 둘에서 나가는 엣지에서만이다. 그 밖의 노드나 엣지에 md 줄을 `code`로 달면 `MD_CODE_EVIDENCE`로 거부한다. README나 docs의 언급까지 실선이 되면 문서에 적힌 계획과 실제 동작이 그림에서 안 갈린다. 스킬 묶음 `feature`처럼 문서로만 확인한 것은 `doc` 근거로 단다. 웹 IR은 README 줄을 `code`로 써 온 결과가 있어 이 규칙을 걸지 않는다.

`live` 근거는 `command`와 `observedAt`이 둘 다 있어야 한다. 다른 종류의 근거는 두 필드를 쓸 수 없다. 어기면 `IR_PARSE_ERROR`다. `command`는 서버가 [CLI 명령 판정](#cli-명령-판정)으로 다시 본다.

---

## 검증 규칙

`validate`와 `render`는 같은 검증을 탄다 (`src/architecture/validator.ts`). 아래 마흔둘은 IR 전체를 거부한다.

| 에러 코드                           | 언제                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOLID_EDGE_WITHOUT_EVIDENCE`       | `lineStyle: "solid"`인데 `code`나 `spec` 근거가 없다. 근거가 0개인 실선도, `doc`, `user`, `live` 근거만 있는 실선도 여기 걸린다                                                          |
| `CODE_EVIDENCE_NOT_FOUND`           | `code` 근거의 위치가 `<repoId>:<relPath>:<line>` 꼴이 아니거나, `repoId`가 `repos`에 없거나, 경로가 절대 경로이거나 레포 루트 밖을 가리키거나, 파일이 없거나, 줄 번호가 파일 범위 밖이다 |
| `PRIVATE_EXCERPT_PRESENT`           | `visibility: "private"` 근거에 `excerpt`가 들어 있다. private `live` 근거면 조회 응답 원문을 넣었다는 문구가 따로 나온다                                                                 |
| `LIVE_COMMAND_NOT_READ_ONLY`        | `live` 근거의 `command`가 [CLI 명령 판정](#cli-명령-판정)에서 `allow`가 아니다                                                                                                           |
| `ACCOUNT_NOT_FOUND`                 | `account`가 가리키는 노드가 `nodes`에 없다                                                                                                                                               |
| `INVALID_ACCOUNT_KIND`              | `account`가 `cloud_account`가 아닌 노드를 가리킨다                                                                                                                                       |
| `CLOUD_ID_IN_ID`                    | 노드나 엣지 id에 계정 ID 꼴(12자리 숫자)이 들었거나, `cdn` 노드 id에 CDN 배포 ID 꼴이 들었다                                                                                             |
| `DANGLING_EDGE`                     | 엣지의 `from`이나 `to`가 `nodes`에 없다                                                                                                                                                  |
| `PARENT_NOT_FOUND`                  | `parent`가 가리키는 노드가 `nodes`에 없다                                                                                                                                                |
| `PARENT_CYCLE`                      | `parent`를 따라가면 자기 자신으로 돌아온다                                                                                                                                               |
| `INVALID_PARENT_KIND`               | [포함 관계](#포함-관계) 규칙에 어긋난다. parent를 가질 수 없는 kind에 달았거나 담을 수 없는 kind를 가리킨다                                                                              |
| `DUPLICATE_GROUP_ID`                | `groups`에 같은 id가 둘 있다                                                                                                                                                             |
| `GROUP_MEMBER_NOT_FOUND`            | `groups[].members`의 id가 `nodes`에 없다                                                                                                                                                 |
| `SERVES_SERVICE_WITH_APPS`          | `serves`가 `micro_app`이 달린 서비스를 가리킨다                                                                                                                                          |
| `INVALID_LOADS_ENDS`                | `loads`가 `micro_app → micro_app`, `client → service`, `app_module → agent` 중 어느 것도 아니다. 스킬에서 에이전트로 가는 선은 `loads`가 아니라 `spawns`다                               |
| `INVALID_HARNESS_EDGE_ENDS`         | `spawns`가 스킬이나 에이전트에서 에이전트로 가지 않거나 `invokes`가 스킬끼리가 아니다. 스킬이나 에이전트의 `calls`가 `endpoint` 밖을 가리켜도 여기 걸린다. 다른 팩의 엣지가 [어휘 팩](#어휘-팩)의 from → to 규칙을 어겨도 같은 코드다 |
| `INVALID_CALL_ACTIONS`              | 엣지 `actions`를 MCP 도구로 가는 `calls`가 아닌 엣지에 달았다                                                                                                                            |
| `UNKNOWN_MCP_ACTION`                | 엣지 `actions`에 도구 노드의 `actions`에 없는 값이 있다                                                                                                                                  |
| `MD_CODE_EVIDENCE`                  | 하네스 IR에서 `skill`, `agent` 노드와 그 둘에서 나가는 엣지 밖에 md 파일 줄을 `code` 근거로 달았다                                                                                        |
| `FLOW_SERVICE_NOT_FOUND`            | 흐름에 `service`를 적었는데 `nodes`에 없거나 `service` 노드가 아니다                                                                                                                      |
| `DUPLICATE_FLOW_ID`                 | 흐름, 단계, 전이 id가 흐름 전체에서 겹치거나 한 흐름 안에서 행위자 id가 겹친다                                                                                                           |
| `FLOW_ACTOR_NOT_FOUND`              | 단계의 `actor`가 그 흐름의 `actors`에 없다                                                                                                                                               |
| `FLOW_STEP_NOT_FOUND`               | 전이의 `from`이나 `to`가 그 흐름의 `steps`에 없다                                                                                                                                        |
| `FLOW_REF_NOT_FOUND`                | 단계의 `refs`가 `nodes`에 없다                                                                                                                                                           |
| `INVALID_FLOW_REF_KIND`             | 단계의 `refs`가 `screen`, `endpoint`, `feature`, `micro_app`, `skill`, `agent`, `component`가 아닌 노드를 가리킨다                                                                       |
| `SOLID_TRANSITION_WITHOUT_EVIDENCE` | 전이가 `lineStyle: "solid"`인데 `code`나 `spec` 근거가 없다                                                                                                                              |
| `DUPLICATE_STAGE_ID`                | 구간 id가 겹친다                                                                                                                                                                         |
| `STAGE_NODE_NOT_FOUND`              | 구간의 `nodes`가 `nodes`에 없다                                                                                                                                                          |
| `STAGE_NODE_TWICE`                  | 한 노드가 두 구간의 `nodes`에 함께 올라 있다                                                                                                                                             |
| `UNKNOWN_PACK`                      | `packs`에 없는 팩 id가 있다                                                                                                                                                              |
| `KIND_NOT_IN_PACKS`                 | 노드나 엣지의 kind가 IR이 적은 팩(끌어온 팩 포함)에 없다                                                                                                                                 |
| `CODE_EVIDENCE_IN_DOC_REPO`         | `code` 근거가 `root` 없는 [문서 묶음 레포](#문서-묶음-레포)를 가리킨다                                                                                                                   |
| `DUPLICATE_PROJECTION_ID`           | 질문별 그림 id가 겹친다                                                                                                                                                                  |
| `DUPLICATE_MESSAGE_ID`              | 메시지 id가 겹친다. 질문별 그림을 넘어서도 겹치면 안 된다                                                                                                                                |
| `PROJECTION_NODE_NOT_FOUND`         | `participants`, `sides[].nodes`, 메시지 `from`이나 `to`가 `nodes`에 없다. `participants`를 적었는데 메시지 끝이 거기 없어도 여기 걸린다                                                  |
| `PROJECTION_EDGE_NOT_FOUND`         | 메시지 `edge`가 `edges`에 없다                                                                                                                                                           |
| `PROJECTION_EDGE_MISMATCH`          | 메시지 `edge`가 메시지의 두 끝을 잇는 엣지가 아니다                                                                                                                                      |
| `PROJECTION_BLOCK_NOT_FOUND`        | 메시지 `block`이 그 그림의 `blocks`에 없다                                                                                                                                               |
| `PROJECTION_BLOCK_SPLIT`            | 한 묶음의 메시지가 이어져 있지 않고 중간에 끊겼다가 다시 나온다                                                                                                                          |
| `SOLID_MESSAGE_WITHOUT_EVIDENCE`    | 메시지가 실선인데 자기 근거와 가리킨 엣지 근거 어디에도 `code`나 `spec`이 없다                                                                                                           |
| `PROJECTION_EMPTY`                  | `sequence`나 `dataflow` 그림에 메시지가 하나도 없다                                                                                                                                      |
| `PROJECTION_SHAPE_FIELD`            | 모양에 안 맞는 필드를 썼다. [질문별 그림](#질문별-그림)의 모양별 필드 표를 본다                                                                                                          |

`checkFiles: false`를 넘기면 `CODE_EVIDENCE_NOT_FOUND`의 파일 존재와 줄 범위 확인을 건너뛴다. 기본값은 `true`다.

거부하지 않고 알리기만 하는 경고도 있다. 성공 응답의 `warnings`에 실리고 render를 막지 않는다. 경고가 없으면 키 자체가 안 온다.

| 경고 코드                  | 언제                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `NODE_DESCRIPTION_MISSING` | 그리는 노드 중 `description`이 없거나 공백뿐이다. 해당 노드 id를 정렬해 `nodeIds`에 모은다. 경고는 이 코드 하나로 한 번만 온다 |

설명이 비면 카드에 설명 줄이 안 붙고 서랍에서도 그 노드가 무엇인지 안 나온다. 그래도 거부하지 않는 건 설명이 없다고 그림이 틀리지는 않아서다. 공백뿐인 설명을 없는 것으로 치는 판정은 레이아웃 높이와 같다 (`src/architecture/types.ts`의 `hasCardDescription`).

근거 없는 실선을 미해결로 조용히 돌리지 않고 거부하는 이유가 있다. 실선은 확인했다는 주장이라, 근거 없이 나온 실선 하나가 그림 전체를 못 믿게 만든다.

반대로 아래 경우는 에러가 아니다. 그리기 대상에서 빠지고 미해결 질문이 자동으로 생긴다 (`autoUnresolved`).

- 근거가 0개인 점선 엣지. 질문 id는 `auto:edge:<엣지 id>`다.
- 근거가 0개인 노드. 질문 id는 `auto:node:<노드 id>`다.
- 근거가 있어도 양 끝 노드 중 하나가 그리기 대상에서 빠진 엣지. 이 엣지에는 질문을 따로 만들지 않는다.
- `platforms`에 적었는데 근거가 없는 플랫폼. 질문 id는 `auto:platform:<노드 id>:<플랫폼>`이다. 웹은 그려지는 버킷이 `serves`로 서빙하면 묻지 않는다.
- 근거가 0개인 흐름 단계. 질문 id는 `auto:step:<단계 id>`다.
- 근거가 0개인 흐름 전이. 질문 id는 `auto:transition:<전이 id>`다. 근거가 있어도 양 끝 단계 중 하나가 빠지면 그리지 않는다.
- 자기 근거도 가리킨 엣지 근거도 없는 질문별 그림 메시지. 질문 id는 `auto:message:<메시지 id>`다. 근거가 있어도 양 끝 노드 중 하나가 빠지면 그리지 않는다.
- 앱이 둘 이상인 서비스에 호스트가 정확히 하나가 아닐 때. 질문 id는 `auto:entry:<서비스 id>`다. 호스트가 없으면 진입 앱을 묻고 여럿이면 그 후보 이름을 함께 보이며 `remotes` 설정이 어느 앱에 있는지 묻는다.

그리기 대상은 그대로 두고 질문만 더하는 경우도 있다. 사람이 하는 단계인데 들어오고 나가는 전이가 하나씩이고 나가는 전이가 다른 길로도 닿는 단계로 합류하면 그 단계는 두 상태를 잇기만 하는 동작일 수 있다. 상태 값이 없거나 앞 단계로 되돌아가면 `auto:as-transition:<단계 id>` 질문을 만들어 전이로 적을지 묻는다. 정정이나 되돌리기, 결제처럼 끼어드는 동작이 여기 걸린다. 들어온 단계로 바로 돌아가는 단계는 그 단계를 되돌린 것이라 묻지 않는다. 세션이 그 단계에 다른 질문을 달았어도 이 질문은 따로 선다.

나가는 전이가 없는 단계도 묻는다. 착석이나 취소처럼 흐름이 끝나는 단계는 `terminal: true`를 달아 뺀다. 표시가 없는 단계에는 `auto:dead-end:<단계 id>` 질문을 만들어 다음에 어디로 가는지 묻는다. 미루기처럼 줄로 돌아가는 단계가 선을 빠뜨리면 그림만 봐서는 흐름이 거기서 끝난 것처럼 읽혀서다. 이 질문도 id로 겹침을 본다.

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

`errors[]` 항목에는 해당하면 `nodeId`, `edgeId`, `flowId`, `stepId`, `transitionId`, `projectionId`, `messageId`, `evidenceIndex`가 붙는다.

---

## 공개 범위와 shared 렌더

근거와 맥락 소스마다 `visibility`가 붙는다.

| 출처                                                                                 | visibility | excerpt     |
| ------------------------------------------------------------------------------------ | ---------- | ----------- |
| 레포에 커밋된 파일 (코드, `CLAUDE.md`, `AGENTS.md`, `docs/`, `.gestalt/memory.json`) | `public`   | 실어도 된다 |
| 홈 아래 파일 (`~/.claude/CLAUDE.md`, `~/.claude/projects/*/memory/`)                 | `private`  | 금지        |
| KB 검색 결과, MCP 도구 응답, 스킬 조회 결과                                          | `private`  | 금지        |
| 사용자 답                                                                            | `private`  | 금지        |
| 클라우드 조회 결과 (`live`)                                                          | `private`  | 금지        |

private 근거의 원문은 세 겹으로 막는다.

1. `validate`가 private 근거의 `excerpt`를 `PRIVATE_EXCERPT_PRESENT`로 거부한다.
2. 저장하는 IR에서 private 근거의 `excerpt`를 지운다 (`stripPrivateExcerpts`).
3. 공유용 HTML(`.shared.html`)은 private 근거의 `location`까지 빼고 `type`과 `visibility`만 남긴다 (`redactForSharing`). 패널에는 출처 종류만 보인다.

`live` 근거는 `public`으로 적었어도 공유본에서 `type`, `visibility`, `observedAt`만 남는다. 명령과 리소스 위치에 계정 ID나 리소스 이름이 들어가기 때문이다. 공유본은 노드 이름(`label`, `displayName`, `description`)과 흐름의 제목, 행위자, 단계 글자, 전이 조건, 질문 문장, 레벨 제목에 든 계정 ID도 가린다. `cdn` 노드는 CDN 배포 ID도 가린다. 자동 질문은 공유본에 싣지 않는다.

지식 문서 그림(`knowledge`, `knowledge-link`)의 공유본은 문서 정보도 줄인다 (`maskDocInfo`).

- 문서 제목(`displayName`)과 경로(`label`, `doc.path`)는 남긴다.
- 본문에서 온 글자는 뺀다. 절 제목, 구멍 설명과 담당, 화면 이름과 썸네일이 여기 든다. 남는 건 숫자와 날짜, 참거짓뿐이다.
- 질문 안내 표의 키워드는 `(공유본이라 가림)` 하나로 바꾼다. 안내가 어느 문서를 가리키는지는 남는다.
- 문서 노드 자기 근거는 `private`이라 위치가 빠지고 `type`과 `visibility`만 남는다.
- `describes` 선이 가리킨 파일 경로는 문서 밖 레포의 경로라 가린다. 확인 여부와 커밋 날짜만 남는다.
- 노드의 CODEOWNERS 담당도 빠진다. 그래서 공유본에는 "담당 없음" 배지가 안 붙는다.

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

노드와 선, 레인 제목을 누르면 오른쪽 서랍에 설명과 출처가 뜬다. 무엇이 나오는지는 [조작](#조작)에 있다. `http`나 `https`로 시작하는 근거 위치는 링크가 된다.

---

## 드릴다운

서비스 하나에 화면이 수십 개, 엔드포인트가 수백 개면 평면 그림 한 장은 캔버스가 수천 px로 커져 읽을 수 없다. 그래서 그린 `service` 노드가 하나라도 있으면 render가 레벨을 나눠 HTML 한 장에 담는다 (`src/architecture/drilldown.ts`의 `shouldDrillDown`, `computeDrilldown`). 서비스가 없으면 아래 세 경우를 빼고 평면 그림이다. deploy-path에는 서비스가 없으니 질문별 그림을 얹지 않으면 평면이다.

서비스가 없어도 아래 셋 중 하나면 드릴다운 HTML이 된다. 셋 다 레벨로만 그려지는 그림이라서다.

- `service`를 안 적은 [독립 흐름](#서비스-없는-흐름)이 있다.
- 그려지는 [질문별 그림](#질문별-그림)이 있다.
- `tree` 전략 팩을 쓰고 그려지는 노드 사이에 parent 관계가 하나라도 있다 ([tree 드릴다운](#tree-드릴다운)).

### 레벨

| 레벨     | id               | 보이는 것                                                                                                                                                                                                                                                         |
| -------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 전체     | `root`           | 서비스, 게이트웨이, 서버(앱 모듈), 저장소만. prod 기준이다. 엣지는 세부 엣지를 묶은 것이고 굵기와 숫자가 건수다. 마이크로 프론트엔드 서비스는 서비스 카드 아래 앱 카드를 이어 쌓고 테두리로 한 묶음을 그린다                                                      |
| 서비스   | `service:<id>`   | 서비스 카드에서 기능영역, 화면으로 이어지는 위계와 화면이 부르는 게이트웨이와 서버. 화면 호출은 화면에서 바로 묶인다. 서비스를 서빙하는 버킷이나 배포 대상이 있으면 그 노드와 앞단 CDN, 도메인이 서비스 카드 왼쪽에 선다. 화면 사이 이동은 기능영역 레벨에서 본다 |
| 앱       | `app:<id>`       | 마이크로 프론트엔드 리모트 앱 하나. 서비스 레벨과 같은 구성(서빙 사슬, 앱, 기능영역, 화면, 게이트웨이, 서버)이다. 진입 앱은 서비스 레벨이 대신해서 이 레벨이 없다                                                                                                 |
| 기능영역 | `feature:<id>`   | 그 기능영역의 화면, 화면이 부르는 엔드포인트, 거쳐 가는 게이트웨이, 받는 모듈. 세부 엣지 그대로                                                                                                                                                                   |
| 서버     | `server:<id>`    | 그 모듈이나 게이트웨이에 걸린 엔드포인트, 모듈이 읽고 쓰는 테이블과 저장소, 쓰는 클라이언트와 그 클라이언트가 부르는 모듈                                                                                                                                         |
| 흐름     | `flow:<흐름 id>` | 서비스 하나의 도메인 흐름. 서비스 레벨 아래에 선다. 서비스 없는 흐름은 전체 바로 아래에 선다. [도메인 흐름](#도메인-흐름)에서 설명한다                                                                                                                            |
| 묶음     | `group:<id>`     | `tree` 전략에서 자식이 있는 노드 하나의 안쪽. [tree 드릴다운](#tree-드릴다운)에서 설명한다                                                                                                                                                                        |
| 질문     | `view:<id>`      | 질문별 그림 하나. 전체 바로 아래에 선다. [질문별 그림](#질문별-그림)에서 설명한다                                                                                                                                                                                 |

전체 레벨에는 parent 없는 [범용 component](#범용-component)도 선다. 그 사이 선은 묶지 않고 그대로 긋는다. component로만 이뤄진 그림이 독립 흐름이나 질문별 그림 때문에 드릴다운이 돼도 전체 레벨이 비지 않는다.

### 묶음 엣지의 주인

전체 레벨의 묶음 엣지는 세부 노드마다 전체 레벨의 어느 노드에 속하는지(주인)를 정한 뒤 만든다.

| 세부 노드                                       | 주인                                                        |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `screen`, `feature`, `skill`                    | 조상 중 가장 가까운 `micro_app`. 없으면 `service`           |
| `agent`                                         | `spawns`를 거슬러 올라가 닿는 스킬의 주인                   |
| `endpoint`                                      | `handles`로 받는 `app_module`. 여럿이면 각각                |
| `external_service` (클라이언트)                 | 그 클라이언트를 `uses`하는 `app_module`                     |
| `service`, `micro_app`, `gateway`, `app_module` | 자기 자신                                                   |
| `client`                                        | 자기 자신                                                   |
| `db_table`                                      | 자기 `parent` 저장소. parent가 없으면 전체 레벨에 안 나온다 |
| `datastore`                                     | 자기 자신                                                   |

화면이 부르는 엔드포인트에 게이트웨이 사슬이 있으면 서비스 → 맨 앞 게이트웨이 → … → 맨 뒤 게이트웨이 → 모듈로 묶인다. 사슬은 그 엔드포인트로 `routes`하는 게이트웨이에서 `gateway → gateway` `routes`를 거꾸로 따라 올라가, 들어오는 `routes`가 없는 게이트웨이까지다. 게이트웨이가 없는 엔드포인트는 서비스 → 모듈로 바로 묶인다. 모듈 A가 쓰는 클라이언트가 모듈 B를 부르면 A → B다. 클라이언트가 게이트웨이를 부르면 A → 게이트웨이 → B다.

모듈이 테이블을 읽고 쓰면 모듈 → 그 테이블의 저장소로 묶인다. 저장소로 바로 그은 `reads_writes`도 같은 묶음에 들어간다. 테이블 카드는 서버 레벨에만 나온다.

전체 레벨은 prod 기준이다. `environment`가 있고 `prod`가 아닌 노드(stage, qa, dev 저장소나 인프라)는 빼고 묶는다. 그래서 dev 저장소로 가는 호출은 묶음 건수에 안 들어간다. 환경이 비어 있는 노드는 prod로 쳐서 올린다. 서비스, 게이트웨이, 앱 모듈은 원래 환경을 안 적으므로 늘 올라간다. 아래 레벨은 환경 전부를 그려 두고 화면 위쪽 환경 버튼으로 보일 환경을 고른다([조작](#조작)).

#### 마이크로 프론트엔드 서비스

`micro_app`이 달린 서비스는 레벨 구성이 다르다.

- **전체 레벨**: 서비스 카드를 머리로 두고 그 아래 진입 앱, 나머지 앱을 id 순으로 쌓는다. 묶음 전체를 테두리 하나로 감싼다. 화면 호출은 화면이 속한 앱에서 나가므로 리모트마다 어느 서버를 부르는지 갈려 보인다. `loads`는 테두리를 넘는 것(다른 서비스의 리모트를 부르는 것)만 그린다. 같은 묶음 안의 `loads`는 쌓인 순서와 칩으로 읽힌다.
- **서비스 레벨**: 진입 앱 레벨을 겸한다. 사용자가 서비스로 들어오면 처음 받는 게 진입 앱이라 둘을 나누면 같은 그림을 한 번 더 누르게 된다. 위계를 열로 나눠 왼쪽부터 진입 앱 서빙 사슬(도메인 → CDN → 버킷이나 배포 대상), 호스트, 리모트, 기능영역, 화면, 게이트웨이, 서버 순으로 세운다. 호스트에서 리모트로는 `loads` 선이, 앱에서 기능영역과 화면으로는 포함 선이 가고 화면 호출은 화면에서 바로 게이트웨이로 묶인다. 호스트에 바로 단 기능영역과 화면은 리모트 열을 건너 호스트에서 이어진다. 리모트의 서빙 사슬은 여기 그리지 않는다. 진입 앱 카드를 눌러도 이 레벨로 온다.
- 서비스 레벨의 위아래 자리는 elk가 아니라 나무 순서로 다시 잡는다 (`stackTree`). 마이크로 프론트엔드가 아닌 서비스도 같다. 리모트 블록이 먼저, 호스트 자기 기능영역과 화면이 그 아래다. 블록 안에서는 elk가 정한 순서를 따르고 부모 카드는 첫 자식과 같은 높이에 선다. elk는 교차만 줄여서 리모트끼리 화면을 섞어 놓아 어느 화면이 어느 앱 것인지 안 읽힌다.
- **앱 레벨**: 리모트 앱 하나를 서비스 레벨과 같은 열로 펼친다. 그 리모트가 또 다른 앱을 불러오면 그 앱은 리모트 열에 선다. 빵부스러기는 전체 → 서비스 → 리모트 앱 → 기능영역 순이다. 진입 앱 기능영역은 전체 → 서비스 → 기능영역이다.
- **진입 앱을 못 정한 서비스**: 호스트가 없거나 여럿이면 서비스 레벨에 앱 카드를 전부 포함 선으로 늘어놓고 앱마다 앱 레벨로 들어간다. `auto:entry` 질문이 함께 뜬다.

`loads` 선은 요청 선과 갈리게 굵은 점 무늬로 그린다. 근거가 약한 선은 일반 점선이 그대로 이긴다.

묶음 엣지마다 건수와 멤버 세부 엣지 id 목록이 따라간다. 묶음 안에 `code` 근거로 확인된 고리가 하나라도 있으면 묶음 선은 실선이다. 코드로 확인된 연결이 있는데 점선으로 그리면 확인된 연결까지 추정처럼 읽혀서다. 묶음 안이 전부 `doc`이나 `user` 근거일 때만 묶음 선이 점선이다.

실선 묶음에 `doc`이나 `user` 근거만 있는 고리가 섞였으면 그 사실은 선 모양 대신 배지와 이름으로 알린다. `DrillEdge`에 `inferred`(점선 고리 수)가 붙고 건수 배지 테두리를 점선(`stroke-dasharray 3 2`)으로 그린다. 묶음 이름에는 " (문서 근거만 있는 연결 N개 포함)"이 붙는다. 접근성 라벨, 툴팁 `title`, 패널 제목이 다 이 이름을 쓴다. 섞인 묶음이 없는 그림에는 이 표시 코드를 싣지 않아서 HTML 바이트가 그대로다.

#### 하네스 레포

`client`, `skill`, `agent`나 MCP 도구가 든 그림은 플러그인 `service`를 서비스로 삼아 같은 레벨을 탄다.

- **전체 레벨**: AI 클라이언트, 플러그인 서비스, 핸들러와 엔진 앱 모듈, 저장소가 선다. `client → service` `loads`는 묶지 않고 그대로 긋는다. 스킬의 도구 호출은 서비스 → 핸들러 모듈로 묶인다. 에이전트가 부른 도구는 그 에이전트를 띄운 스킬의 호출로 올려 묶는다. 아무도 `calls`로 부르지 않는 도구는 그 도구의 parent 서비스 → 핸들러 모듈로 묶는다. 스킬 없이 클라이언트가 도구를 바로 부르는 순수 MCP 서버 레포는 이게 없으면 서비스와 서버 카드 사이에 선이 하나도 안 생긴다. 스킬이 부르는 도구는 그 호출로 이미 묶였으니 여기서 빼서 건수가 두 번 세지지 않게 한다. 핸들러 → 엔진 `uses`는 같은 프로세스 안의 호출이라 외부 서비스로 치지 않는다. 핸들러에서 `uses`로 닿는 모듈은 엔진으로 보고 핸들러 오른쪽 열에 따로 세운다. 외부 서비스와 저장소 열은 그만큼 한 칸씩 뒤로 밀린다. 엔진을 안 부르는 핸들러도 핸들러 열에 선다. elk는 나가는 선이 없는 카드를 뒤 층으로 민다. 그대로 두면 그런 핸들러가 엔진 열에 서 버려서 열을 따로 정한다.
- **서비스 레벨**: 스킬이 화면 열에, 스킬이 띄우는 에이전트가 그 다음 열에 선다. MCP 도구는 묶음으로 접지 않고 카드로 세운 뒤 핸들러로 잇는다. 웹 API처럼 수백 개가 되는 일이 없고 도구가 하네스 그림의 중심이라서다.
- **기능영역 레벨**: 그 묶음의 스킬, 스킬이 띄우는 에이전트, `invokes`, 도구 호출, 핸들러를 세부 엣지 그대로 그린다.
- **서버 레벨**: 엔진 모듈을 고르면 그 엔진을 `uses`하는 핸들러 모듈과 엔진이 읽고 쓰는 저장소가 나온다. 고른 모듈이 에이전트를 `loads`로 읽어 들이면 그 에이전트도 받는 쪽 열에 선다. 어떤 스킬도 띄우지 않는 에이전트(역할 에이전트 같은)는 서비스 레벨과 기능영역 레벨에 안 나오므로 드릴다운에서 그 에이전트가 보이는 자리는 여기 하나다. 레지스트리 모듈이 없거나 `loads`를 안 그었으면 그런 에이전트는 그림 어디에도 안 선다.
- 무엇이 무엇을 어떤 순서로 부르는지는 지도로 안 보인다. 진입 경로마다 [질문별 그림](#질문별-그림)의 `sequence` 순서도로 보여준다. 전체 레벨 지도 위 카드 줄에서 순서도로 들어간다.
- 스킬 디렉토리 심링크와 마켓플레이스 매니페스트는 이 그림에 싣지 않는다. 릴리즈 워크플로에서 빌드, npm 패키지, 플러그인 매니페스트로 이어지는 배포 경로라 deploy-path에 그린다. 그쪽 모델은 웹과 같다.

### tree 드릴다운

`infra`, `data`, `process` 팩은 서비스 대신 parent 포함 관계로 레벨을 나눈다 (`drilldown.ts`의 `groupDrafts`). 네트워크 안의 서브넷, 파이프라인 안의 처리 작업, 조직 안의 역할처럼 안으로 들어가 볼 대상이 kind마다 달라서 웹 그림처럼 단계를 고정하지 않는다.

- **전체 레벨**에는 parent 없는 노드가 선다.
- **자식이 있는 노드**마다 `group:<노드 id>` 레벨이 하나 생긴다. 그 레벨에는 직속 자식이 선다. 빵부스러기는 전체에서 그 노드까지 조상 순서다.
- **안쪽 선은 끌어올린다.** 레벨에 선 카드의 자손끼리 이어진 선은 그 카드까지 올려서 묶음 엣지로 그린다. 끌어올리지 않은 선이 한 쌍에 하나뿐이면 원래 kind 그대로 그린다. 그래야 범례 글자가 맞는다.
- **밖으로 나가는 선**의 상대 쪽은 지금 레벨을 품은 조상 바로 아래까지만 올린다. 옆 서브넷이나 옆 조직처럼 한 단계 위 형제로 보이게 하려는 것이다. 그 카드는 보내기만 하면 왼쪽 끝 **밖에서 들어옴** 레인에, 받는 쪽이면 오른쪽 끝 **밖으로 나감** 레인에 선다. kind 순위대로 두면 안쪽 카드 사이에 끼어 선이 크게 돌아서다.
- **바깥 카드는 레인 안에서 열을 나눈다.** kind 순위마다 열을 따로 잡고 한 열에 네 장(`OUTSIDE_PER_COLUMN`)이 넘으면 옆 열로 넘긴다. 받는 쪽은 안쪽 카드 오른쪽부터, 보내기만 하는 쪽은 안쪽 카드 왼쪽으로 열이 늘어난다. 한 열에 다 쌓으면 바깥 카드가 많을 때 그림이 세로로만 길어진다.

`tree` 팩이어도 그려지는 노드 사이에 parent 관계가 하나도 없으면 레벨을 나눌 이유가 없어 평면 그림이다.

### 레인

그림은 세로 띠(레인)로 나뉜다. 레인 하나가 레이어 하나이고 왼쪽에서 오른쪽으로 요청이 흐르는 순서로 놓인다. 레인 위쪽에 제목과 그 레인의 카드 수가 붙는다. 카드가 없는 레인은 아예 그리지 않는다. 드릴다운이 아닌 평면 그림도 같은 레인을 쓴다.

| 그림                            | 왼쪽부터                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 전체 레벨                       | 앱 → 게이트웨이 → 서버 → 외부 서비스 → DB. 마이크로 프론트엔드 앱 카드는 서비스와 같은 **앱** 레인에 선다      |
| 서비스 레벨                     | 서비스 → 기능 영역 → 화면 → 게이트웨이 → 서버. 서빙 인프라가 있으면 그 앞에 도메인 → CDN → 버킷 또는 배포 대상 |
| 마이크로 프론트엔드 서비스 레벨 | 도메인 → CDN → 버킷 또는 배포 대상 → 호스트 → 리모트 → 기능 영역 → 화면 → 게이트웨이 → 서버                    |
| 앱 레벨                         | 도메인 → CDN → 버킷 또는 배포 대상 → 리모트 → 기능 영역 → 화면 → 게이트웨이 → 서버                             |
| 기능영역 레벨                   | 화면 → 게이트웨이 → API → 서버                                                                                 |
| 서버 레벨                       | API → 서버 → 클라이언트 → 외부 서비스 → DB                                                                     |
| screen-chain 평면               | 화면 → 게이트웨이 → API → 서버 → 클라이언트 → DB                                                               |
| deploy-path                     | 트리거 → 빌드 → 산출물 → 배포 대상 → 버킷 → CDN → 도메인 → 클라우드 계정                                       |

- 전체 레벨의 **DB** 레인에는 저장소 카드가 선다.
- 전체 레벨의 **외부 서비스** 레인에는 서비스 쪽에서는 닿지 않고 서버에서 나가는 선으로만 닿는 게이트웨이와 서버가 선다.
- 서비스 레벨은 서비스 카드가 제 열 맨 위에 서고 기능영역과 화면으로 옅은 포함 선이 나간다. 서비스에 바로 단 화면은 기능 영역 열을 건너 서비스에서 바로 이어진다. 포함 선은 `parent` 관계를 그린 것이라 세부 엣지가 없다. 평면 그림에서는 서비스와 기능영역이 **화면** 레인에 선다.
- 인프라 레인 안에서는 카드가 `environment` 순서(prod, stage, qa, dev)로 위에서부터 놓인다.
- deploy-path는 레인을 버킷 → CDN → 도메인 순으로 오른쪽에 붙인다. 산출물이 버킷으로 가는 방향을 따른 것이다. 그래서 요청 방향인 `origin`과 `resolves_to` 선은 오른쪽 카드에서 왼쪽 카드로 그리고 화살촉이 왼쪽을 본다. 서비스에 안 붙는 인프라(에셋 버킷, 꺼 둔 배포)도 여기 선다.
- 서버 레벨의 **외부 서비스** 레인은 이 서버가 클라이언트로 부르는 쪽(다른 서버, 엔드포인트, 게이트웨이)이다. 테이블과 저장소는 그보다 오른쪽 맨 끝 **DB** 레인에 모은다. 고른 노드가 게이트웨이면 게이트웨이 → API 순서다.

레인 제목은 카드 칩의 종류 이름과 같은 말을 쓴다 (`src/architecture/kind-text.ts`의 `LANE_TITLES`, `NODE_KIND_SHORT`).

### 구간

종류별 레인은 서버가 둘이어도 한 열에 겹쳐 세운다. 요청이 앱에서 줄서기 서버로, 거기서 알림 서버로, 다시 DB로 가는 순서를 보이려면 세션이 `stages`로 구간을 정한다. 구간이 있으면 위 표 대신 레인 하나가 구간 하나가 되고 레인 제목이 구간 이름이 된다. 전체 레벨과 드릴다운 레벨, 평면 그림이 같은 구간을 쓴다.

```json
"stages": [
  { "id": "app", "label": "앱", "kinds": ["service", "micro_app", "feature", "screen"] },
  { "id": "queue", "label": "줄서기 서버", "kinds": ["endpoint", "app_module"], "repos": ["api"] },
  { "id": "notify", "label": "알림 서버", "kinds": ["endpoint", "app_module"] },
  { "id": "db", "label": "DB", "kinds": ["db_table", "datastore"] }
]
```

- 노드는 자기 id가 `nodes`에 오른 구간에 먼저 들어간다. 없으면 `kinds`가 맞는 첫 구간에 들어가는데, `repos`를 준 구간은 레포까지 맞아야 한다.
- 어느 구간에도 안 맞은 노드는 맨 끝 **그 밖** 구간에 모인다. 그 수가 render 응답의 `unstagedNodes`로 돌아온다.
- 구간 순번이 elk 열 순위의 앞자리가 된다 (`src/architecture/layout.ts`의 `assignStages`). 구간 안에서는 원래 종류 순서가 그대로 남는다. 구간 순서가 요청 방향과 반대면 선이 왼쪽으로 꺾여 돌아간다.
- 분석 둘을 합치면 같은 id 구간은 하나로 묶는다. 한쪽이 `repos`를 안 줬으면 합친 구간도 레포를 가리지 않는다.

### 카드와 위쪽 바

카드는 레고 브릭처럼 그린다. 바탕은 종류 색을 옅게 섞은 파스텔이다. 밝은 테마는 흰색에 24%, 어두운 테마는 카드 바탕에 44%를 섞는다. 위에는 돌기 네 개를 올리고 아래에는 3px 두께를 붙인다. 돌기와 두께, 테두리는 종류 색을 조금 더 섞은 같은 색이고 흐린 그림자는 안 쓴다. 글자는 원래 글자색 그대로라 진한 바탕에 흰 글자를 올릴 때처럼 대비를 따로 맞출 일이 없다. 축소해서 글자가 안 읽혀도 색 덩어리만으로 종류가 갈린다. 카드 안 배지는 파스텔 위에서 묻히지 않게 꽉 채운다. 흐름 배지는 강조색 바탕에 흰 글자이고 아래에 작은 두께가 붙는다. "추정" 배지는 경고색 바탕이다. 흐름 그림의 단계 카드도 같은 브릭이고 정상 흐름은 파랑, 옆 흐름은 호박색이다.

노드에 `description`이 있으면 이름 줄 밑에 설명 한 줄이 붙는다. 한 줄을 넘으면 말줄임표로 자르고 전체 문장은 카드 툴팁과 서랍에서 보인다. 설명이 없거나 공백뿐이면 빈 줄을 남기지 않는다. 서버가 카드 높이를 잴 때 설명 줄 18px를 더하고 (`src/architecture/layout.ts`의 `NODE_DESC_LINE`) 카드 폭도 설명 길이만큼 넓히되 안쪽 폭 200px에서 멈춘다. 설명 하나 때문에 열 전체가 끝없이 넓어지지 않게 하려는 것이다. 두 노드 화면처럼 브라우저가 좌표를 내는 화면도 같은 값을 쓴다.

카드 맨 위에는 종류 칩이 붙는다. 칩은 종류별 아이콘과 짧은 이름(서비스, 기능 영역, 화면, 게이트웨이, API, 서버, 클라이언트, DB, 트리거, 빌드, 산출물, 배포 대상, 도메인, CDN, 버킷, 계정)이다. 종류마다 색도 다르지만 색만으로 구분하지 않는다. 색을 못 가리는 사람도 칩 글자로 종류를 읽는다. 한 단계 안으로 들어갈 수 있는 카드에는 오른쪽에 `›`가 붙는다.

서비스 카드에는 플랫폼 칩(웹 또는 웹(SSR), AOS, iOS)이 붙는다. 웹 아이콘은 브라우저 창이고 AOS와 iOS는 Android 로봇 머리와 Apple 로고를 브랜드 색으로 채워 그린다. Android는 초록이고 Apple은 밝은 화면에서 검정, 어두운 화면에서 흰색이다. 로고 모양은 simple-icons에서 가져왔다. Android 로봇은 Google이 CC BY 3.0으로 푼 그림이라 출처를 여기 적어둔다.

저장소 카드는 엔진을 알면 종류 칩의 원통 아이콘 대신 그 엔진 로고를 브랜드 색으로 그린다. MySQL, MariaDB, PostgreSQL, Redis, Elasticsearch, MongoDB, DocumentDB, DynamoDB를 안다. 엔진은 `engine`을 먼저 보고 없으면 `label`에서 찾는다. `aurora-mysql:<식별자>`처럼 관리형 서비스 이름이 앞에 붙어도 이름 안에 `mysql`이 있으면 MySQL이다. 모르는 엔진은 원통 아이콘 그대로다. MySQL 로고는 돌고래 아래 글자가 작은 칩에서 뭉개져서 돌고래만 그린다. 로고 뒤에는 작은 흰 바탕을 깐다. 붉은 저장소 칩 위에서 파란 로고가 흐려져서다. 바탕이 늘 흰색이라 어두운 화면에서도 밝은 화면 색을 그대로 쓴다. 칩마다 `aria-label`과 `title`에 "웹", "SSR 웹 (서버 렌더)", "Android 앱", "iOS 앱"이 들어간다. 정적 웹과 서빙 방식을 모르는 웹은 둘 다 "웹"이다. 패널에는 서빙 서버 목록이 따로 나온다. prod 도메인이 닿는 서비스는 카드 둘째 줄에 그 도메인을 쓴다.

마이크로 프론트엔드 앱 카드의 칩은 호스트면 "호스트", 리모트면 "리모트"다. 앱 카드에도 자기 사슬로 판정한 웹 칩과 도메인이 붙는다. 서비스 카드는 진입 앱 것을 그대로 쓴다. 전체 레벨에서 서비스와 앱을 감싼 테두리는 카드가 아니라서 누를 수 없다.

계정이 다른 두 노드를 잇는 선은 다른 색이다. 그런 선이 있는 그림에서만 범례에 "색 선" 줄이 나온다.

screen-chain 제목은 "화면별 호출 흐름"이다. 화면이 하나도 없으면 하네스 그림으로 보고 바꾼다. 스킬이 있으면 "스킬별 호출 흐름", 스킬도 없고 MCP 도구만 있으면 "MCP 도구 호출 흐름"이다 (`src/architecture/html-renderer.ts`의 `viewTitle`). `packs`를 적었는데 `web-product`가 없으면 노드 없이 흐름만 있을 때 "업무 흐름", 그 밖에는 "구성 요소 연결"이다.

위쪽 바에는 왼쪽부터 제목, 빵부스러기(드릴다운일 때), 포커스 표시가 있고 오른쪽에 도구가 모여 있다.

| 도구                 | 하는 일                                                                                                   | 키       |
| -------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| **포커스**           | 고른 카드가 있을 때만 보인다. [포커스](#포커스) 화면으로 바꾼다                                           | `F`      |
| 이름으로 찾기        | 지금 보이는 화면의 카드만 찾는다. 찾은 수가 옆에 나오고 Enter로 다음 카드, Shift+Enter로 앞 카드로 옮긴다 | `/`      |
| 작게 보기, 크게 보기 | 가운데를 기준으로 줄이고 키운다. 사이에 배율이 나온다                                                     | `-`, `+` |
| **맞춤**             | 그림 전체를 화면에 맞춘다                                                                                 | `0`      |
| **범례**             | 선 모양(실선, 점선, 묶음 선)과 이 그림에 나온 종류의 칩을 보여준다                                        |          |
| **확인할 질문**      | 미해결 질문 목록과 건수. 질문을 누르면 그 노드가 있는 레벨로 가서 카드를 고른다                           |          |
| **질문별 그림**      | 그려진 [질문별 그림](#질문별-그림)이 있을 때만 보인다. 그림 목록을 열고 고르면 그 레벨로 간다            |          |
| 테마                 | 밝은 화면과 어두운 화면을 바꾼다                                                                          |          |

테마는 처음에 시스템 설정을 따른다. 토글로 바꾸면 그 값을 브라우저 `localStorage`에 남겨 다음에 열 때도 쓴다. 남긴 값이 없으면 시스템 설정이 바뀔 때 함께 바뀐다.

### 조작

- 노드를 누르면 오른쪽에 상세 패널이 열린다. 패널에는 종류와 레포, 이름, 설명, **이 종류는**, 연결 목록, **출처** 목록이 있다. **이 종류는**은 그 종류가 무엇인지 한두 문장으로 풀어 쓴 것이다. 팩의 `about`에서 오고 없으면 종류 이름으로 문장을 맺는다. 연결 목록은 **들어오는 연결**과 **나가는 연결**로 나뉘고 항목마다 건너편 노드 이름과 선 종류가 붙는다. 항목을 누르면 그 노드로 옮겨 간다. 환경 필터로 숨긴 노드는 목록에서도 빠진다. 인프라 노드면 환경과 계정이, 서비스면 환경별 도메인 목록과 플랫폼별 근거가 함께 나온다. `live` 출처는 실행한 명령과 조회 시각을 보여준다. 들어갈 레벨이 있으면 **상세보기** 버튼이, 포커스할 수 있으면 **포커스** 버튼이 함께 뜬다. 더블클릭하면 상세보기를 누른 것처럼 바로 들어간다. 위쪽 빵부스러기로 위 레벨에 돌아간다.
- 일반 선을 누르면 선 패널이 열린다. 선 종류와 그 종류가 무엇을 잇는지, 실선인지 점선인지, 계정을 넘는지, MCP action이 나오고 양 끝 노드 단추와 출처가 이어진다. 드릴다운이 만든 포함 선(`contains`)은 parent로 정한 관계라 출처 자리에 따로 근거가 없다는 문장이 나온다. 묶음 선은 전처럼 두 노드 화면이나 세부 엣지로 간다.
- 레인 제목을 누르면 레인 패널이 열린다. 레인 이름과 그 칸에 무엇이 서는지, 그 칸에 있는 카드 목록이 나온다. 카드를 누르면 그 카드를 고른다. 세션이 정한 구간(`stage:` 레인)은 구간 설명 한 문장이 대신 나온다.
- 카드와 선, 레인 제목은 Tab으로 옮겨 가고 Enter나 스페이스로 연다. 선과 레인 제목에도 `role="button"`과 `aria-label`이 붙는다. 레인 제목의 `aria-label`은 "<이름> 레인, 카드 N개"이고 환경 필터를 바꾸면 숫자도 따라 바뀐다.
- 환경이 둘 이상 나오는 그림이면 상단에 환경 버튼(prod, stage, qa, dev 순)이 뜬다. 처음엔 prod만 켜져 있고 누를 때마다 그 환경이 켜지고 꺼진다. 하나는 늘 켜져 있어야 해서 마지막 하나는 안 꺼진다. 고르지 않은 환경의 카드와 거기 걸린 선은 숨고 레인 제목 숫자도 보이는 카드만 센다. 자리는 서버가 낸 좌표 그대로다. prod가 열 맨 위 줄이라 prod만 남겨도 빈 자리가 안 생긴다. 포커스와 검색도 숨은 카드는 건너뛴다. 고른 환경은 주소 해시에 같이 실린다(아래 주소 해시 설명). 전체 레벨은 원래 prod만 올리므로 이 버튼과 상관없다.
- 전체 레벨에서 Shift나 ⌘를 누른 채 두 번째 노드를 누르면 두 노드 사이 경로를 경유지까지 펼친다. 화면 → 게이트웨이(사슬 순서) → 엔드포인트 → 모듈 → 클라이언트 → 게이트웨이 → 받는 모듈 → 테이블 순서의 열로 놓고 세부 엣지 표를 함께 보여준다. 경로가 없으면 "두 항목은 서로 이어져 있지 않아요."라고 나온다.
- 경로는 중간에 게이트웨이(몇 단이든)와 모듈 하나까지만 지난다. 출발이 모듈이면 중간 모듈 없이 게이트웨이만 지난다. 화면에서 모듈 하나를 지나 클라이언트로 다른 모듈에 닿는 데까지가 한 요청 흐름이다. 그보다 멀리 돌아가는 길까지 펼치면 두 노드와 상관없는 엔드포인트가 쏟아진다.
- 전체 레벨의 묶음 엣지를 누르면 두 노드를 고른 것과 같은 화면이 뜬다. 다른 레벨에서 묶음 엣지를 누르면 그 묶음의 세부 엣지만 보여준다.
- 지금 보는 화면은 주소 해시에 실린다. 전체는 `#/`, 레벨은 `#/level/<레벨 id>`, 두 노드 화면은 `#/pair/<노드 a>/<노드 b>`, 묶음 세부는 `#/bundle/<레벨 id>/<묶음 id>`, 포커스는 `#/focus/<레벨 id>/<노드 id>`이고 id는 `encodeURIComponent`로 감싼다. 질문별 그림 `checkout`이면 `#/level/view%3Acheckout`이다. 그래서 브라우저 뒤로가기와 앞으로가기, 새로고침이 그 화면으로 돌아온다. 주소를 복사해 보내면 같은 HTML 파일을 가진 사람에게 같은 화면이 열린다. 모르는 주소면 기록을 남기지 않고 전체로 바꾼다. 환경 버튼을 처음 상태와 다르게 고르면 해시 뒤에 `?env=prod,dev`처럼 켠 환경이 붙는다. 처음 상태 그대로면 안 붙는다. 환경을 바꾸는 건 기록을 남기지 않고 지금 주소만 고치므로 뒤로가기는 레벨을 오간 길만 되짚는다. 없는 환경 이름만 적힌 주소는 처음 상태로 열고 주소에서도 뺀다. 평면 그림에는 레벨이 `root` 하나뿐이라 `#/`와 `#/focus/root/<노드 id>`만 쓴다.

레벨마다 좌표는 `computeGraphLayout`(`src/architecture/layout.ts`)이 따로 낸다. IR 노드가 아닌 일반 노드와 엣지 목록을 받으므로 묶음 엣지도 그대로 넣는다. 정렬은 전부 id 기준이라 [결정적 렌더](#결정적-렌더) 성질이 그대로 유지된다.

### 포커스

카드가 수십 장인 레벨에서 노드 하나와 이어진 것만 보고 싶을 때 쓴다. 고른 노드에서 화살표를 따라 내려가 닿는 노드 전부(하류)와 고른 노드로 들어오는 선을 거슬러 올라가 닿는 노드 전부(상류)를 남기고 나머지 카드를 숨긴다. 선은 위아래로 따라가며 밟은 것만 남는다.

하류로 내려갔다가 다시 상류로 꺾는 길은 타지 않는다. 화면 A에서 게이트웨이로 내려간 뒤 그 게이트웨이를 부르는 화면 B로 거슬러 올라가지 않는다는 뜻이다. 이 길까지 타면 같은 게이트웨이를 쓰는 다른 앱이 전부 딸려 와서 숨긴 의미가 없어진다. 계산은 `src/architecture/focus.ts`의 `focusSet`이다.

남은 카드는 레벨에 그려 둔 자리에서 가져온다 (`focusLayout`). x는 그대로 두고 같은 열 안에서 원래 위아래 순서대로 위에서부터 다시 쌓는다. 그래서 레인 자리와 카드 순서가 원래 그림과 같다. 카드가 하나도 안 남은 레인은 숨긴다. 고른 노드 카드는 따로 강조한다. 합친 그림의 [제품 띠](#제품-띠)도 포커스에서 그대로 쌓는다. 마이크로 프론트엔드 테두리는 남은 카드 중 그 묶음 카드가 둘 이상일 때만 다시 그린다. 남은 카드가 띠 하나에만 있으면 띠 없이 쌓는다.

- **들어가기**: 카드를 고른 뒤 상세 패널의 **포커스** 버튼이나 위쪽 바의 **포커스** 버튼을 누르거나 `F` 키를 누른다. 버튼은 지금 레벨에 그 카드가 있을 때만 보이고 두 항목 화면과 묶음 세부 화면에서는 안 뜬다.
- **보이는 것**: 위쪽 바에 `포커스: <이름>` 표시와 ✕ 버튼이 뜬다.
- **나가기**: ✕를 누르거나 ESC를 누르면 원래 레벨로 돌아간다. ESC는 열린 팝오버, 상세 패널, 포커스 순서로 하나씩 닫는다. 브라우저 뒤로가기로도 나간다.
- **다른 노드로 옮기기**: 포커스 화면에서 다른 카드를 고르고 다시 포커스하면 같은 레벨에서 그 노드 기준으로 바뀐다. 주소 기록이 하나 더 쌓이므로 뒤로가기로 앞 포커스에 돌아온다.
- **안으로 들어가기**: 포커스 화면에서 **상세보기**나 더블클릭으로 들어가면 들어간 레벨은 포커스 없이 전체가 보인다. 뒤로가기를 누르면 포커스 화면으로 돌아온다.
- **두 항목 선택과 함께 쓰기**: 전체 레벨을 포커스한 화면에서도 Shift나 ⌘를 누른 채 두 카드를 고르면 두 항목 화면이 뜬다. 묶음 엣지를 누르는 것도 원래 레벨에서와 같다.
- **검색**: 이름으로 찾기는 포커스 화면에 남은 카드만 찾는다.
- **평면 그림**: 드릴다운이 아닌 평면 그림(deploy-path 포함)에서도 같은 규칙으로 동작한다. 평면 그림의 레벨 id는 `root`다.

---

## 도메인 흐름

기술 그림은 화면이 어느 API를 부르는지 보여주지만 손님이 줄을 서고 직원이 호출하고 시스템이 알림을 보내는 순서는 안 보인다. 흐름은 그 순서를 사람 쪽에서 그린다. 서비스 하나에 흐름을 여럿 둘 수 있다 (`ir.flows`, 선택). 서비스에 안 딸린 흐름도 된다 ([서비스 없는 흐름](#서비스-없는-흐름)).

```json
{
  "id": "queue",
  "service": "svc-shop",
  "title": "줄서기",
  "stateLabels": { "WAITING": "대기", "CALLED": "호출" },
  "actors": [
    { "id": "guest", "label": "손님", "kind": "person" },
    { "id": "staff", "label": "매장 직원", "kind": "person" },
    { "id": "sys", "label": "자동 발송", "kind": "system" }
  ],
  "steps": [
    {
      "id": "st-register",
      "actor": "guest",
      "label": "줄서기 등록",
      "state": "WAITING",
      "refs": ["s-queue", "ep-register"],
      "evidence": [
        { "type": "code", "location": "acme-web:src/queue/register.tsx:12", "visibility": "public" }
      ]
    },
    {
      "id": "st-call",
      "actor": "staff",
      "label": "호출",
      "state": "CALLED",
      "evidence": [
        { "type": "code", "location": "acme-api:src/queue/call.ts:30", "visibility": "public" }
      ]
    }
  ],
  "transitions": [
    {
      "id": "t-1",
      "from": "st-register",
      "to": "st-call",
      "path": "main",
      "lineStyle": "solid",
      "evidence": [
        { "type": "code", "location": "acme-api:src/queue/call.ts:41", "visibility": "public" }
      ]
    }
  ]
}
```

| 필드          | 내용                                                                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stateLabels` | 상태 값마다 그림에 찍을 이름. `state`는 코드의 enum 그대로라 사용자 언어로 된 이름을 여기 단다. 구간 머리와 단계 칩에 이 이름이 나오고 단계 서랍에는 `대기 (WAITING)`처럼 둘 다 나온다. 이름이 없는 상태는 상태 값 그대로 찍는다                                                                           |
| `service`     | 이 흐름이 딸린 `service` 노드 id. 적으면 그 서비스 레벨 아래에 흐름 레벨이 선다. 안 적으면 독립 흐름이다                                                                                                                                                                                                  |
| `actors`      | 가로줄 하나씩. `kind`는 `person`(손님, 직원), `system`(예약 발송, 배치), `agent`(서브에이전트) 중 하나다. 적은 순서대로 위에서부터 놓인다                                                                                                                                                                  |
| `steps`       | 카드 하나씩. `state`는 그 단계를 지나면 바뀌는 상태값이다. `refs`는 기술 그림의 `screen`, `endpoint`, `feature`, `micro_app`, `skill`, `agent`, `component` 노드 id다. `terminal`은 흐름이 여기서 끝날 수 있다는 표시다. 카드에 "끝" 칩이 붙고 단계 서랍에 "다음" 줄이 나온다                                                             |
| `transitions` | 단계 사이 화살표. `path`는 정상 흐름이면 `main`, 취소나 노쇼처럼 옆으로 빠지면 `side`다. `label`에 조건을 적는다. `actors`는 그 전이를 일으키는 행위자 id 목록이다. 되돌리기처럼 여럿이 할 수 있는 전이에 달고 선 글자 옆에 이름이 붙는다 (괄호 앞까지만). 없는 행위자를 가리키면 `FLOW_ACTOR_NOT_FOUND`다 |

선 모양 규칙은 엣지와 같다. 상태를 바꾸는 코드를 봤으면 `code` 근거에 실선이다. 기획서나 지식베이스에만 있으면 `doc` 근거에 점선이다. 기획서에만 있고 코드에 없는 단계도 넣는다. 그 단계 카드는 테두리가 점선이다. 기획서와 코드가 다르게 말하면 둘 다 근거로 달고 차이를 `stepId`나 `transitionId`를 단 질문으로 남긴다. 기획서는 의도이고 코드는 동작이라 어느 쪽이 맞는지는 사람이 정해야 한다.

하네스 흐름은 사용자가 `person`, MCP 서버가 `system`, 세션 모델과 서브에이전트가 `agent`다. 인터뷰 → 스펙 → 실행 → 리뷰처럼 파이프라인 하나를 흐름 하나로 그린다. 세션이 도구를 두 번 불러 결과를 넘기는 2-Call Passthrough는 세션 모델 줄과 MCP 서버 줄을 오가는 지그재그 단계로 그린다. 시퀀스 다이어그램을 따로 두지 않는 건 단계 카드가 `refs`로 스킬과 도구 카드에 건너가야 해서다.

### 서비스 없는 흐름

환불 승인이나 장애 대응처럼 코드 서비스에 안 딸린 업무 절차도 흐름으로 그린다. `service`를 비우면 전체 바로 아래 독립 흐름 레벨(`flow:<흐름 id>`)이 된다.

- 근거는 위키와 담당자 말이라 [문서 묶음 레포](#문서-묶음-레포)를 쓰는 경우가 많다. 이때 선과 카드 테두리는 전부 점선이다.
- 노드 없이 흐름만 있는 IR도 된다. 전체 레벨에 카드가 하나도 없으면 그 자리에 독립 흐름과 질문별 그림으로 가는 링크를 띄운다.
- 그 흐름에 나오는 조직과 역할, 시스템이 어디 속하는지까지 그리려면 [process 팩](#process-팩)으로 노드를 함께 싣는다.

### 배치

elkjs를 안 쓰고 격자로 놓는다 (`src/architecture/flow-layout.ts`). 행위자 줄과 단계 열이 곧 읽는 순서라 자동 배치가 오히려 그 순서를 흐트러뜨린다.

- 열은 전이를 따라 가장 긴 경로로 정한다. 왼쪽으로 돌아가는 전이(되돌리기)는 열 계산에서 뺀다.
- 되돌아가는 선은 두 카드 중 위쪽 카드 바로 위 빈 줄이나 아래쪽 카드 바로 아래 빈 줄로 건넌다. 다른 카드를 뚫거나 다른 선과 같은 줄을 겹쳐 쓰면 드나드는 자리를 옮겨 본다. 그래도 막히면 그림 맨 아래 여백으로 돌린다. 모서리를 둥글리고 선 글자 앞에 ↩를 붙여 앞으로 가는 직각 선과 모양으로 갈린다.
- 정상 흐름 단계가 행위자 줄의 첫 줄에 선다. 옆 흐름 단계는 그 아래 줄로 내려간다. 같은 칸이 겹치면 한 줄 더 내린다.
- 정상 흐름 단계에 `state`가 있으면 상태 값 순서로 열을 묶어 구간을 나누고 위에 상태 이름(`stateLabels`에 없으면 상태 값)을 붙인다. 상태가 없는 단계(알림 발송 같은)는 앞 단계의 구간에 붙는다. 상태 값이 하나도 없으면 구간 없이 그린다.
- 옆 흐름 단계는 갈라져 나온 단계 바로 다음 열에 선다. 맨 끝에 모으면 옆으로 빠지는 선이 그림을 가로질러 길어져서다. 정상 흐름 마지막 열 너머로 나간 것만 맨 끝 **옆 흐름** 구간을 받는다. 상태 값이 없거나 열 머리와 같은 옆 흐름 카드만 있으면 정상 흐름 줄은 옆 흐름 때문에 밀리지 않는다.
- 상태 값이 있는 옆 흐름 카드가 그 자리 열 머리(구간)의 상태 값과 다르면 배치가 달라진다. 그 카드가 갈라져 나온 구간 바로 뒤에 **옆 흐름** 구간을 끼우고 그 구간에서 갈라져 나온 옆 흐름 단계를 전부 거기 세운다. 옆 흐름이 몇 단계 이어지면 그 수만큼 열을 받고 뒤 구간의 정상 흐름 열은 그만큼 오른쪽으로 밀린다. 열 머리가 카드 상태를 잘못 알려주지 않게 하려는 것이다. 예전에는 변경 요청 카드가 머지됨 머리 밑에 서기도 했다. 대신 옆 흐름이 많은 큰 흐름은 가로로 넓어진다.
- 옆 흐름 화살표와 카드는 정상 흐름과 다른 색으로 그린다. 화살표는 카드 위나 아래에서 바로 꺾어 나간다. 오른쪽 변으로 나가면 정상 흐름 선과 같은 꺾임 자리를 겹쳐 쓴다.

### 조작

- **들어가기**: 흐름이 달린 서비스 카드는 이름 옆에 **흐름** 배지가 붙는다. 전체보기에서도 보인다. 흐름이 하나면 배지를 눌러 바로 들어간다. 여럿이면 상세 패널이 열리고 흐름 목록에서 고른다. 서비스 레벨 안에서는 위쪽 바의 **흐름** 버튼으로도 들어간다. 독립 흐름은 전체 레벨의 **흐름** 버튼으로 들어간다.
- **단계 카드**: 누르면 행위자, 상태, 근거와 함께 `refs` 버튼이 뜬다. 버튼을 누르면 그 노드가 있는 서비스 레벨로 가서 노드를 고른다.
- **거꾸로 오기**: 기술 그림의 노드 패널에 그 노드를 `refs`로 가진 단계가 나온다. 누르면 흐름 레벨로 돌아온다.
- **전이**: 화살표를 누르면 조건과 근거가 뜬다.
- 흐름 레벨에서는 포커스를 쓰지 않는다. 흐름이 이미 한 서비스의 한 이야기라서다.

미해결 질문 목록은 질문의 `stepId`나 `transitionId`로 단계 카드를 찾아간다. 전이 질문은 그 전이가 시작하는 단계 카드에 배지로 붙는다.

---

## 질문별 그림

뷰는 "무엇이 무엇에 붙어 있나"를 보여주는 지도다. 그런데 사람이 실제로 묻는 건 "결제를 누르면 누가 무엇을 어떤 순서로 주고받나"나 "주문 데이터는 어디서 와서 어디로 가나" 같은 질문 하나다. 지도에서 그 답을 찾으려면 카드를 직접 따라가야 한다. 질문별 그림은 그 답만 따로 그린다 (`projections`).

질문별 그림은 뷰가 아니다. 지도의 노드와 엣지를 id로 가리켜 다시 그린 그림이라 같은 IR, 같은 HTML에 들어간다. 그래서 지도에 없는 노드나 엣지는 가리킬 수 없다. 지도에 빠진 사실이면 먼저 지도에 근거와 함께 넣고 그다음 가리킨다.

```json
{
  "projections": [
    {
      "id": "checkout",
      "shape": "sequence",
      "title": "결제 승인 순서",
      "question": "앱에서 결제를 누르면 누가 무엇을 어떤 순서로 주고받나요?",
      "participants": ["app", "api", "pg"],
      "blocks": [{ "id": "b-result", "kind": "alt", "label": "승인 결과" }],
      "messages": [
        { "id": "m1", "from": "app", "to": "api", "label": "POST /orders/pay", "edge": "e-app-api", "evidence": [], "lineStyle": "solid" },
        { "id": "m2", "from": "api", "to": "api", "label": "금액 검증", "evidence": [{ "type": "doc", "location": "wiki:pay#2", "visibility": "public" }], "lineStyle": "dashed" },
        { "id": "m3", "from": "pg", "to": "api", "label": "승인됨", "edge": "e-api-pg", "evidence": [], "lineStyle": "solid", "reply": true, "block": "b-result", "branch": "승인" }
      ]
    }
  ]
}
```

| 필드           | 내용                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `id`           | 소문자, 숫자, 하이픈만 쓴다. 저장 파일 이름과 레벨 id에 들어간다                                        |
| `shape`        | `sequence`, `dataflow`, `compare` 중 하나. 아래 [모양](#모양)에서 설명한다                              |
| `title`        | 그림 제목. 위쪽 바의 그림 목록과 레벨 제목에 나온다                                                     |
| `question`     | 이 그림이 답하는 질문 원문                                                                              |
| `participants` | 선택. sequence에서 세로줄 순서다. 적으면 메시지 양 끝이 전부 이 안에 있어야 한다. 안 적으면 처음 나온 순서를 쓴다 |
| `messages`     | 주고받는 것 하나하나. 아래 표에서 설명한다                                                              |
| `blocks`       | 선택. sequence에서 메시지 여러 개를 묶는 상자다. `{ id, kind, label }`                                 |
| `sides`        | compare에서 견줄 두 묶음이다. `{ id, label, nodes[] }`                                                 |

`blocks[].kind`는 넷이다. `alt`는 경우에 따라 하나만 도는 묶음, `opt`는 조건이 맞을 때만 도는 묶음, `loop`는 되풀이, `par`는 동시에 도는 묶음이다. 한 묶음에 든 메시지는 이어 붙어 있어야 한다. 사이에 다른 메시지가 끼면 `PROJECTION_BLOCK_SPLIT`이다.

메시지 필드다.

| 필드        | 내용                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `id`        | 투영 전체에서 겹치면 안 된다. 다른 투영의 메시지 id와도 다르게 쓴다                                   |
| `from`, `to` | 노드 id. 같으면 자기 호출이다                                                                         |
| `label`     | 화살표 위 글자                                                                                         |
| `edge`      | 선택. 이 메시지가 지도의 어느 엣지를 타는지. 그 엣지가 같은 두 노드를 이어야 한다. 방향은 상관없다   |
| `evidence`  | 이 메시지만의 근거. `edge`를 적었으면 비워도 된다                                                     |
| `lineStyle` | `solid`나 `dashed`. 실선인데 코드나 스펙 근거가 없으면 `SOLID_MESSAGE_WITHOUT_EVIDENCE`다. 통과하면 render가 근거로 다시 계산한다 |
| `reply`     | 선택. 응답이면 `true`. 끝이 열린 화살표로 그린다                                                       |
| `block`     | 선택. 이 메시지가 든 `blocks[].id`                                                                     |
| `branch`    | 선택. `alt` 안에서 이 메시지가 속한 경우 이름. 경우가 바뀌는 자리에 가로 점선을 긋는다                 |

### 메시지 근거

메시지의 근거는 자기 `evidence`에 가리킨 엣지의 근거를 더한 것이다. 그래서 지도에 근거 달린 엣지를 가리키면 메시지에 근거를 따로 안 적어도 된다. 선 모양은 [근거와 선 모양](#근거와-선-모양)의 규칙을 그대로 탄다. 코드나 스펙 근거가 있으면 실선, 문서나 사람 말뿐이면 점선이다.

근거가 하나도 없는 메시지는 그리지 않는다. 대신 `auto:message:<메시지 id>` 질문이 생기고 `subject.messageId`가 그 메시지를 가리킨다. 양 끝 노드 중 하나라도 그려지지 않는 노드면 그 메시지도 빠진다.

### 모양

| 모양       | 답하는 질문                       | 쓰는 필드                                      | 못 쓰는 필드                                       |
| ---------- | --------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `sequence` | 누가 무엇을 어떤 순서로 주고받나  | `participants`, `messages`, `blocks`           | `sides`                                            |
| `dataflow` | 데이터가 어디서 와서 어디로 가나  | `messages`                                     | `sides`, `blocks`, 메시지의 `reply`, `block`, `branch` |
| `compare`  | 두 묶음이 무엇이 같고 무엇이 다른가 | `sides` 정확히 둘. 두 `id`는 달라야 한다      | `messages`, `blocks`                               |

못 쓰는 필드를 쓰면 `PROJECTION_SHAPE_FIELD`다. sequence와 dataflow에 메시지가 하나도 없으면 `PROJECTION_EMPTY`다.

모양마다 배치가 다르다. 셋 다 지도의 elkjs 배치를 쓰지 않는다.

- **sequence**: 고정 격자다. 노드마다 세로줄이 서고 메시지가 위에서 아래로 차례대로 놓인다. 세로줄 순서는 `participants`를 따르고 없으면 처음 나온 순서다. IR의 `repos`가 둘 이상이면 세로줄 머리 카드 둘째 줄에 그 노드가 있는 레포 이름을 적는다. MCP 도구(`mcpServer`가 있는 `endpoint`)는 어느 레포에 기록됐는지보다 어느 서버의 도구인지가 궁금한 자리라 레포 대신 `<서버 이름> MCP`를 적는다 (`src/architecture/html-renderer.ts`의 `whereFn`). 레포가 하나인 그림은 그대로고 dataflow와 compare에는 아직 안 붙는다. 확대해서 아래로 내려도 머리 카드는 화면 위에 붙어 따라오고 그림 끝에 닿으면 거기서 멈춘다. 머리 카드 뒤에는 띠를 깔아 그 밑을 지나는 선과 글자를 가린다. 확대와 이동이 캔버스 하나에 transform으로 걸려 CSS sticky가 안 먹기 때문에 이동할 때마다 스크립트가 머리 카드를 내린다 (`src/architecture/html-client.ts`의 `stickHeads`).
- **dataflow**: 왼쪽에서 오른쪽으로 흐른다. 되돌아가는 선을 빼고 가장 긴 경로로 열을 정한다. 되돌아가는 선은 카드 아래로 돌아간다. 같은 두 노드 사이에 선이 여럿이면 위아래로 벌린다.
- **compare**: 세 열이다. 왼쪽부터 "첫 묶음에만", "둘 다", "둘째 묶음에만" 순이다. 열 제목은 `sides[].label` 뒤에 "에만"을 붙인다. 열 배경은 가장 긴 열 높이에 맞춘다.

### 들어가기

질문별 그림 하나가 레벨 하나다. id는 `view:<투영 id>`이고 전체 바로 아래에 선다. 투영 id가 `checkout`이면 해시는 `#/level/view%3Acheckout`이다.

- 투영이 있으면 **전체 레벨** 지도 위쪽에 질문별 그림 카드 줄이 선다. 카드 줄은 캔버스 안에 들어가니 지도와 같이 끌리고 확대된다. 줄 위에는 "질문별 그림 N" 제목이 붙는다. 카드마다 모양(순서도, 데이터 이동, 견주기)과 그림 제목, 답하는 질문, 단계 수, 참여 수가 나온다. 단계 수는 그린 메시지 수다. 참여 수는 `participants` 수이고 비어 있으면 메시지 양 끝을 센다. 카드를 누르면 그 그림 레벨(`view:<id>`)로 간다. 그래서 그림이 몇 개 있는지 위쪽 바를 안 눌러도 보인다.
- 위쪽 바의 **질문별 그림** 버튼도 그대로 남는다. 누르면 그림 목록이 열린다. 고르면 그 레벨로 간다.
- 메시지를 누르면 패널에 보내는 쪽, 받는 쪽, 응답 여부, 묶음과 경우, 선 모양, 근거가 나온다. 노드 버튼을 누르면 지도에서 그 카드로 간다.
- 투영이 없는 그림에는 카드 줄과 이 버튼, 관련 스타일, 스크립트를 싣지 않는다. 그래서 질문별 그림을 안 쓰는 IR은 이전과 같은 바이트로 그려진다.

### 따로 저장되는 파일

render는 질문별 그림마다 `views/<view>.<투영 id>.json`을 따로 쓴다 (`saveViews`). 그 그림이 가리킨 노드와 엣지, 관련 질문만 담는다. private 근거의 `excerpt`는 지운다. 다른 세션이 질문 하나의 답만 읽어 갈 때 IR 전체를 열지 않아도 된다.

- 저장한 IR에 없는 투영의 파일은 지운다.
- 투영이 없으면 `views/` 디렉토리를 만들지 않는다.
- 쓴 파일 경로는 render 응답의 `viewPaths`로 돌아온다.

### 재실행과 합치기

재실행 때 새 IR에 투영을 안 적어도 이전 IR의 투영이 이어진다. 단 아래를 모두 지킬 때만이다 (`carryProjections`).

- 투영 id가 이번 실행의 투영과 안 겹친다.
- 메시지 id도 이번 실행의 메시지와 안 겹친다.
- `participants`와 `sides`의 노드가 병합 결과에 다 남아 있다.
- 메시지마다 양 끝 노드가 남아 있고 가리킨 엣지도 같은 두 노드를 잇는 채로 남아 있다.

하나라도 어긋나면 그 투영은 버린다. 반쯤 맞는 그림을 남기면 지도와 어긋난 답을 보여주기 때문이다.

[분석 합치기](#분석-합치기)에서는 입력마다의 투영을 나란히 둔다. 노드와 엣지 id가 바뀌면 투영 안의 참조도 따라가고 투영 id와 메시지 id가 부딪히면 새로 매긴다.

---

## `ges_architecture` MCP 툴

### Actions

| Action            | Description                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `start`           | 이전 실행 요약과 맥락 파일 후보, 스키마 경로, 읽기 전용 판정 단어를 돌려준다                              |
| `filter_tools`    | 도구 이름을 보고 읽기 전용인지 판정해 `allowed`, `denied`, `ambiguous`로 나눈다                           |
| `match_endpoints` | FE 호출과 BE 라우트를 method와 정규화한 경로로 맞춘다. MCP 도구 호출과 팩별 이름 참조(`nameRefs`)도 맞춘다 |
| `validate`        | IR을 검증만 한다. 저장하지 않는다                                                                         |
| `render`          | 검증하고 이전 실행과 병합한 뒤 IR과 HTML 두 개를 저장한다. `service` 노드가 있으면 HTML이 드릴다운이 된다. 질문별 그림이 있으면 그림마다 파일을 하나씩 더 쓴다 |
| `status`          | 두 뷰의 이전 실행 요약을 돌려준다                                                                         |
| `merge`           | 따로 돌린 분석 IR 여럿을 하나로 합친다. 저장도 렌더도 안 한다                                             |
| `scan_docs`       | 문서 레포의 md를 읽어 근거 표시와 구멍, 질문 안내 표, 화면 색인을 뽑고 지식 문서 지도 초안을 쓴다          |
| `link_docs`       | `scan_docs` 결과를 기술 IR에 엮어 지식과 아키텍처 초안을 쓰고 빈 곳, 낡은 곳, 어긋난 곳 신호를 낸다        |
| `stale_docs`      | 바뀐 파일 목록이나 git diff로 손봐야 할 문서를 고른다                                                     |

### Common Parameters

| Parameter  | Type     | Required | Default            | Description                                             |
| ---------- | -------- | :------: | ------------------ | ------------------------------------------------------- |
| `action`   | `string` |    Y     | —                  | 수행할 액션 (위 테이블 참고)                            |
| `repoRoot` | `string` |    N     | 현재 작업 디렉토리 | 그림의 기준 레포. 저장 위치와 상대 `root`의 기준이 된다 |

### `start`

| Parameter | Type                              | Required | Description |
| --------- | --------------------------------- | :------: | ----------- |
| `view`    | `"screen-chain" \| "deploy-path"` |    Y     | 그릴 뷰     |

응답 키는 이렇다.

| 키                    | 내용                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `view`                | 요청한 뷰                                                                                                                                 |
| `previous`            | 이전 실행 요약 `{ generatedAt, nodeCount, edgeCount, unresolvedOpen }`. 처음이면 `null`                                                   |
| `previousSourcesUsed` | 지난 실행의 `sourcesUsed`. 처음이면 `[]`                                                                                                  |
| `contextCandidates`   | 읽어볼 맥락 파일 후보 `{ via, identifier, exists, visibility }[]`. `identifier`는 절대 경로다. [글로벌 맥락 후보](#글로벌-맥락-후보) 참고 |
| `schemaPath`          | IR JSON Schema 파일의 절대 경로                                                                                                           |
| `readOnlyRule`        | `{ allow, deny }`. 읽기 전용 판정 단어 목록                                                                                               |
| `readOnlyCliRule`     | `{ verbs }`. 클라우드 CLI 하위 명령이 시작해야 하는 동사(`list`, `get`, `describe`)                                                       |
| `nextAction`          | `"filter_tools"`                                                                                                                          |
| `instructions`        | 세션이 다음에 할 일 네 줄                                                                                                                 |

### `filter_tools`

| Parameter   | Type       | Required | Description           |
| ----------- | ---------- | :------: | --------------------- |
| `toolNames` | `string[]` |    Y     | 세션에 붙은 도구 이름 |

응답은 `{ allowed, denied, ambiguous }`다. 각각 `string[]`이고 입력 순서를 유지한다. 판정 규칙은 [읽기 전용 도구 걸러내기](#읽기-전용-도구-걸러내기)에 있다.

### `match_endpoints`

| Parameter          | Type                               | Required | Description                              |
| ------------------ | ---------------------------------- | :------: | ---------------------------------------- |
| `feCalls`          | `{ id, method, path, baseUrl? }[]` |   Y\*    | FE 쪽 API 호출                           |
| `beRoutes`         | `{ id, method, path, repo }[]`     |   Y\*    | BE 쪽 라우트 선언                        |
| `prefixCandidates` | `string[]`                         |    N     | FE 경로 앞에 붙는 게이트웨이 prefix 후보 |
| `skillToolCalls`   | `{ id, server?, tool, action? }[]` |   Y\*    | 스킬과 에이전트 문서에서 찾은 MCP 도구 호출 |
| `serverTools`      | `{ id, server, tool, actions? }[]` |   Y\*    | MCP 서버 코드에서 찾은 도구 등록         |
| `nameRefs`         | `{ matcher, refs: { id, name }[], decls: { id, name }[] }` | Y\* | 팩 matcher로 맞출 이름 참조와 선언 |

\* `feCalls`와 `beRoutes` 짝, `skillToolCalls`와 `serverTools` 짝, `nameRefs` 중 하나는 있어야 한다. 셋 다 없으면 `MISSING_INPUT`이다. 여럿을 함께 넘겨도 된다.

경로 변수 표기(`{id}`, `:id`, `${expr}`, `<int:id>`, `[id]` 등)는 이름과 무관하게 전부 `{}`로 맞춘 뒤 비교한다. 절대 URL의 스킴과 호스트, 쿼리 문자열, 끝 슬래시도 걷어낸다. method가 `*`, `ANY`, `ALL`인 라우트는 어떤 method로 불러도 받는다.

FE 경로는 그대로 한 번 비교한다. `baseUrl`의 경로 부분과 `prefixCandidates`를 각각 떼어낸 경로로도 따로 비교한다. 떼지 않은 경로로 맞은 쪽이 먼저다.

응답은 `{ matches, unmatched }`다.

| 키          | 꼴                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `matches`   | `{ feCallId, beRouteId, viaPrefix }[]`. prefix 없이 맞았으면 `viaPrefix`는 `null`                          |
| `unmatched` | `{ feCallId, reason, candidates }[]`. `reason`은 `no_route`, `ambiguous_prefix`, `multiple_routes` 중 하나 |

`unmatched`는 눈으로 맞춰 실선을 긋지 않는다. `candidates`를 담아 미해결 질문으로 남긴다.

MCP 짝을 넘기면 응답에 `tools: { matches, unmatched }`가 붙는다 (`src/architecture/mcp-tool-match.ts`).

| 키                | 꼴                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `tools.matches`   | `{ callId, toolId, action }[]`. 호출에 action이 없었으면 `action`은 `null`                                          |
| `tools.unmatched` | `{ callId, reason, candidates }[]`. `reason`은 `no_tool`, `multiple_tools`, `unknown_action` 중 하나               |

도구 이름은 정확히 같아야 맞는다. 이름이 비슷하다고 잇지 않는 건 HTTP 경로 매칭과 같은 이유다. 클라이언트가 붙이는 `mcp__<서버>__<도구>` 접두는 걷어내고 서버 힌트로 쓴다. 플러그인으로 깔린 서버는 `plugin_<플러그인>_<서버>`로 불리는데 이 힌트는 `<서버>`와 맞는다. 도구에 `actions`가 있으면 호출의 `action`이 그 안에 있어야 하고 없으면 `unknown_action`이다. 여기서도 `unmatched`는 실선을 긋지 않고 질문으로 돌린다.

`nameRefs`를 넘기면 응답에 `refs: { matcher, matches, unmatched }`가 붙는다 (`src/architecture/name-ref-match.ts`의 `matchNameRefs`). HTTP 경로나 MCP 도구가 아닌 이름 참조를 선언에 잇는 자리다. `matcher`는 팩의 `matchers` 필드에 든 이름 중 하나를 고른다.

| 키                | 꼴                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `refs.matches`    | `{ refId, declId }[]`                                                                               |
| `refs.unmatched`  | `{ refId, reason, candidates }[]`. `reason`은 `no_decl`, `multiple_decls` 중 하나                   |

matcher마다 참조와 선언을 같은 비교 키로 바꾼 뒤 키가 같은 것끼리 잇는다.

| matcher       | 팩        | 비교 키                                                                                                                                                                                                                       |
| ------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name-ref`    | `generic` | 앞뒤 공백만 걷고 대소문자를 안 가리고 그대로 비교한다                                                                                                                                                                         |
| `iac-ref`     | `infra`   | `${...}` 껍데기를 벗긴다. terraform 참조는 앞 두 마디(`type.name`)로 본다. `data.`로 시작하면 앞 세 마디, `module.`이면 앞 두 마디다. 마디 끝 `[...]` 인덱스는 뗀다. 점 없이 `Kind/name` 꼴이면 쿠버네티스 참조로 보고 kind만 소문자로 맞춘다 |
| `dataset-io`  | `data`    | dbt `ref('x')`는 `x`, `source('s','t')`는 `s.t`로 바꾼다. SQL 따옴표와 백틱과 대괄호를 걷고 소문자로 맞춘다                                                                                                                   |
| `state-value` | `process` | 따옴표를 걷고 카멜 경계를 밑줄로 나눈 뒤 소문자로 맞추고 영숫자만 남긴다. `CHANGES_REQUESTED`, `changesRequested`, `'changes-requested'`가 같다                                                                                |

`iac-ref`에서 `aws_lb.main.arn`은 `aws_lb.main`이 되고 `${module.vpc.private_subnets}`는 `module.vpc`가 된다.

`dataset-io`는 정확히 맞는 게 없고 한쪽만 스키마를 적었으면 테이블 이름(마지막 마디)으로 찾는다. 양쪽 다 스키마를 적었는데 다르면 잇지 않는다. 같은 테이블 이름이 스키마 여럿에 있으면 고르지 않고 `multiple_decls`로 후보를 돌려준다.

`state-value`는 코드의 상태 enum이나 리터럴을 흐름 단계 `state`에 잇는 데 쓴다.

여기서도 `unmatched`는 눈으로 맞춰 실선을 긋지 않는다. `candidates`를 담아 미해결 질문으로 남긴다.

### `validate`

| Parameter    | Type      | Required | Default | Description                                      |
| ------------ | --------- | :------: | ------- | ------------------------------------------------ |
| `ir`         | `object`  |   Y\*    | —       | ArchitectureIR JSON                              |
| `irPath`     | `string`  |   Y\*    | —       | `ir` 대신 IR 파일 경로. `repoRoot` 기준으로 푼다 |
| `view`       | `string`  |    N     | —       | 주면 `ir.view`와 같아야 한다                     |
| `checkFiles` | `boolean` |    N     | `true`  | `code` 근거의 파일과 줄을 확인할지               |

`ir`과 `irPath` 중 하나는 있어야 한다. 둘 다 주면 `ir`을 쓴다. 합친 IR처럼 큰 IR은 응답과 요청에 통째로 싣지 말고 파일로 주고받는다.

성공 응답이다.

| 키               | 내용                                           |
| ---------------- | ---------------------------------------------- |
| `ok`             | `true`                                         |
| `errors`         | `[]`                                           |
| `autoUnresolved` | 근거가 없어 자동으로 만든 질문                 |
| `drawable`       | `{ nodeIds, edgeIds }`. 그리기 대상 id, 정렬됨 |
| `warnings`       | [경고](#검증-규칙) 목록. 있을 때만 온다        |

실패하면 [검증 규칙](#검증-규칙)의 `{ ok: false, errors }`다.

### `render`

| Parameter    | Type                    | Required | Default     | Description                                    |
| ------------ | ----------------------- | :------: | ----------- | ---------------------------------------------- |
| `ir`         | `object`                |   Y\*    | —           | ArchitectureIR JSON                            |
| `irPath`     | `string`                |   Y\*    | —           | `ir` 대신 IR 파일 경로. validate와 같다        |
| `view`       | `string`                |    N     | —           | 주면 `ir.view`와 같아야 한다                   |
| `audience`   | `"private" \| "shared"` |    N     | `"private"` | `openPath`가 가리킬 HTML. 파일은 늘 둘 다 쓴다 |
| `checkFiles` | `boolean`               |    N     | `true`      | `code` 근거의 파일과 줄을 확인할지             |

render는 이 순서로 돈다.

1. 받은 IR을 검증한다.
2. 이전 실행 IR이 있으면 병합해 id를 물려준다 ([재실행과 노드 id](#재실행과-노드-id)).
3. 병합 결과를 다시 검증한다. 병합이 id를 바꾸므로 그리기 대상도 다시 뽑는다.
4. 그린 `service` 노드가 있거나 [드릴다운](#드릴다운)의 다른 조건에 맞으면 레벨을 계산한다. 아니면 평면 그림 한 장이다.
5. 좌표를 계산해 private HTML과 shared HTML을 쓴다.
6. 자동 질문을 `unresolved`에 합쳐 IR을 저장한다. 사람이 거기 답을 달면 다음 실행이 물려받는다.
7. 질문별 그림이 있으면 그림마다 [따로 저장되는 파일](#따로-저장되는-파일)을 쓴다.

성공 응답이다.

| 키               | 내용                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`             | `true`                                                                                                                                       |
| `irPath`         | 저장한 IR 경로                                                                                                                               |
| `htmlPath`       | 본인용 HTML 경로                                                                                                                             |
| `sharedHtmlPath` | 공유용 HTML 경로                                                                                                                             |
| `openPath`       | `audience`에 따라 둘 중 하나                                                                                                                 |
| `viewPaths`      | 질문별 그림 파일 경로 목록. 쓴 파일이 있을 때만 온다                                                                                         |
| `levels`         | `{ id, title, nodes, edges }[]`. 드릴다운으로 그렸을 때만 온다. `nodes`와 `edges`는 그 레벨에 그린 수다. 엣지는 묶음 엣지 하나를 하나로 센다 |
| `stats`          | [render stats](#render-stats)                                                                                                                |
| `sourcesUsed`    | 병합 결과의 `sourcesUsed`                                                                                                                    |
| `warnings`       | validate와 같은 [경고](#검증-규칙) 목록. 있을 때만 온다                                                                                      |

### `status`

추가 파라미터가 없다. 응답은 `{ views: { "screen-chain": 요약 | null, "deploy-path": 요약 | null } }`다. 요약은 `{ generatedAt, nodeCount, edgeCount, unresolvedOpen, sourcesUsed }`다.

### `merge`

| Parameter          | Type       | Required | Default            | Description                                                                                                            |
| ------------------ | ---------- | :------: | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `irs`              | `object[]` |   Y\*    | —                  | 합칠 ArchitectureIR JSON 목록                                                                                          |
| `irPaths`          | `string[]` |   Y\*    | —                  | 합칠 IR 파일 경로 목록. `repoRoot` 기준으로 푼다. `irs`와 함께 주면 `irs` 뒤에 이어 붙인다                             |
| `groupNames`       | `string[]` |    N     | 입력의 서비스 이름 | 입력마다 붙일 제품 이름. 넘긴 순서에 맞춘다. 결과 `groups[].name`이 되고 [제품 띠](#제품-띠) 이름과 제품 브릭에 찍힌다 |
| `prefixCandidates` | `string[]` |    N     | —                  | 레포를 넘는 엔드포인트 매칭에서 FE 경로 앞에 붙는 게이트웨이 prefix 후보                                               |
| `outPath`          | `string`   |    N     | —                  | 합친 IR을 쓸 파일. 주면 응답에 IR 대신 경로를 싣는다                                                                   |

입력은 둘 이상이고 뷰가 모두 같아야 한다. 입력마다 파일 확인을 뺀 검증을 먼저 돌려 끊긴 엣지나 private 원문이 있으면 거부한다. 에러 메시지에 몇 번째 입력인지 붙는다. 합치는 규칙은 [분석 합치기](#분석-합치기)에 있다.

성공 응답이다.

| 키                         | 내용                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ok`                       | `true`                                                                                                          |
| `ir` 또는 `irPath`         | 합친 IR, `outPath`를 줬으면 쓴 경로                                                                             |
| `report.inputs`            | 입력 수                                                                                                         |
| `report.sharedNodes`       | 둘 이상의 입력에 있던 노드. `{ id, kind, label, repo, displayName?, inputs }`이고 `inputs`는 넘긴 순서의 번호다 |
| `report.crossRepoEdges`    | 레포를 넘는 매칭으로 새로 그은 엣지 id                                                                          |
| `report.conflictQuestions` | 충돌이나 애매한 매칭으로 새로 만든 질문 id                                                                      |
| `report.islands`           | 공유 노드나 새 엣지로 이어지지 않은 입력 묶음 수. 1이면 한 덩어리다                                             |
| `nextAction`               | 다음에 할 일                                                                                                    |

합친 IR은 `validate`와 `render`에 그대로 넘긴다. render는 `repoRoot`의 같은 뷰 IR과 병합하므로 **원래 분석 레포가 아닌 따로 둔 디렉토리를 `repoRoot`로 준다.** 원래 레포를 주면 그 레포의 단독 분석 IR이 합친 IR로 덮인다.

### `scan_docs`

문서 레포의 md를 읽기만 한다. 문서 레포에는 아무것도 쓰지 않는다.

| Parameter     | Type       | Required | Default   | Description                                         |
| ------------- | ---------- | :------: | --------- | --------------------------------------------------- |
| `docRoots`    | `object[]` |    Y     | —         | 훑을 문서 레포 목록. 필드는 아래 표                 |
| `docPatterns` | `object`   |    N     | 기본 형식 | 레포마다 다른 표시 형식을 맞출 정규식. 필드는 아래 표 |

`docRoots` 항목이다.

| 필드      | Required | 뜻                                                    |
| --------- | :------: | ----------------------------------------------------- |
| `repoId`  |    Y     | IR의 repo id. 노드 id와 근거 위치 앞에 붙는다          |
| `name`    |    N     | 전체보기 카드에 쓸 이름. 비우면 `repoId`               |
| `path`    |    Y     | 문서 레포 체크아웃 경로. `repoRoot` 기준으로 푼다      |
| `include` |    N     | 이 접두로 시작하는 경로만 훑는다                       |
| `exclude` |    N     | 이 접두로 시작하는 경로는 건너뛴다                     |

기본으로 알아보는 표시 형식은 이렇다. `docPatterns`의 같은 이름 필드에 정규식을 주면 바꿀 수 있다.

| 표시                                               | 기본 형식                                                | `docPatterns` 필드                   |
| -------------------------------------------------- | -------------------------------------------------------- | ------------------------------------ |
| 근거                                               | `[evidence: 종류:위치@ref]`                              | `evidence`                           |
| 구멍                                               | `[GAP: 설명]`                                            | `gap`                                |
| 확인 안 된 사실                                    | `[UNVERIFIED: 설명]`                                     | `unverified`                         |
| 최종 수정일                                        | `> 최종 수정: YYYY-MM-DD` 머리줄. front matter `updated`도 읽는다 | `updated`                   |
| 질문 안내 표                                       | 키워드 열과 문서 링크로 된 표                            | `keywordHeader`                      |
| 화면 색인 표                                       | 라우트 열과 프레임 열로 된 표                            | `routeHeader`, `screenNameHeader`    |

문서 루트마다 `git log`를 한 번 돌려 파일별 마지막 커밋 날짜를 `doc.committedAt`에 싣는다. 머리줄에 수정일을 안 적는 문서가 많아서다. git 레포가 아니면 비운다.

쓰는 파일은 `<repoRoot>/.gestalt/architecture/` 아래 셋이다.

| 파일                    | 내용                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `doc-scan.json`         | 문서마다 뽑은 근거, 구멍, 안내, 화면, 날짜. `link_docs`와 `stale_docs`가 읽는다          |
| `knowledge.draft.json`  | `view: "knowledge"` IR 초안. 폴더 구조대로 [tree 드릴다운](#tree-드릴다운)이 된다       |
| `doc-routes.json`       | 질문 길 분석 결과                                                                       |

질문 길은 에이전트가 문서를 찾아가는 길이다. `README.md`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md`, `KNOWLEDGE_INDEX.md` 같은 진입 문서와 들어오는 링크가 없는 `INDEX.md`에서 출발한다. 거기서 md 링크와 질문 안내 표를 따라간다. 끝까지 안 닿는 문서는 `doc.orphan`이 된다. 질문 안내 표가 가리킨 문서를 못 찾으면 막다른 안내이고 같은 키워드가 서로 다른 문서를 가리키면 충돌이다.

응답은 요약과 경로만 싣는다.

| 키                       | 내용                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `summary`                | 문서 수(`docCount`), 머리줄 수정일이 있는 문서 수(`withUpdatedAt`), 구멍 수(`gapCount`, `unverifiedCount`), 근거 구성(`evidenceMix`), 코드와 API 참조 수, 안내 수와 못 푼 안내 수, 화면 수 |
| `summary.questionRoutes` | `{ entries, reachable, orphans, deadRoutes, keywordConflicts }`. 진입 문서 수, 닿는 문서 수, 고립 문서 수, 막다른 안내 수, 키워드 충돌 수 |
| `summary.freshness`      | `{ dated, undated, agedDays, aged, headerBehind, byMonth, oldest }`. `agedDays`는 180이다. `headerBehind`는 커밋이 머리줄 수정일보다 30일 넘게 늦은 문서 수다. `oldest`는 가장 오래된 문서 10개다 |
| `skipped`                | 못 읽고 건너뛴 파일                                                                                                           |
| `scanPath`, `draftPath`, `routesPath` | 쓴 파일 세 개의 경로                                                                                             |

`docRoots`가 비면 `MISSING_INPUT`이고 문서 레포를 못 읽으면 `SCAN_FAILED`다.

지식 그림의 문서 카드에는 배지가 붙는다.

| 배지     | 붙는 때                                                                                     |
| -------- | ------------------------------------------------------------------------------------------- |
| 구멍 N   | 열린 `[GAP]` 표시가 N개                                                                      |
| 깨짐 N   | 가리킨 곳을 못 찾은 근거 링크가 N개                                                          |
| 고립     | 질문 길로 안 닿는다                                                                          |
| 오래됨   | 머리줄 수정일과 커밋 날짜 중 늦은 쪽이 그림 만든 날보다 180일 넘게 앞선다                    |

그림 위쪽 검색은 문서 이름과 질문 안내 키워드로 찾는다. 묶음 카드는 아래 레벨 문서의 이름과 키워드까지 보고 걸린다.

### `link_docs`

기술 IR과 `scan_docs` 결과를 엮는다. `scan_docs`를 먼저 돌려야 한다. 안 돌렸으면 `MISSING_INPUT`이다.

| Parameter             | Type                     | Required | Default | Description                                                                                         |
| --------------------- | ------------------------ | :------: | ------- | --------------------------------------------------------------------------------------------------- |
| `ir` / `irPath`       | `object` / `string`      |    Y     | —       | 엮을 기술 IR. 보통 `render`가 저장한 `<view>.json`이다                                               |
| `codeRoots`           | `Record<string, string>` |    N     | —       | 문서가 적은 레포 이름 → 그 레포 체크아웃 경로. 가리킨 파일이 있는지와 마지막 커밋 날짜를 읽는다      |
| `repoAliases`         | `Record<string, string>` |    N     | —       | 문서가 적은 레포 이름 → 기술 IR의 repo id. 비우면 `repos[].name`이 같은 레포로 본다                  |
| `screenIndexPrefixes` | `string[]`               |    N     | —       | 화면 색인으로 쓸 `design_screen`의 `<repoId>/<경로 접두>`. 비우면 화면은 잇지 않는다                 |

문서에서 기술 노드로 `describes` 선을 긋는다. 문서가 말한 것이지 코드가 증명한 게 아니라서 늘 점선이다. 잇는 근거(`via`)는 넷이다.

| `via`          | 잇는 방법                                       |
| -------------- | ----------------------------------------------- |
| `code-ref`     | 문서의 코드 근거가 가리킨 파일이 기술 노드의 근거 파일이다 |
| `api-path`     | 문서가 적은 API 경로가 엔드포인트와 맞는다      |
| `screen-route` | 화면 색인의 라우트가 화면과 맞는다              |
| `session`      | 세션이 직접 이었다                              |

`codeRoots`를 안 주면 가리킨 파일을 확인할 수 없어 그 링크를 unchecked로 센다. 담당은 CODEOWNERS를 문서 레포와 `codeRoots`에서 찾아 단다. 문서 레포는 `scan_docs` 때 준 경로에서 찾는다.

쓰는 파일이다.

| 파일                         | 내용                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `knowledge-link.draft.json`  | `view: "knowledge-link"` IR 초안. 기술 IR의 팩에 `knowledge`를 더한다             |
| `doc-link.json`              | 빈 곳, 낡은 곳, 어긋난 곳 신호 전체                                                |
| `knowledge.draft.json`       | 링크 상태와 담당을 다시 센 값으로 갱신한다. 두 그림의 깨진 링크 수를 맞추려는 것이다 |

응답의 `summary`다.

| 키                                         | 내용                                                    |
| ------------------------------------------ | ------------------------------------------------------- |
| `linkedDocs`                               | 기술 노드와 이어진 문서 수                              |
| `describes`                                | 그은 `describes` 선 수                                  |
| `coverage`                                 | kind마다 `{ total, covered }`. 문서가 있어야 할 kind(`service`, `micro_app`, `app_module`, `feature`, `screen`) 중 문서가 붙은 수 |
| `links`                                    | 근거 링크 확인 결과 `{ total, broken, branchOnly, pinned, unchecked }` |
| `staleCount`                               | 코드가 문서보다 늦게 바뀐 곳 수                         |
| `apiMismatchCount`                         | 문서의 API 경로와 기술 IR이 어긋난 곳 수                |
| `screensOnlyInCode`, `screensOnlyInIndex`  | 코드에만 있는 화면 수, 화면 색인에만 있는 화면 수       |
| `uncoveredCount`                           | 설명하는 문서가 없는 기술 노드 수                       |
| `ownership`                                | 담당이 달린 기술 노드와 문서 수. CODEOWNERS가 있을 때만 |
| `gapsByOwner`                              | 담당별 열린 구멍 수. 구멍이 있을 때만                   |

`summary` 밖에 `uncoveredSample`(문서 없는 노드 최대 20개)과 `draftPath`, `knowledgeDraftPath`, `signalsPath`가 온다.

지식과 아키텍처 그림의 기술 카드 배지다.

| 배지      | 붙는 때                                          |
| --------- | ------------------------------------------------ |
| 문서 N    | 이 카드를 설명하는 문서가 N개                    |
| 낡음 N    | 코드가 문서보다 늦게 바뀐 문서가 N개             |
| 문서 없음 | 설명하는 문서가 없다                             |
| 담당 없음 | CODEOWNERS에 이 자리를 맡은 담당이 없다          |

### `stale_docs`

바뀐 파일로 손봐야 할 문서를 고른다. `scan_docs`를 먼저 돌려야 한다.

| Parameter      | Type                     | Required | Description                                                                 |
| -------------- | ------------------------ | :------: | --------------------------------------------------------------------------- |
| `changedFiles` | `string[]`               |   Y\*    | 바뀐 파일 목록. `<레포 이름>:<경로>` 꼴 (예: `acme-api:src/orders/service.ts`) |
| `diffBase`     | `string`                 |   Y\*    | 이 커밋이나 브랜치부터 HEAD까지 바뀐 파일을 본다 (예: `origin/main`)          |
| `changedRepo`  | `string`                 |   Y\*    | `diffBase`로 git diff를 돌릴 레포 이름                                       |
| `codeRoots`    | `Record<string, string>` |   Y\*    | `codeRoots[changedRepo]`에서 체크아웃 경로를 찾는다                          |
| `repoAliases`  | `Record<string, string>` |    N     | 문서가 적은 레포 이름 → 기술 IR의 repo id                                    |

\* `changedFiles`를 주거나 `diffBase`, `changedRepo`, `codeRoots[changedRepo]`를 함께 준다. 둘 다 없으면 `MISSING_INPUT`이다. `changedFiles` 꼴이 틀리면 `INVALID_INPUT`이고 git diff가 실패하면 `DIFF_FAILED`다.

문서를 고르는 이유는 둘이다.

- `code-ref`: 문서가 직접 가리킨 파일이 바뀌었거나 가리킨 폴더 아래 파일이 바뀌었다.
- `node`: 문서가 설명하는 기술 노드의 근거 파일이 바뀌었다. `knowledge-link.draft.json`이 있을 때만 본다.

결과는 `stale-docs.json`에 쓴다. 응답의 `summary`는 `{ changedFiles, staleDocs, viaCodeRef, viaNode, linkedIr }`다. `linkedIr`는 `node` 이유까지 봤는지다. `sample`에 문서와 제목, 걸린 파일을 최대 20개 싣고 `stalePath`가 따라온다.

### 지식 그림 렌더

렌더는 기존 [`render`](#render) 그대로다. `knowledge.draft.json`이나 `knowledge-link.draft.json`을 `irPath`로 준다. 결과 파일은 다른 뷰처럼 `knowledge.html`, `knowledge-link.html`과 각 `.shared.html`이다.

```json
{ "action": "render", "irPath": ".gestalt/architecture/knowledge-link.draft.json" }
```

---

## render stats

| 키                      | 뜻                                                                           |
| ----------------------- | ---------------------------------------------------------------------------- |
| `nodes`                 | IR의 노드 수 (그리지 않은 것 포함)                                           |
| `edges`                 | IR의 엣지 수 (그리지 않은 것 포함)                                           |
| `drawnEdges`            | 그린 엣지 수                                                                 |
| `droppedEdges`          | `edges - drawnEdges`                                                         |
| `unresolvedOpen`        | 답이 안 달린 질문 수. IR의 질문과 자동 질문을 합친다                         |
| `screenToEndpointRatio` | 화면 중 엔드포인트로 이어진 비율                                             |
| `endpointMatchRatio`    | 엔드포인트 중 앱 모듈까지 이어진 비율                                        |
| `flows`                 | IR의 흐름 수. 흐름이 있을 때만 붙는다                                        |
| `drawnSteps`            | 그린 흐름 단계 수. 흐름이 있을 때만 붙는다                                   |
| `drawnTransitions`      | 그린 흐름 전이 수. 흐름이 있을 때만 붙는다                                   |
| `stages`                | IR의 구간 수. 구간이 있을 때만 붙는다                                        |
| `unstagedNodes`         | 어느 구간에도 안 맞아 **그 밖**으로 간 그린 노드 수. 구간이 있을 때만 붙는다 |

두 비율은 그린 노드와 그린 엣지만 센다.

- **`screenToEndpointRatio`** = (그린 엣지로 `endpoint` 노드에 닿는 그린 `screen` 수) ÷ (그린 `screen` 수)
- **`endpointMatchRatio`** = (그린 `handles` 엣지로 `app_module`에 닿는 그린 `endpoint` 수) ÷ (그린 `endpoint` 수)

분모가 0이면 `null`이다. deploy-path에는 `screen`과 `endpoint`가 없으므로 두 비율이 늘 `null`이다. 점선 엣지도 그린 엣지라 비율에 들어간다.

---

## 저장 위치

`<repoRoot>/.gestalt/architecture/` 아래 뷰마다 파일 세 개가 생긴다. 드릴다운도 레벨을 전부 HTML 한 파일에 담는다. 질문별 그림이 있으면 `views/` 아래에 그림마다 파일이 하나씩 더 생긴다.

| 파일                 | 내용                                              |
| -------------------- | ------------------------------------------------- |
| `<view>.json`        | 병합된 IR. private 근거의 `excerpt`는 지워져 있다 |
| `<view>.html`        | 본인용 HTML                                       |
| `<view>.shared.html` | 공유용 HTML                                       |
| `views/<view>.<투영 id>.json` | 질문별 그림 하나와 그 그림이 가리킨 노드, 엣지, 질문. [따로 저장되는 파일](#따로-저장되는-파일)에서 설명한다 |

파일은 전부 임시 파일에 쓴 뒤 이름을 바꿔 갈아 끼운다. 브라우저가 열어둔 HTML을 새로고침해도 반쯤 쓰인 파일을 보지 않는다. 저장된 IR이 깨졌거나 스키마에 안 맞으면 `.corrupt-*`로 옮기고 처음 실행처럼 다룬다.

레포를 넘는 연결에 필요한 레포가 이 머신에 없으면 세션이 묻지 않고 `~/.gestalt/architecture/clones/<host>/<org>/<repo>`에 `git clone --depth 1`로 받는다. 분석 대상 레포 안에 받지 않는 건 그 레포가 `.gestalt`를 ignore하지 않으면 받은 레포가 커밋에 섞이기 때문이다. 이미 있으면 `git fetch --depth 1 origin HEAD` 뒤 `git reset --hard FETCH_HEAD`로 원격 기본 브랜치의 최신 커밋에 맞춰 다시 쓴다. 사용자가 체크아웃해 둔 레포는 브랜치와 작업 트리를 건드리지 않는다. `git fetch origin`으로 원격 ref만 갱신한다. 지금 체크아웃이 원격 기본 브랜치와 다르면 `~/.gestalt/architecture/worktrees/<host>/<org>/<repo>`에 분리된 워크트리를 만들어 거기서 읽는다. 기능 브랜치나 pull 안 한 상태로 읽으면 그 시점 코드로 그림이 나오기 때문이다. 받기에 실패하면 미해결 질문으로 남는다. 절차는 스킬 Step 5에 있다.

### 재실행과 노드 id

재실행 때마다 id가 새로 매겨지면 사람이 단 답이 끊긴다. 그래서 render가 이전 IR(`<view>.json`)과 새 IR을 맞춰 이전 id를 물려준다 (`mergeWithPrevious`).

- **노드 안정 키**는 `kind`, `repo`, 정규화한 `label`(앞뒤 공백 제거, 연속 공백 하나로, 소문자)이다. 셋이 같으면 같은 노드로 보고 이전 id를 쓴다.
- **엣지 안정 키**는 id를 바꾼 뒤의 `from`, `to`, `kind`다.
- 노드의 `parent`도 바뀐 id를 따라간다.
- 새 IR의 다른 id와 부딪히면 바꾸지 않는다.
- 이전 IR에서 답이 달린 질문은 대상 노드나 엣지가 병합 결과에 남아 있을 때만 이어 붙인다. 같은 대상에 같은 질문이 새로 왔으면 답만 옮긴다.
- 이전 IR의 질문별 그림은 가리킨 노드와 엣지가 다 남아 있을 때만 이어진다. 조건은 [재실행과 합치기](#재실행과-합치기)에 있다.

label을 바꾸면 다른 노드가 된다. 엔드포인트 label을 `METHOD /정규화 경로` 꼴로 고정하는 이유다. 사람이 읽을 이름을 다듬고 싶으면 label 대신 `displayName`을 고친다. 병합 키에 안 들어가서 id가 그대로다.

### 분석 합치기

재실행 병합은 같은 분석의 앞뒤를 맞춘다. 제품마다 따로 돌린 분석을 한 그림으로 보려면 `merge`를 쓴다 (`mergeArchitectureIrs`). 두 제품이 같이 쓰는 게이트웨이와 서버가 한 노드로 모이고 그 노드를 거쳐 두 제품의 화면이 이어진다.

- **레포**는 별칭(`repos[].id`)이 아니라 `remote`로 알아본다. `git@host:org/repo.git`과 `https://host/org/repo`는 같은 레포다. remote가 없는 레포(클라우드 조회용으로 둔 가짜 레포 등)는 `name`으로 알아본다. 별칭이 부딪히면 뒤에 `-2`를 붙여 다시 매기고 `code` 근거 위치 앞의 별칭도 함께 바꾼다.
- **노드**는 재실행 병합과 같은 키(`kind`, 레포, 정규화한 `label`)로 알아본다. 레포는 위에서 묶은 기준이라 두 분석이 다른 별칭을 썼어도 같은 노드가 된다. 같은 노드면 하나로 합치고 근거는 합집합으로 남긴다. 한 입력 안에서 키가 겹친 노드끼리는 그 분석이 일부러 나눈 것으로 보고 합치지 않는다.
- **id**는 먼저 합친 쪽 것을 쓴다. 다른 노드와 부딪히면 `-2`를 붙인다. `parent`, `account`, 엣지 양 끝, 질문 대상이 바뀐 id를 따라간다.
- **엣지**는 바뀐 id 기준 `from`, `to`, `kind`가 같으면 하나로 합친다. 한쪽이라도 실선이면 실선이다. 근거는 합집합이라 실선의 근거가 줄지 않는다.
- **레포를 넘는 연결**: 핸들러(`handles` → `app_module`)가 없는 엔드포인트를 다른 입력의 핸들러 달린 엔드포인트와 [`match_endpoints`](#match_endpoints)와 같은 규칙(method와 정규화한 경로)으로 맞춘다. 맞으면 FE 엔드포인트에서 그 모듈로 `handles`를 긋고 FE 쪽 경로 줄과 BE 쪽 라우트 줄을 둘 다 근거로 단다. 같은 입력 안의 쌍은 다시 맞추지 않는다. 그 분석이 이미 못 맞춘 쌍이라서다. 후보가 여럿이면 긋지 않고 질문으로 남긴다.
- **충돌**: 같은 노드인데 `displayName`, `parent`, `environment`, `account`가 입력마다 다르면 어느 쪽도 고르지 않는다. 그 값을 비우고 후보를 담은 미해결 질문(`merge:<필드>:<노드 id>`)을 만든다. 단 `user` 근거가 있는 쪽 값은 그대로 둔다. 사람이 답해서 정한 값이라서다. 한쪽만 값을 줬으면 충돌이 아니라 그 값을 쓴다. `description`은 먼저 합친 쪽 것을 쓴다.
- **마이크로 프론트엔드 앱**은 레포를 빼고 `kind`와 정규화한 `label`로 알아본다. 호스트 레포 분석이 리모트를 `loads`로 들여오고 리모트 레포 분석이 그 앱을 직접 그려도 한 노드가 된다. 레포는 그 앱으로 들어오는 `loads`가 없는 입력, 곧 자기 레포를 분석한 쪽 것을 쓴다. 두 제품이 같은 리모트를 각자 자기 서비스에 달았으면 parent를 비우고 질문은 만들지 않는다. 같이 쓰는 리모트는 어느 한 서비스 것이 아니라서 전체 레벨에 따로 서는 게 맞다.
- **겹치는 노드가 없으면** 입력이 섬처럼 나란히 선다. 서비스가 둘 이상이라 드릴다운 전체 화면에 서비스가 나란히 서고 서비스마다 레벨이 생긴다. 포커스도 그대로 쓸 수 있다.
- **질문**은 대상을 바뀐 id로 옮긴다. 같은 대상에 같은 문장이면 하나만 남기고 답이 있는 쪽 답을 쓴다.
- **질문별 그림**은 나란히 둔다. 안의 노드와 엣지 참조는 바뀐 id를 따라간다. 투영 id나 메시지 id가 부딪히면 `-2`를 붙여 다시 매긴다. 메시지를 가리키는 질문의 `messageId`도 함께 바뀐다.
- **어휘 팩**: 입력 중 하나라도 `packs`를 적었으면 결과에도 적는다. 값은 입력들 팩의 합집합이다. `packs`를 안 적은 입력은 `web-product`와 `harness`를 쓴 것으로 친다.
- **맥락 소스**는 `via`와 `identifier`로 묶는다. 한쪽이라도 `private`이면 `private`로 남긴다. `generatedAt`은 입력 중 가장 늦은 시각이다.
- **공개 범위**: private 근거의 원문은 입력 검증에서 거부하고 결과에서도 한 번 더 지운다. 근거는 원래 `visibility`를 그대로 갖고 가므로 shared 렌더의 가리기 규칙이 합친 결과에도 똑같이 걸린다.
- **결정적이다.** 입력을 정규화한 JSON의 해시 순으로 정렬한 뒤 합치므로 넘긴 순서나 객체 키 순서와 상관없이 같은 바이트가 나온다. 보고서의 `inputs` 번호만 넘긴 순서를 따른다.

상대 경로 `root`는 그 IR을 그린 위치 기준이라 합칠 때 풀 수 없다. 같은 레포를 두 입력이 다른 `root`로 적었으면 절대 경로 쪽을 쓴다. 합친 IR을 `checkFiles: true`로 그리려면 입력의 `root`를 절대 경로로 적어 둔다.

#### 제품 띠

합친 IR에는 입력마다 그룹이 하나씩 붙는다 (`groups`). `members`는 그 입력에 있던 노드를 합친 뒤의 id로 적은 것이다. 엣지를 따라 소속을 정하지 않고 입력에 있었는지로만 정한다. 두 제품이 같이 부르는 게이트웨이가 다른 제품 엔드포인트로 가는 `routes`를 갖고 있으면 엣지를 따라가는 순간 한 제품이 다른 제품 영역까지 삼키기 때문이다. 이미 합친 IR을 다시 합치면 그 안의 그룹을 그대로 물려받는다. 그룹 이름은 `groupNames`로 주고 안 주면 입력의 서비스 이름을 쓴다.

그룹이 둘 이상이면 render가 그림을 가로 띠로 나눠 그린다 (`src/architecture/layout.ts`의 `stackBands`). 레인은 그대로 두고 각 열 안에서 카드를 다시 쌓는다.

| 띠                      | 카드                                         |
| ----------------------- | -------------------------------------------- |
| 맨 위                   | 둘 이상의 그룹에 있는 노드, 그룹이 없는 노드 |
| 그 아래로 그룹마다 하나 | 그 그룹에만 있는 노드. 그룹 순서대로 쌓는다  |

띠마다 머리에 점선 구분선을 긋고 그 선에 띠 이름을 단다. 맨 위는 `같이 쓰는 카드`, 나머지는 제품 색 네모와 `A 전용`이다. 띠 높이는 모든 열에서 같게 맞춘다. 그래야 구분선 한 줄로 띠가 갈린다. 같이 쓰는 띠 안에서는 쓰는 제품이 많은 카드가 위로 간다. 여러 제품이 기대는 카드부터 눈에 들어오게 하려는 것이다.

같이 쓰는 카드는 돌기 대신 그 카드를 쓰는 제품을 작은 브릭으로 한 줄 꽂는다. 브릭은 제품 색으로 꽉 채우고 제품 이름을 흰 글자로 적는다. 색만으로 제품을 가리지 않으려고 이름을 함께 적는다. 제품 색은 여덟 가지이고 제품이 더 많으면 처음 색부터 다시 돈다. 브릭은 그 카드와 선으로 바로 이어진 제품 전용 카드가 많은 제품부터 놓는다. 게이트웨이라면 그 제품 API로 가는 선이, 서버라면 그 제품 엔드포인트에서 들어오는 선이, 저장소라면 그 제품 서버에서 들어오는 선이 많은 쪽이 앞이다. 같이 쓰는 카드끼리 이은 선은 어느 제품 몫도 아니라서 안 센다. 수가 같으면 합칠 때 넘긴 순서를 따른다. 카드마다 순서는 달라도 제품 색은 그대로라 색으로 제품을 따라갈 수 있다. 카드 폭에 다 안 들어가면 들어가는 만큼만 꽂고 남은 수를 `+N` 버튼에 적는다. 폭은 카드 폭처럼 글자 수로 어림해서 서버가 정한다. 버튼을 누르면 `카드이름을 같이 쓰는 제품` 드롭다운이 뜨고 그 카드를 쓰는 제품 전부와 제품마다 그 레벨의 전용 카드 수가 나온다. 캔버스는 확대와 스크롤 상자 안이라 드롭다운은 화면 기준으로 띄운다. 바깥을 누르거나 Esc를 누르거나 화면을 옮기면 닫힌다.

- 그룹 순서는 합친 결과의 `groups` 순서다. 합치기가 입력을 정렬하므로 넘긴 순서와 상관없이 같다.
- 레벨마다 따로 정한다. 그 레벨에 카드가 있는 띠가 하나뿐이면 띠를 나누지 않는다.
- 전체 레벨은 prod 기준이라 같이 쓰는지도 prod 노드끼리 본다.
- 그룹이 하나면 띠 없이 그린다.

---

## 읽기 전용 도구 걸러내기

세션은 맥락을 모으려고 MCP 도구를 부른다. 이때 쓰기 도구를 부르면 남의 시스템에 흔적이 남는다. `filter_tools`가 도구 이름만 보고 미리 거른다 (`src/utils/read-only-tools.ts`).

1. 이름을 토큰으로 쪼갠다. camelCase 경계와 `_`, `-`, `.`, `:`, `/`, 공백에서 끊고 소문자로 내린다.
2. 토큰 중 하나라도 금지 단어면 `denied`다. 금지 단어는 `send`, `create`, `update`, `delete`, `post`, `put`, `patch`, `dml`, `ddl`이다.
3. 금지 단어가 없고 허용 단어가 하나라도 있으면 `allowed`다. 허용 단어는 `search`, `get`, `read`, `list`, `query`, `fetch`다.
4. 둘 다 없으면 `ambiguous`다.

금지 단어가 허용 단어보다 먼저다. `getOrCreate`는 `get`이 있어도 `create` 때문에 `denied`다. 토큰 단위로 보므로 `listing`처럼 허용 단어를 품은 다른 단어는 걸리지 않는다.

| 이름                   | 결과        |
| ---------------------- | ----------- |
| `mcp__kb__search_docs` | `allowed`   |
| `mcp__kb__create_page` | `denied`    |
| `getOrCreateUser`      | `denied`    |
| `mcp__acme__run`       | `ambiguous` |

세션은 `allowed`만 부른다. `ambiguous`도 부르지 않는다.

### CLI 명령 판정

`live` 근거의 `command`는 `classifyCliCommand`가 다시 본다. 세션이 실제로 돌린 명령이 읽기 전용이었는지를 IR에 남은 문자열로 확인하는 자리다. `allow`가 아니면 `validate`가 `LIVE_COMMAND_NOT_READ_ONLY`로 거부한다.

1. 셸 메타문자(`;`, `&`, `|`, 백틱, `<`, `>`, 줄바꿈, `$(`)가 있으면 `deny`다. 명령 둘을 이어 붙여 판정을 피하지 못하게 한다.
2. `--with-decryption`이 있으면 `deny`다.
3. `aws-vault`는 `list`만 `allow`이고 나머지는 `deny`다. `aws`도 `aws-vault`도 아닌 프로그램은 `ambiguous`다.
4. `aws`는 전역 옵션(`--profile`, `--region` 등)을 건너뛰고 서비스와 동작을 찾는다. 동작이 없으면 `ambiguous`다.
5. 동작이 `list`, `get`, `describe`로 시작하지 않으면 `deny`다. `aws configure`는 `list-profiles`만 `allow`다.
6. 이름이 `get`이어도 `get-object`처럼 파일을 내려받거나, 동작 이름에 `secret`, `password`, `token`, `credential`이 들면 `deny`다.

| 명령                                                    | 결과        |
| ------------------------------------------------------- | ----------- |
| `aws cloudfront list-distributions --profile acme-prod` | `allow`     |
| `aws s3api get-bucket-website --bucket example-web`     | `allow`     |
| `aws s3 sync dist s3://example-web`                     | `deny`      |
| `aws secretsmanager get-secret-value --secret-id x`     | `deny`      |
| `aws cloudfront list-distributions \| jq .`             | `deny`      |
| `gcloud compute instances list`                         | `ambiguous` |

---

## 글로벌 맥락 후보

`start`의 `contextCandidates`는 세션이 읽어볼 파일 목록이다. 서버는 경로만 모으고 본문은 읽지 않는다 (`src/architecture/global-context.ts`).

| via      | 파일                                                                              | visibility |
| -------- | --------------------------------------------------------------------------------- | ---------- |
| `repo`   | `<repoRoot>/CLAUDE.md`, `<repoRoot>/AGENTS.md`, `<repoRoot>/.gestalt/memory.json` | `public`   |
| `repo`   | `<repoRoot>/docs/` 아래 `.md` 전부                                                | `public`   |
| `global` | `~/.claude/CLAUDE.md`                                                             | `private`  |
| `global` | 같은 레포로 묶인 `~/.claude/projects/*/memory/` 바로 아래 `.md`                   | `private`  |

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
2. 답을 받으면 질문의 `answer`에 적는다. 그 답이 확인한 노드나 엣지, 흐름 단계나 전이에 `user` 근거를 단다. `user` 근거는 점선이다. `location`에는 질문 id와 답한 날짜만 적고 답 원문은 `answer`에만 둔다.
3. 답이 코드 위치를 알려주면 거기서 코드를 찾아 `code` 근거를 단다. 그때 실선이 된다.
   - 기획 문서에만 있는 단계에 "개발 중"이나 "출시 안 함" 같은 답이 오면 단계 설명 앞에 그 상태를 적는다. 코드가 없으니 점선은 그대로다.
   - 답이 코드와 다른 의도를 말하면 그림은 코드 동작대로 둔다. 차이는 설명에 적고 보고에서 버그 후보로 올린다.
4. 다시 `validate`를 돌고 `render`한다.

render는 자동 질문까지 IR에 저장한다. 답이 안 달린 질문은 HTML의 미해결 목록에 나오고 다음 실행에서 다시 묻는다. 답이 달린 질문은 병합 때 물려받는다.

---

## Skills

| 슬래시 커맨드   | 파일                           | 설명                                       |
| --------------- | ------------------------------ | ------------------------------------------ |
| `/architecture` | `skills/architecture/SKILL.md` | 뷰 하나를 탐색부터 render까지 드라이빙한다 |

설계 리뷰나 설계 자문은 `architect` 에이전트를 쓴다. 파일 단위 의존성과 영향 범위는 [코드 그래프](./code-graph.md)를 쓴다.
