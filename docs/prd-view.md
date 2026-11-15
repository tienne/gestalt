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

`outDir`에 이미 `index.html`이 있으면 조심한다. PRD 뷰가 쓴 파일은 첫 줄에 `<!-- gestalt-prd-view v1 -->` 표시가 있어서 그냥 갱신한다. 표시가 없는 파일은 `OUT_FILE_EXISTS`로 막고 `overwrite: true`일 때만 덮는다. 앱 폴더를 잘못 주면 실제 `index.html`이 날아가기 때문이다. 심볼릭 링크는 `overwrite`여도 쓰지 않는다.

HTML은 외부 파일을 불러오지 않는 한 장짜리라 `file://`로 바로 열린다. 테마 선택은 영상 요약 뷰어와 같이 쓴다.

## 블록 어휘

모든 블록에 붙는 칸은 아래와 같다.

| 칸 | 뜻 |
|---|---|
| `id` | 문서 안에서 겹치지 않는 id |
| `src` | 원문 줄 범위 배열 `[[시작, 끝], ...]`. 1부터 세고 끝 줄도 포함한다 |
| `summary` | 원문을 줄여 쓴 블록이면 `true`. 글자 대조를 건너뛰고 화면에 "요약" 배지가 붙는다 |
| `audience` | 읽을 사람 태그 `pm`, `dev`, `design`, `qa`, `data` |

| 블록 | 쓰는 자리 | 주요 칸 |
|---|---|---|
| `claim` | 한 문장으로 서는 주장 | `text`, `status`(`confirmed`, `assumed`, `open`) |
| `requirement` | 요구사항 하나 | `title`, `why`(가설), `boundary`(안 하는 것), `phase`(`mvp`, `later`), `metrics`(연결 지표 id), `detail` |
| `metric` | 성공 지표 하나 | `metricId`, `name`, `role`, `denominator`, `baseline`, `target`, `measure` |
| `decision` | 정한 것과 버린 안 | `decided`, `why`, `rejected[{ option, reason }]` |
| `question` | 아직 안 정한 것 | `item`, `owner`, `due` |
| `prose` | 맞는 블록이 없을 때 | `text` |

원문에 없는 칸은 필드를 빼서 비워 둔다. 화면에는 "원문에 없음"으로 회색 칸이 남는다. 비어 있다는 사실도 보여야 해서다.

문서 바깥 틀은 이렇다.

```json
{
  "schemaVersion": "1.0.0",
  "slug": "rental-reco",
  "meta": { "title": "...", "source": "docs/rental/PRD.md", "sourceSha256": "...", "rows": [{ "key": "오너", "value": "...", "src": [[9, 9]] }] },
  "sections": [{ "id": "problem", "title": "문제", "blocks": [] }],
  "omitted": [{ "src": [[42, 44]], "reason": "변경 이력" }]
}
```

`omitted`는 변경 이력처럼 일부러 옮기지 않는 구간이다. 이걸 안 두면 세션이 빠진 줄을 채우려고 보일러플레이트를 `prose`로 옮기게 된다.

## 검사

`validate`는 원문과 뷰를 대조한다. 의미까지 보지는 않는다. 블록 글이 지목한 줄 근처에서 왔는지, 원문 내용 줄이 어딘가에 옮겨졌는지까지만 확인한다.

**원문 대조.** 블록 글과 원문 범위를 NFKC로 정규화하고 마크다운 기호, 공백, 구두점을 지운 뒤 비교한다. 부분 문자열이거나 글자 bigram이 60% 넘게 겹치면 원문에서 온 글로 본다. 한국어는 조사가 자주 바뀌어서 단어가 아니라 글자로 비교한다. 숫자는 `summary` 블록에도 따로 대조한다.

**빠진 줄(coverage).** 빈 줄, frontmatter, 표 구분선, 헤딩만 있는 줄을 뺀 내용 줄 가운데 어느 블록에도 `meta.rows`에도 `omitted`에도 안 걸린 줄의 비율을 센다. 10%를 넘으면 경고를 내고 30%를 넘으면 오류로 보고 렌더를 막는다. 빠진 구간은 `coverage.ranges`에 줄 범위와 첫 줄 미리보기로 실린다.

오류(렌더를 막는다)

| 코드 | 조건 |
|---|---|
| `DUPLICATE_ID` | 섹션이나 블록 id가 겹친다 |
| `DUPLICATE_METRIC_ID` | 같은 `metricId`가 둘 이상 |
| `UNKNOWN_METRIC` | requirement가 없는 지표 id를 가리킨다 |
| `SRC_OUT_OF_RANGE` | src가 원문 줄 수를 넘는다 |
| `SRC_ON_BLANK` | src에 내용 줄이 하나도 없다 |
| `COVERAGE_LOW` | 빠진 줄이 30% 초과 |

경고

| 코드 | 조건 |
|---|---|
| `COVERAGE_GAP` | 빠진 줄이 10% 초과 |
| `TEXT_NOT_IN_SOURCE` | `summary`가 아닌 블록 글이 src 범위에 없다 |
| `NUMBER_NOT_IN_SOURCE` | 블록의 숫자가 src 범위에 없다 |
| `METRIC_ID_NOT_IN_SOURCE` | `metricId`가 src 범위에 없다 |
| `SRC_TOO_WIDE` | `summary`가 아닌 블록이 내용 줄 25줄 넘게 잡는다 |
| `SRC_COVERS_MOST` | 블록 하나가 문서 내용 줄의 40% 넘게 잡는다 |
| `SECTION_TITLE_NOT_IN_SOURCE` | 섹션 제목이 원문 헤딩에 없다 |
| `SOURCE_STALE` | `meta.sourceSha256`이 지금 원문과 다르다 |
| `OMITTED_TOO_MUCH` | 생략 선언이 내용 줄의 25% 초과 |

## 범위 밖

- PRD를 새로 쓰거나 고치는 일. 원문은 읽기만 한다.
- 와이어프레임이나 화면 시안 만들기.

도구 파라미터와 응답 모양은 [MCP 레퍼런스](./mcp-reference.md#ges_prd)에 있다.
