# 유튜브 영상 요약 뷰어 (video digest)

## 배경

### 목표

유튜브 영상 요약을 Lilys AI의 요약 화면처럼 바꾼다. 마크다운 문서 한 장 대신 영상을 보면서 읽는 뷰어를 만든다. 요약 문장마다 근거 대사가 붙고 그 대사를 누르면 영상이 해당 시점으로 이동한다.

참고 화면은 `https://lilys.ai/digest/11870615/15757291`(Figma "Design with Code Layers", 8분 13초)이다. 2026-10-23에 로그인한 브라우저로 직접 눌러보며 동작과 DOM 구조를 확인했다.

### 현재 동작

영상 요약은 role 에이전트 `video-summarizer` 하나가 맡는다(plugin/role-agents/video-summarizer/AGENT.md:1-21).

- yt-dlp, ffmpeg, faster-whisper, OCR을 거쳐 `{제목}-{YYYYMMDD}.md` 파일 하나를 낸다(AGENT.md:86-115, 134-136). 이 절차는 프롬프트에만 있고 실행하는 코드는 없다.
- 시각 정보는 챕터 단위 `MM:SS`뿐이다. 본문 문장에는 근거가 없다.
- 라우팅은 표 한 줄이다(plugin/skills/_shared/proactive-routing.md:44). 전용 스킬은 없고 `ges_agent get`으로 프롬프트를 받아 범용 에이전트에 싣는다(src/mcp/tools/agent-passthrough.ts:62-92).
- 테스트는 레지스트리 등록 확인 하나다(tests/unit/agent/role-agent.test.ts:94).

### 가져다 쓸 수 있는 부품

| 부품 | 위치 | 쓰임 |
| --- | --- | --- |
| zod 스키마와 lint 분리 | src/research/schema.ts, src/research/schema-base.ts | 같은 꼴로 digest 스키마를 만든다 |
| 저장소 관례 | src/research/store.ts | `.gestalt/<기능>/<slug>/`, slug 규칙, `writeJsonAtomic` |
| 단일 HTML 렌더 | src/research/render-html.ts:573, 1085-1090 | CSS와 JS를 인라인으로 싣는 방식. 렌더러 자체는 리서치 절 순서에 묶여 있어 새로 쓴다 |
| 이미지 예산 | src/research/render-html.ts:540-556 | base64로 실을 때 장당, 합계 상한 |
| 자막 파서 | plugin/skills/research/scripts/slide-extract.mjs:82-107 (`parseCues`) | VTT와 SRT에서 태그를 지우고 자동 자막의 반복 줄을 뺀다 |
| 프레임 추출 | slide-extract.mjs:167-176 | ffmpeg로 지정 시각의 JPEG를 뽑는다 |
| 127.0.0.1 서버 | src/local-pr-web/server.ts:91, 155-158, src/graph-viz/port-finder.ts | 포트 탐색, Host 헤더 검사, `open` 패키지로 브라우저 열기 |
| 윤문 흐름 | plugin/skills/_shared/research-humanize.md, src/research/prose.ts:187-195 | `prose_extract`와 `prose_apply`, 마커 보존 검사 |

리서치 스키마의 `video` 블록(src/research/schema.ts:370-395)은 경쟁사 분석용이라 `productId`가 필수다. 요약 뷰어에는 맞지 않아서 쓰지 않는다. `evidence: {type: 'video', clipId, at}` 꼴만 참고한다.

## Lilys 화면 분석

### 화면 구성

| 영역 | 기능 |
| --- | --- |
| 왼쪽 위 | 유튜브 임베드 플레이어(`youtube.com/embed/{id}?enablejsapi=1`) |
| 왼쪽 아래 | 스크립트 패널. 문장마다 `MM:SS` 버튼이 있고 누르면 그 시점으로 이동한다. 재생 중인 문장에 배경색이 깔리고 패널이 따라 내려간다. 화자 구분 토글, 번역 토글, 복사, 접기 버튼이 있다 |
| 가운데 | 도입 요약, 목차, 본문 |
| 가운데 오른쪽 끝 | 목차 미니맵. 지금 읽는 섹션에 `is-current-active`가 붙는다 |
| 상단 툴바 | 요약과 확장 탭, 분량(짧게, 기본, 길게, 쉽게), 커스텀 옵션, 설정, 공유 |
| 오른쪽 | LILY 채팅. 자료를 근거로 답하고 추천 질문을 띄운다 |

본문 안의 기능은 아래와 같다.

- 출처 번호 `[n]`을 누르면 툴팁에 근거 대사 원문과 타임스탬프가 뜬다. 타임스탬프를 누르면 영상이 이동한다. 번호만 눌러서는 이동하지 않는다.
- `<keyword>` 태그로 감싼 용어가 보라색으로 보인다. 누르면 영상 맥락에 맞춘 설명 팝업과 질문 입력창이 뜬다.
- 소섹션마다 그 구간이 시작하는 시각의 영상 프레임이 한 장 붙는다(`thumbnails/{영상id}/{초}.jpg`). 프레임을 눌러도 이동하지 않는다.
- 첫 대섹션에만 AI가 생성한 인포그래픽(`genimg_*.png`)이 있고 확대 버튼이 달려 있다.

툴바의 세부 메뉴는 이렇다.

- 커스텀 옵션: 요약 구간(시작과 끝 시각), 분량, 난이도(보통, 쉽게), 결과 언어, 커스텀 프롬프트
- 설정: 기본 분량, 글자 크기(85%~145%), 수정 모드, 찾기 및 바꾸기
- 내보내기: 링크, PDF, Notion, DOCX, Markdown
- 확장 리포트: 관련 배경지식, 반대 시각 조사, 액션아이템, 댓글 분석, PPT, 마인드맵, 인포그래픽, 카툰, 애니메이션, 플래시카드, 퀴즈, 팟캐스트. 더보기를 펼치면 타임스탬프, 교재, 보고서, 회의록, 사용자 인터뷰, 문헌검토, 논문 리뷰, 중요 인용구, 블로그 등이 더 있고 나만의 템플릿도 만들 수 있다.

### 동작 확인

플레이어가 부모 창으로 보내는 `infoDelivery` 메시지의 `currentTime`을 받아 이동 여부를 확인했다.

| 동작 | 결과 |
| --- | --- |
| 목차 "3.2." 클릭 | 해당 제목이 화면 위 3704px에서 61px 자리로 스크롤됐다 |
| `[13]` 툴팁의 `00:00:57` 클릭 | 44.6초에서 59.3초로 이동했다(57초로 이동한 뒤 2.5초 재생) |
| 스크립트 패널 `00:00:57` 클릭 | 80.5초에서 59.0초로 이동했다 |
| 재생 중 스크립트 | 2분 50초쯤 재생할 때 `02:51` 문장이 칠해져 있었다 |

공유 메뉴를 펼친 화면, 하이라이트 탭, 화자 구분과 번역 토글을 켠 결과는 확인하지 못했다. 분량 재생성과 확장 리포트 생성은 크레딧을 쓰므로 메뉴 구성만 봤다.

### 요약 본문 구조

DOM에서 섹션과 불릿마다 출처 범위를 뽑아 확인했다. 영상 길이는 8분 13초이고 스크립트는 92문장(0~91)이다.

스크립트 전체를 빈틈없이 구간으로 나눈다. 대섹션 4개가 문장 범위를 이어서 나눠 갖는다(0-30, 31-53, 54-74, 75-91). 소섹션 10개도 그 안을 이어서 나눈다. 그래서 요약에서 빠지는 구간이 없다.

출처는 두 값을 함께 들고 있다.

- 화면에 보이는 `[n]`은 근거 범위에서 가장 대표가 되는 문장의 번호다(1부터 센다). 툴팁의 타임스탬프도 이 문장의 시각이다.
- `data-value`에는 근거 범위 전체가 들어 있다. 범위가 `{4,5}`면 `[5]`, `{43}`이면 `[44]`, `{86}`이면 `[87]`로 보인다.

계층마다 맡는 역할이 정해져 있다.

| 자리 | 형태 | 예 |
| --- | --- | --- |
| 도입 | 질문형 첫 문장, 답, 굵게 칠한 핵심 한 줄. 존댓말 | "Figma의 Code Layers는 기존 코드에서 시작해 디자인을 어떻게 탐색하나요?" |
| 대섹션 | 제목과 출처 없는 결론 한 줄 | "에이전트는 하나의 코드 레이어에서 여러 기능 방향을 만들고, 각 방향을 독립적으로 발전시키게 돕는다." |
| 소섹션 | 대섹션마다 2~3개, 대표 프레임 1장 | "2.1. 한 번에 여러 배달 기능 방향 만들기" |
| 1단 불릿 | 굵은 주장 2~4개, 평서체 | "세 가지 안은 주소를 선택하는 서로 다른 방법을 제시한다." |
| 2단 불릿 | a, b, c로 사례와 세부, 인용 | "첫 번째 안은 요청한 **통합 검색 입력창**을 제공한다." |

문체 규칙은 이렇다.

- 원문이 영어여도 요약은 결과 언어(한국어)로 쓴다.
- 고유명사는 원어를 그대로 둔다(Code Layers, Extract designs).
- 번역어 뒤에 원어를 괄호로 단다("격자 보기(grid view)").
- 프롬프트 같은 발화는 번역해서 큰따옴표로 인용한다.
- 화자는 "발표자"로, 다른 사람은 이름(Mari)으로 부른다.
- 문장 안의 핵심 구절만 굵게 칠한다.

## 설계

### 전제

**뷰어는 로컬 서버로 띄운다.** 같은 유튜브 임베드 페이지를 헤드리스 Chrome으로 두 경로에서 열어 비교했다.

| 경로 | 결과 |
| --- | --- |
| `file:///.../index.html` | `onError` 153(플레이어 설정 오류). 재생과 `seekTo` 모두 안 됨 |
| `http://localhost:8765/index.html` | 재생됨, `seekTo(57)` 뒤 58.5초 |

`file://`에는 리퍼러가 없어서 유튜브 플레이어가 거부한다. 그래서 `gestalt digest serve`로 띄운다. HTML을 파일로 직접 열었을 때(`location.protocol === 'file:'`)는 플레이어 자리에 썸네일과 "유튜브에서 열기" 링크를 두고 타임스탬프는 `watch?v={id}&t={초}s` 새 탭 링크로 바꾼다.

**LLM이 필요한 산출물은 요약할 때 미리 만든다.** Execute는 Passthrough라 뷰어 HTML 안에서 LLM을 부르지 않는다. 키워드 설명은 JSON에 미리 담는다. LILY 채팅은 Claude Code 세션이 대신한다.

**video-summarizer의 출력을 JSON 계약으로 바꾼다.** 마크다운은 내보내기로 남긴다(열린 질문 1).

### 저장 구조

```
.gestalt/digest/<slug>/
  digest.json       요약 본문, 키워드, 옵션별 리포트
  transcript.json   문장 단위 스크립트
  frames/           소섹션 프레임 JPEG
  digest.html       렌더 결과
```

### 스키마

`src/digest/schema.ts`에 zod로 정의한다. 출처 꼴은 아래와 같다.

```ts
type Cite = {
  key: number; // 툴팁과 이동에 쓰는 대표 문장 번호
  from: number; // 근거 범위 시작 문장
  to: number; // 근거 범위 끝 문장
};

type Segment = { i: number; startSec: number; text: string; speaker?: string; translation?: string };

type Bullet = { text: string; cite: Cite; children?: Bullet[] };

type Subsection = { id: string; title: string; cite: Cite; frameSec: number; bullets: Bullet[] };

type Section = { id: string; title: string; conclusion: string; cite: Cite; subsections: Subsection[] };

type Keyword = { id: string; term: string; explanation: string; firstCite: Cite };

type Report = {
  options: { length: 'short' | 'default' | 'long'; difficulty: 'normal' | 'easy'; range?: [number, number]; lang: string; prompt?: string };
  lead: { question: string; answer: string; takeaway: string };
  sections: Section[];
  skipped: { from: number; to: number; reason: string }[];
  keywords: Keyword[];
};
```

본문 문장 안의 굵은 구절은 `**...**`로, 키워드는 `{{kw:<id>|표시어}}`로 적는다. 렌더러가 이 두 마커만 해석한다.

### 검사 규칙

`lintDigest`가 스키마 검증 뒤에 돈다.

| 규칙 | 근거 |
| --- | --- |
| 대섹션의 `cite` 범위가 이어서 스크립트 전체를 덮는다. 빈 구간은 `skipped`에 이유와 함께 있어야 한다 | Lilys 구조 "스크립트 전체를 빈틈없이 나눈다" |
| 소섹션 범위가 대섹션 범위를 이어서 덮는다 | 같음 |
| `key`가 `from`과 `to` 사이에 있다 | 툴팁이 범위 밖 문장을 가리키지 않게 |
| 불릿은 2단까지다 | 계층 규칙 |
| 키워드 마커의 id가 `keywords`에 있다 | 팝업이 비지 않게 |
| `frameSec`이 소섹션 범위의 첫 문장 시각과 맞다 | 프레임이 엉뚱한 장면을 보이지 않게 |

분량 규칙(소섹션 2~3개, 1단 불릿 2~4개)은 lint 경고로만 둔다. 영상마다 맞는 분량이 달라서 막지는 않는다.

### 수집

`gestalt digest ingest <url|파일>`이 맡는다.

1. yt-dlp로 메타데이터(제목, 채널, 길이, 게시일)와 자막을 받는다.
2. `parseCues`를 `src/digest/captions.ts`로 옮겨 쓰고 자막 조각을 문장 단위로 합친다. 문장 끝 부호가 없는 자동 자막은 길이와 쉼 간격으로 끊는다.
3. 자막이 없으면 faster-whisper로 넘어간다.
4. 요약이 끝나 `frameSec`이 정해지면 `gestalt digest frames <slug>`가 영상을 낮은 화질로 받아 시각마다 한 장씩 뽑는다. 403이 나면 `player_client=web_embedded`로 다시 시도한다.

`slide-extract.mjs`는 플러그인 자산이라 빌드된 `src/`를 import하지 않는다. 당분간 두 벌을 두고 같은 자막 픽스처로 두 파서의 결과가 같은지 테스트로 확인한다.

### 요약 작성

스킬이 호스트 세션에 `transcript.json`을 문장 번호와 함께 넘기고 `digest.json`을 쓰게 한다.

- 프롬프트에 "Lilys 화면 분석"의 계층 규칙과 문체 규칙을 그대로 넣는다.
- 긴 영상은 먼저 대섹션 경계만 정하고 대섹션마다 따로 쓴다. 도입과 키워드는 마지막에 전체를 보고 쓴다.
- 쓴 뒤 `ges_digest validate`를 돌리고 lint 오류를 고칠 때까지 반복한다.
- 윤문은 research와 같은 절차로 한다. `prose_extract`가 본문 문장을 뽑고 `humanize-monolith`가 고친 뒤 `prose_apply`가 되돌려 넣는다. 마커 보존 검사에 `**`와 `{{kw:}}`를 더한다. 출처는 문장 밖 필드라 윤문이 건드리지 못한다.

### 뷰어

`src/digest/render-html.ts`가 단일 HTML을 만든다. JS는 프레임워크 없이 인라인으로 싣는다(`src/research/canvas-view.ts`와 같은 방식).

| 기능 | 구현 |
| --- | --- |
| 플레이어 | 어댑터 `{ seek(sec), cue(sec), currentTime() }`. 1차는 YouTube IFrame API, 2차에 HTML5 `<video>`를 붙인다 |
| 스크립트 따라가기 | 250ms마다 `currentTime()`을 읽고 이진 탐색으로 현재 문장을 찾는다. 사용자가 패널을 직접 스크롤하면 3초 동안 따라가지 않는다 |
| 소섹션 따라가기 | 본문을 스크롤해 소섹션이 화면 위쪽에 들어오면 영상을 그 소섹션 첫 문장으로 옮긴다. 재생 중이면 이어서 재생하고 재생 전이면 위치만 잡는다. 재생 위치가 이미 그 소섹션 안이면 옮기지 않는다 |
| 미니 플레이어 | 플레이어 자리가 화면 밖으로 나가면 오른쪽 아래에 작게 띄운다. 닫으면 플레이어 자리가 다시 보일 때까지 안 띄운다. 넓은 화면은 왼쪽 패널이 고정이라 뜰 일이 없다 |
| 출처 툴팁 | `[key+1]`을 누르면 `from~to` 문장과 `key` 시각을 띄운다. 시각을 누르면 `seek` |
| 목차와 미니맵 | 앵커 링크, IntersectionObserver로 현재 섹션 표시 |
| 키워드 팝업 | `explanation`을 띄운다 |
| 프레임 | 소섹션 위에 싣고 누르면 `frameSec`으로 이동한다. Lilys에는 없는 동작이다 |
| 설정 | 글자 크기 85%~145%, localStorage에 저장 |
| 내보내기 | 마크다운 복사(기존 video-summarizer 출력 대체) |

프레임은 서버가 `frames/`를 그대로 내준다. 파일로 열었을 때도 보이도록 상대 경로로 둔다.

### 서버

`gestalt digest serve <slug> [--port] [--no-browser]`를 둔다. `src/local-pr-web/server.ts`의 127.0.0.1 바인딩과 Host 헤더 검사, `src/graph-viz/port-finder.ts`의 포트 탐색, `open` 패키지 동적 import를 그대로 따른다. `.gestalt/digest/` 밖 경로 요청은 realpath로 막는다(src/mcp/tools/research-passthrough.ts:290-303과 같은 검사).

### MCP와 스킬

- `ges_digest` 도구를 새로 두고 action은 `validate`, `render`, `prose_extract`, `prose_apply`로 시작한다. `ingest`, `frames`, `serve`는 셸 명령이라 CLI로 둔다. research가 `slide-extract.mjs`를 MCP action으로 두지 않은 것과 같은 이유다(plugin/skills/research/references/design.md:939).
- `plugin/skills/video-digest/SKILL.md`: ingest → 요약 작성 → validate → 윤문 → frames → render → serve
- 라우팅 표의 영상 줄(proactive-routing.md:44)을 스킬로 바꾼다.

## 바꿀 파일

| 파일 | 변경 |
| --- | --- |
| src/digest/schema.ts, lint.ts, store.ts | 새로 만든다 |
| src/digest/captions.ts | `parseCues` 포팅과 문장 병합 |
| src/digest/render-html.ts, viewer-js.ts | 렌더러와 인라인 JS |
| src/digest/server.ts | 로컬 서버 |
| src/digest/prose.ts | 윤문 추출과 적용 |
| src/cli/index.ts | `digest ingest`, `digest frames`, `digest serve` |
| src/mcp/schemas.ts, src/mcp/server.ts, src/mcp/tools/digest-passthrough.ts | `ges_digest` |
| plugin/skills/video-digest/SKILL.md | 새 스킬 |
| plugin/role-agents/video-summarizer/AGENT.md | 출력 계약을 JSON으로 |
| plugin/skills/_shared/proactive-routing.md | 영상 줄 |
| docs/mcp-reference.md, README.md, README.ko.md | `ges_digest`를 더한다. 빠져 있는 `ges_research`도 함께 채운다 |
| CHANGELOG.md | 항목 추가 |

## 테스트

- 스키마와 lint: 범위가 비거나 겹치는 경우, `key`가 범위 밖인 경우, 3단 불릿, 없는 키워드 id
- 자막 병합: 수동 자막, 문장 부호 없는 자동 자막, `slide-extract.mjs`의 `parseCues`와 결과 비교
- 렌더: 마커 해석, `file://` 대체 링크, 이미지 예산
- 서버: 127.0.0.1 바인딩, Host 헤더, 경로 탈출
- MCP: `tests/unit/mcp/server.test.ts`의 도구 목록과 `registered-schema-parity.test.ts`
- 수동 확인: 참고 영상(Figma, 8분 13초)을 돌려 대섹션 4개 안팎, 소섹션 10개 안팎이 나오는지 본다. 재생, 목차 이동, 출처 이동, 스크립트 따라가기 네 가지가 동작해야 한다. 1시간 넘는 한국어 영상으로 대섹션별 작성 경로도 한 번 돌린다.

## PR 나누기

### 1차에서 만드는 핵심 뷰어

| PR | 내용 |
| --- | --- |
| 1-1 | 스키마, lint, 저장소, 단위 테스트 |
| 1-2 | `digest ingest`와 `digest frames`, 자막 병합, whisper 대체 경로 |
| 1-3 | 렌더러, 뷰어 JS, `digest serve` |
| 1-4 | `ges_digest`, 스킬, video-summarizer 출력 계약, 윤문, 라우팅과 문서 |

1-4가 들어가야 처음부터 끝까지 돈다. 1-1~1-3은 픽스처 JSON으로 각자 테스트한다.

### 2차에서 붙이는 요약 옵션

| PR | 내용 |
| --- | --- |
| 2-1 | `reports[]`로 분량과 난이도별 리포트를 저장하고 툴바에서 바꿔 본다. 없는 조합을 고르면 세션에 붙여 넣을 생성 명령을 복사해 준다 |
| 2-2 | 구간 지정, 결과 언어, 커스텀 프롬프트. 구간은 스크립트를 그 범위로 잘라 같은 파이프라인을 돌린다 |
| 2-3 | 스크립트 번역 토글(`Segment.translation`), 로컬 영상 파일 플레이어 |
| 2-4 | `ingest --ocr`. 화면 글자를 프레임에서 읽어 요약 입력에 더한다. 1차에서 video-summarizer의 OCR 단계를 뺐으므로 여기서 다시 붙인다 |

화자 구분은 whisper만으로 안 되고 pyannote를 따로 설치해야 해서 미룬다.

### 3차에서 붙이는 확장 리포트

| PR | 내용 |
| --- | --- |
| 3-1 | 템플릿 체계. `plugin/skills/video-digest/templates/*.md`(기본 제공)와 `.gestalt/digest/templates/`(사용자 템플릿)에 프롬프트와 출력 블록 타입을 정의하고 뷰어에 확장 탭을 둔다 |
| 3-2 | 텍스트 템플릿: 회의록과 액션아이템(지금 video-summarizer의 유형별 섹션을 옮긴다), 타임스탬프, 중요 인용구, 관련 배경지식, 반대 시각, 블로그. 인용과 근거에는 1차의 `Cite`를 그대로 단다 |
| 3-3 | 인터랙티브 템플릿: 플래시카드, 퀴즈, 마인드맵(트리 JSON을 인라인 SVG로), 댓글 분석(`yt-dlp --write-comments`) |
| 3-4 | 대섹션 도식. Lilys의 생성 이미지 대신 Claude가 SVG를 그리고 확대 버튼을 단다 |

카툰, 애니메이션, 팟캐스트는 이미지나 음성 생성이 필요해서 범위에서 뺀다. PPT는 기존 presentation 스킬로 연결만 한다.

## 열린 질문

1. 기존 video-summarizer의 마크다운 출력을 바로 대체할지, 당분간 둘 다 둘지. 출력 경로가 둘이면 프롬프트와 테스트를 두 벌 관리해야 해서 대체하고 마크다운은 내보내기로 남기는 쪽을 제안한다.
2. 자막 소스의 우선순위. 수동 자막, 자동 자막(문장 병합), whisper 순을 제안한다. whisper large-v3는 CPU에서 1시간 영상에 수십 분이 걸려 마지막 수단으로 둔다. 자동 자막의 문장 병합 품질이 나쁘면 whisper를 앞으로 당긴다.
3. 이름. `digest`(`ges_digest`, `gestalt digest`, `.gestalt/digest/`)를 제안한다.
4. 2-1에서 없는 조합을 골랐을 때 명령을 복사해 주는 것으로 충분한지. 뷰어에서 바로 생성하려면 서버가 세션에 요청을 넘길 통로가 필요한데 지금 구조에는 없다.
   → 2차 착수 전에 복사로 충분하다고 정했다. serve 서버는 읽기 전용으로 둔다. 리포트를 더하는 길은 스킬이 쓴 리포트 파일을 `gestalt digest merge`로 합치는 것 하나다.

## 1차 인터뷰에서 정한 것

열린 질문 1~3은 제안대로 정했다. 4는 2차 범위라 1차에서 다루지 않았다. 인터뷰에서 설계와 달라지거나 새로 정한 것은 아래와 같다.

- **요약과 표현을 두 층으로 나눈다.** video-summarizer는 `transcript.json`을 읽고 `digest.json`만 쓴다. HTML과 마크다운은 렌더러가 코드로 만들고 LLM을 부르지 않는다. 요약을 다시 쓰지 않고 뷰어만 고쳐 다시 뽑을 수 있다.
- **`export --md`는 1차에 넣는다.** video-summarizer의 마크다운 출력을 바로 대체하므로 같은 결과를 얻을 길이 1차부터 있어야 한다.
- **OCR은 2차 `ingest --ocr`로 넘긴다.** 기존 video-summarizer에 있던 단계지만 자막만으로 출처가 다 맞고 프레임 추출 경로와 함께 붙이는 게 자연스럽다.
- **`Section.diagram`은 1차 스키마에서 뺐다.** 도식은 3-4에서 붙이고 그때 필드를 더한다. 쓰지 않는 선택 필드를 먼저 두면 요약 작성자가 빈 값을 채우려 든다.
- 유형별 섹션(회의록, 강의 리소스, 인터뷰 Q&A)은 3-2 템플릿으로 옮긴다. 1차의 video-summarizer는 유형을 가리지 않는다.
