# PRD 뷰

PRD 마크다운을 훑어보기 좋은 HTML 한 장으로 바꾼다. `/prd-view` 스킬이 흐름을 맡고 `ges_prd` MCP 도구가 검사와 렌더를 한다.

양식은 정하지 않는다. 섹션 이름과 순서는 원문을 따르고 그 안을 어떤 카드로 그릴지는 세션이 블록 어휘에서 고른다. 그래서 팀마다 PRD 양식이 달라도 같은 도구로 그릴 수 있다. 서버는 LLM을 부르지 않는다.

## 흐름

1. `ges_prd guide`로 블록 어휘와 규칙, 예시를 받는다.
2. `ges_prd source`로 원문을 줄 번호와 함께 읽는다. 400줄씩 돌려주니 `nextFrom`이 null이 될 때까지 이어 부른다.
3. 세션이 `prd-view.json`을 쓴다. 블록마다 원문 줄 범위(`src`)를 단다.
4. `ges_prd validate`로 검사하고 오류와 빠진 구간을 고친다.
5. `ges_prd render`로 HTML을 만든다.

뷰 JSON은 도구 인자로 넘기지 않는다. 수십 KB짜리 JSON이 호출 인자로 오가면 대화에 두 번 쌓인다. 세션이 파일로 쓰고 도구는 `slug`나 `viewPath`로 읽는다.

## 결과물 위치

기본은 `<repoRoot>/.gestalt/prd-view/<slug>/`이다.

```
prd-view.json   세션이 쓴 뷰
index.html      render가 쓴 HTML
```

`outDir`을 주면 `index.html`만 그 폴더에 쓰고 `prd-view.json`은 기본 위치에 남긴다. 상대 경로는 `repoRoot` 기준으로 풀고 폴더가 없으면 만든다.

`outDir`에 이미 `index.html`이 있으면 조심한다. PRD 뷰가 쓴 파일은 첫 줄에 `<!-- gestalt-prd-view v1 -->` 표시가 있어서 그냥 갱신한다. 표시가 없는 파일은 `OUT_FILE_EXISTS`로 막고 `overwrite: true`일 때만 덮는다. 앱 폴더를 잘못 주면 실제 `index.html`이 날아가기 때문이다. `index.html`이나 `outDir` 폴더가 심볼릭 링크면 `overwrite`여도 쓰지 않는다. 폴더 링크는 `INVALID_OUT_DIR`로 막는다.

HTML은 외부 파일을 불러오지 않는 한 장짜리라 `file://`로 바로 열린다. 기본 테마는 다크다. 고른 탭과 테마는 문서별로 브라우저에 저장하며 URL 해시로 탭이나 항목을 바로 열 수 있다.

## 블록 어휘

모든 블록에 붙는 칸은 아래와 같다.

| 칸         | 뜻                                                                               |
| ---------- | -------------------------------------------------------------------------------- |
| `id`       | 문서 안에서 겹치지 않는 id                                                       |
| `src`      | 원문 줄 범위 배열 `[[시작, 끝], ...]`. 1부터 세고 끝 줄도 포함한다               |
| `summary`  | 원문을 줄여 쓴 블록이면 `true`. 글자 대조를 건너뛰고 화면에 "요약" 배지가 붙는다 |
| `audience` | 읽을 사람 태그 `pm`, `dev`, `design`, `qa`, `data`                               |

| 블록          | 쓰는 자리                     | 주요 칸                                                                                                                               |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `claim`       | 한 문장으로 서는 주장         | `text`, `status`(`confirmed`, `assumed`, `open`)                                                                                      |
| `requirement` | 요구사항 하나                 | `title`, `why`(가설), `boundary`(범위 밖이나 제약, 아직 정하지 않은 경계), `phase`(`mvp`, `later`), `metrics`(연결 지표 id), `detail` |
| `metric`      | 성공 지표 하나                | `metricId`, `name`, `role`, `denominator`, `baseline`, `target`, `measure`                                                            |
| `decision`    | 정한 것과 버린 안             | `decided`, `why`, `rejected[{ option, reason }]`                                                                                      |
| `question`    | 아직 안 정한 것               | `item`, `owner`, `due`                                                                                                                |
| `risk`        | 리스크와 대응                 | `text`, `response`(선택 문자열)                                                                                                       |
| `prose`       | 맞는 블록이 없을 때           | `text`                                                                                                                                |
| `compare`     | AS-IS와 TO-BE, A안과 B안 비교 | `labels[왼쪽, 오른쪽]`, `rows[{ label, left, right }]`                                                                                |
| `scope`       | 이번에 안 하는 것 목록        | `out`                                                                                                                                 |
| `quote`       | 유저 말투 그대로의 인용       | `text`, `origin`(`voc`, `virtual`, `unknown`), `by`                                                                                   |
| `flow`        | 순서대로 이어지는 단계        | `steps`(두 개 이상)                                                                                                                   |
| `stateMatrix` | 상태와 조건을 놓은 표         | `rows`, `cols`, `cells[행][열]`(빈 칸은 `null`)                                                                                       |
| `timeline`    | 일정                          | `items[{ date, what }]`                                                                                                               |
| `glossary`    | 용어 정의                     | `terms[{ term, meaning }]`                                                                                                            |
| `callout`     | 원문이 강조한 주의 문단       | `text`, `tone`(`info`, `warn`, `danger`)                                                                                              |

원문에 없는 칸은 필드를 빼서 비워 둔다. 화면에는 "원문에 없음"으로 회색 칸이 남는다. 비어 있다는 사실도 보여야 해서다.

스키마 버전은 `1.1.0`이며 기존 `1.0.0` JSON도 그대로 받는다. 새 필드는 전부 선택이다.

| 선택 필드                      | 내용                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requirement.parent`           | 상위 requirement id. 상위 없이 하위가 있는 블록은 그룹, 그 하위는 기능이며 2단까지만 허용한다                                                      |
| `requirement.acceptance`       | 수용 기준 `[{ text, src }]`                                                                                                                        |
| `requirement.slots`            | 개발 준비 칸. `precondition`, `trigger`, `behavior`, `result`, `exception`, `display`, `permission`, `businessRule`, `data` 키마다 `{ text, src }` |
| `requirement.priority`         | 원문에 적힌 중요도 문자열. 블록 src로 대조한다                                                                                                     |
| `requirement.questions`        | 연결된 question 블록 id 배열                                                                                                                       |
| `meta.roles`, `meta.platforms` | 원문에 적힌 사용자 역할과 플랫폼 `[{ text, src }]`                                                                                                 |

`acceptance`, `slots`, `meta.roles`, `meta.platforms`는 각 값의 src로 글과 숫자를 대조한다. `risk.response`와 `priority`는 블록 src로 대조하며 `meta.rows.value`도 원문과 비교한다. 원문에 없는 칸은 비워 둔다. 새 기능 필드는 이번 버전의 기존 카드에서 생략되며 risk는 기존 카드에 표시된다.

문서 바깥 틀은 이렇다.

```json
{
  "schemaVersion": "1.1.0",
  "slug": "rental-reco",
  "meta": {
    "title": "...",
    "source": "docs/rental/PRD.md",
    "sourceSha256": "...",
    "rows": [{ "key": "오너", "value": "...", "src": [[9, 9]] }]
  },
  "sections": [{ "id": "problem", "title": "문제", "blocks": [] }],
  "omitted": [{ "src": [[42, 44]], "reason": "변경 이력" }]
}
```

`omitted`는 변경 이력처럼 일부러 옮기지 않는 구간이다. 이걸 안 두면 세션이 빠진 줄을 채우려고 보일러플레이트를 `prose`로 옮기게 된다.

## 탭과 대상별 보기

왼쪽 레일과 상단 탭에서 PRD, 기능명세서, 지표, 결정과 미확정, 검수를 오간다. 가운데 목차와 오른쪽 본문은 탭에 맞춰 바뀐다. 개수 배지는 검수 탭에만 붙는다.

- PRD는 섹션마다 카드 하나로 묶는다. 맨 위에 원문 반영률과 빈칸 개수가 있고 문서 정보 카드에는 `meta.rows`, `roles`, `platforms`를 담는다. 원문 줄 번호와 종류 배지는 기본으로 숨기며 왼쪽 원문 줄 버튼으로 켠다.
- 기능명세서는 디렉토리와 카드 보기를 제공한다. `requirement.parent`가 있으면 그룹 아래 기능을 놓고 없으면 원문 섹션으로 묶는다. 그룹은 원문 카드로 가는 폴더 링크로 표시하며 카드와 개발 준비 칸 수는 하위 기능만 센다. MVP와 이후로 거를 수 있고 상세 아래 이전과 다음 버튼으로 넘긴다. 그래프 버튼은 준비 중이라 비활성이다.
- 기능 상세에는 ID, 단계, 걸린 질문 수, 중요도, 설명, 근거, 범위와 경계, 연결 지표, 수용 기준, 미확정 질문, 개발 준비 9칸이 나온다. 채운 칸은 실선이다. 빈 칸은 점선과 질문으로 드러낸다. 카드에는 채운 칸 수가 표시된다. 수용 기준 체크는 화면에서만 쓰며 승인이나 저장 기능은 아니다.
- 지표는 핵심, 보조, 가드레일로 묶고 역할이 없는 지표는 분류 없음에 둔다. 분모, 기준값, 목표, 측정 방법과 움직이는 요구사항을 표로 보여 준다.
- 결정과 미확정에는 결정의 확정 여부와 질문의 담당, 기한을 표시한다. 담당이나 기한이 비면 노란 칩으로 알리고 연결된 요구사항으로 이동할 수 있다.
- 검수에는 `막힘`, `채워야 함`, `참고`, `문장`을 모은다. 블록 ID 대신 제목이나 질문으로 이동 링크를 표시한다. 문장 진단은 원문을 고치지 않는다. 막힘은 오류에만 쓰고 비차단 빠진 원문 줄은 채워야 함에 둔다. 빠진 줄을 상세히 보여 주면 같은 coverage 경고 문장은 중복으로 넣지 않는다. 검수 배지는 표시한 항목 행 수이며 문장 묶음의 칩은 전체 진단 건수다. 문장 예시는 앞 3건까지 보여 준다.

블록에 `audience`가 두 종류 이상 쓰였으면 상단에 대상별 보기 버튼이 생긴다. `audience`를 안 단 카드는 모두에게 보인다. 카드가 전부 숨은 섹션과 목차도 함께 숨긴다. 스크립트가 꺼진 환경에서는 모든 탭의 원문을 펼쳐 보여 준다.

`prose`, `callout`, `claim` 등의 줄바꿈은 HTML에서도 유지한다. 상대 경로 마크다운 링크는 글자만 보이고 경로는 `title`에 남긴다. http(s) 링크는 별도 탭으로 열린다. 링크를 감싼 목차나 모아 보기에서는 링크를 중첩하지 않고 굵게와 코드 서식만 살린다.

## 검사

`validate`는 원문과 뷰를 대조한다. 의미까지 보지는 않는다. 블록 글이 지목한 줄 근처에서 왔는지, 원문 내용 줄이 어딘가에 옮겨졌는지까지만 확인한다.

**원문 대조.** 블록 글과 원문 범위를 NFKC로 정규화하고 마크다운 기호, 공백, 구두점을 지운 뒤 비교한다. 부분 문자열이거나 글자 bigram이 60% 넘게 겹치면 원문에서 온 글로 본다. 한국어는 조사가 자주 바뀌어서 단어가 아니라 글자로 비교한다. 숫자는 `summary` 블록에도 따로 대조한다.

**빠진 줄(coverage).** 빈 줄, frontmatter, 표 구분선과 머리글, 헤딩만 있는 줄을 뺀 내용 줄 가운데 어느 블록에도 `meta.rows`에도 `omitted`에도 안 걸린 줄의 비율을 센다. 10%를 넘으면 경고를 내고 30%를 넘으면 오류로 보고 렌더를 막는다. 빠진 구간은 `coverage.ranges`에 줄 범위와 첫 줄 미리보기로 실린다.

오류(렌더를 막는다)

| 코드                                   | 조건                                    |
| -------------------------------------- | --------------------------------------- |
| `DUPLICATE_ID`                         | 섹션이나 블록 id가 겹친다               |
| `DUPLICATE_METRIC_ID`                  | 같은 `metricId`가 둘 이상               |
| `UNKNOWN_METRIC`                       | requirement가 없는 지표 id를 가리킨다   |
| `UNKNOWN_PARENT`, `UNKNOWN_QUESTION`   | 해당 종류의 블록이 없는 id를 가리킨다   |
| `PARENT_CYCLE`, `REQUIREMENT_TOO_DEEP` | parent가 순환하거나 깊이가 2단을 넘는다 |
| `SRC_OUT_OF_RANGE`                     | src가 원문 줄 수를 넘는다               |
| `SRC_ON_BLANK`                         | src에 내용 줄이 하나도 없다             |
| `COVERAGE_LOW`                         | 빠진 줄이 30% 초과                      |

경고

| 코드                          | 조건                                                              |
| ----------------------------- | ----------------------------------------------------------------- |
| `COVERAGE_GAP`                | 빠진 줄이 10% 초과                                                |
| `TEXT_NOT_IN_SOURCE`          | `summary`가 아닌 블록 글이 src 범위에 없다                        |
| `NUMBER_NOT_IN_SOURCE`        | 블록의 숫자가 src 범위에 없다                                     |
| `METRIC_ID_NOT_IN_SOURCE`     | 원문 전체에 `M숫자` id가 있는데 해당 `metricId`는 src 범위에 없다 |
| `SRC_TOO_WIDE`                | `summary`가 아닌 블록이 내용 줄 25줄 넘게 잡는다                  |
| `SRC_COVERS_MOST`             | 블록 하나가 문서 내용 줄의 40% 넘게 잡는다                        |
| `SECTION_TITLE_NOT_IN_SOURCE` | 섹션 제목이 원문 헤딩에 없다                                      |
| `SOURCE_STALE`                | `meta.sourceSha256`이 지금 원문과 다르다                          |
| `OMITTED_TOO_MUCH`            | 생략 선언이 내용 줄의 25% 초과                                    |

## 원문 빈칸

`validate`와 `render`는 lint 경고와 따로 `gaps`를 돌려준다. lint 경고는 세션이 뷰를 고쳐 없앨 것이고 `gaps`는 PRD 원문 자체가 비어 있는 자리라 세션이 채우면 안 된다. 렌더한 화면에서는 검수 탭의 채워야 함과 참고 묶음에서 질문으로 보여 준다.

| 코드                   | 조건                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `BASELINE_NO_NUMBER`   | 기준값이 없거나 재추출, 검수 대기, 측정 불가, 미정이다. 참고: 뒤 수치나 "참고 12%"처럼 참고 바로 뒤 수치, 연월만 있는 값도 측정 수치로 안 본다 |
| `TARGET_UNDECIDED`     | 목표가 없거나 미정, 설정 대기다                                                                              |
| `ACCEPTANCE_MISSING`   | 기능에 수용 기준이 없다. 하위가 없는 최상위 요구사항도 단독 기능으로 본다                                    |
| `SLOTS_INCOMPLETE`     | 기능의 개발 준비 칸이 비었다. 빠진 키를 `missingSlots`로 한 건에 묶는다                                      |
| `DUE_NOT_DATE`         | 질문 기한이 없거나 날짜 꼴이 아니다. `2026-3-10`, `3/10`, `3월 10일`, `D-7`을 날짜로 본다                    |
| `TBD_PLACEHOLDER`      | 글 칸에 `{{TBD...}}` 자리표시가 남았다                                                                       |
| `METRIC_UNLINKED`      | 어느 요구사항에도 안 걸린 지표                                                                               |
| `REQUIREMENT_UNLINKED` | 연결된 지표가 없는 요구사항                                                                                  |
| `QUOTE_VIRTUAL`        | 인용이 실제 VOC가 아니라 가상 화법이다                                                                       |
| `DECISION_UNCONFIRMED` | 결정 글에 "제안"이나 "확인 필요"가 있다                                                                      |
| `OPEN_CLAIMS`          | 상태가 미정인 주장. 여러 개여도 한 건으로 묶는다                                                             |

지표 연결 두 코드는 문서에 요구사항과 지표가 둘 다 있을 때만 본다. 요구사항 전부가 미연결이면 `REQUIREMENT_UNLINKED` 한 건으로 묶는다.

모든 gaps 항목은 `question`에 블록 제목을 넣은 해요체 질문을 싣는다. 예를 들어 `"대여 신청"의 완료 기준은 무엇인가요?`, `"7일 내 재대여율"의 목표는 얼마인가요?`처럼 다음 빈칸 인터뷰의 입력으로 쓸 수 있다. 질문을 생성해도 원문은 채우지 않는다.

## 문장 진단

`validate.prose`는 원문을 고치지 않는 `info` 진단이다. 코드마다 `count`에 전체 건수를, `samples`에 앞 3건을 담는다. 각 예시는 문장과 블록 id 또는 원문 줄 번호를 담고 AI 표현 탐지는 `ruleId`도 싣는다.

| 코드               | 조건                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `REQ_NO_SUBJECT`   | requirement 설명 첫 문장에 사용자, 관리자, 회원 등의 주어가 없다                                           |
| `REQ_NO_BOUNDARY`  | requirement에 boundary가 없다                                                                              |
| `MODAL_AMBIGUOUS`  | acceptance, slots.data, risk에 "할 수 있다", "될 수 있다" 같은 표현이 있다. result와 permission은 제외한다 |
| `RISK_NO_RESPONSE` | risk에 response가 없다                                                                                     |
| `SENTENCE_LONG`    | 원문 한 문장이 66자를 넘는다                                                                               |
| `PROSE_AI_TELL`    | humanize의 detect가 연결어미 뒤 쉼표, 가운뎃점 나열 등의 규칙을 찾는다                                     |

## 범위 밖

- PRD를 새로 쓰거나 고치는 일. 원문은 읽기만 한다.
- 와이어프레임이나 화면 시안 만들기.

도구 파라미터와 응답 모양은 [MCP 레퍼런스](./mcp-reference.md#ges_prd)에 있다.
