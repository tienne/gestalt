# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.53.0] - 2026-08-07

### Added
- quality-reviewer가 불필요한 주석을 잡는다. 코드를 읽거나 `git log`로 확인되는 내용이면 주석으로 남길 이유가 없고, 코드가 바뀔 때 같이 안 고쳐져서 거짓말이 된다
  - 코멘트 남기는 대상: 코드를 그대로 옮긴 주석(`count += 1` 위의 `// 카운트를 1 증가`), 변경 이력 메모(`// 2026-03-12 수정`), 주석 처리된 죽은 코드, 섹션 배너(`// ===== helpers =====`), 티켓 번호 없는 TODO
  - 남기는 건 왜 이렇게 짰는지뿐이다. 외부 API 버그 우회, 성능 제약, 겉보기에 틀려 보이는 코드가 의도된 것이라는 근거
  - 지우자고만 하지 않고 대체안까지 낸다. 이름 풀어쓰기, 함수 추출, 매직 넘버를 이름 붙은 상수로, 배경이 길면 README나 ADR로 옮기고 링크만
  - 코드와 어긋난 주석이랑 죽은 코드는 `high`, 나머지는 `warning`. PR 인라인 코멘트에는 각각 `r:`, `c:` 접두어로 나간다

## [0.52.0] - 2026-08-06

### Added
- `gestalt humanize-check` — 윤문 결과를 모델 자평이 아니라 코드로 판단한다. 변경률, S1 잔존, 보호 토큰 생존, 구조 보존을 각각 재고 exit code로 답한다
  - 문자 기반 변경률 하나로는 구조 편집이 안 보였다. 변경률 2.8%인데 문장 3할이 갈려나간 경우가 있었다
  - 룰 목록은 `ai-tell-quick-rules.md`를 읽어서 만든다. 코드에 룰을 복사하지 않는다
  - 정규식으로 오탐 없이 셀 수 있는 21개만 탐지한다. 뜻을 봐야 하는 룰은 뺐다
  - 보호 토큰(수치, 인용, 코드, URL)이 유실되면 경고가 아니라 채택 금지다
- `pnpm verify:rules` — 룰북과 에이전트 문서 14곳의 룰 ID랑 심각도가 어긋났는지 본다. 처음 돌렸을 때 7개가 어긋나 있었다

### Changed
- AI 산문 60편과 2022년 이전 한국어 산문 60편을 대조한 결과로 심각도를 조정했다. 원어민이 오히려 더 쓰는 표현을 무조건 지우면 사람 글이 AI 글이 된다
  - `~를 통해` S1 → S2 (비번역 84.4 vs 번역 42.1로 원어민이 2배 더 쓴다)
  - `~한 것이다` S1 → S2, 연속 3회 이상일 때만
  - 부정 대구 S2 → S1 (사람이 쓰는 빈도 대비 9.2배로 가장 센 신호)
  - 대화와 리뷰 코멘트에서는 앞의 둘을 S1로 남겼다. 잰 게 문서 산문이라 말투에는 그대로 안 붙는다
- 업계에서 굳은 음차를 화이트리스트에 넣었다 (소스, 롤백, 파싱, 레지스트리, 불릿). 즉석 조합인 "불릿 리스트"만 "불릿 목록"으로 바꿨다
- 화이트리스트 밖 음차 정리: SSOT/SoT → 기준 문서, 승인 게이트 → 승인 단계, 레이어 → 자리마다 계층이나 묶음, 단계, 역할
  - "레이어 → 계층"으로 일괄 치환했더니 받침이 생기면서 조사가 깨졌다 (`계층라면`, `계층(…)는`). 찾아 바꾸기로 밀 수 있는 작업이 아니다
- `humanize-gate` → `humanize-check`. 한국어 문서는 전부 "검사"로 갔는데 명령어만 gate로 남아 있었다
- 지라 티켓 템플릿 `## 인수조건 (AC)` → `## 완료 조건`. WDS 전체에 "인수조건"이 5개뿐이었고 그중 넷이 한 묶음이라 팀이 쓰는 말이 아니었다

## [0.51.0] - 2026-08-06

### Changed
- 에이전트 frontmatter의 tier가 실제 모델 선택으로 이어진다. 그동안 frontier로 선언한 architect, harness-architect, continuity-judge가 라벨만 붙어 있고 아무 효과가 없었다
  - `ges_agent get`이 tier와 함께 해석된 model을 돌려주고, 스킬이 서브에이전트를 띄울 때 그 값을 Agent 도구 model 파라미터로 넘긴다
  - 기본 표는 frugal=haiku, standard=sonnet, frontier=opus. `gestalt.json`의 `tierModels`나 `GESTALT_TIER_MODEL_*`로 바꾼다
  - 기본 모델을 `claude-sonnet-4-6`에서 `claude-sonnet-5`로 올렸다

### Removed
- 죽은 모델 라우팅 경로 제거. FiguralRouter는 인스턴스화하는 곳이 0곳이었고, `resolvePromptModel`은 결과를 읽어갈 훅이 레포에 없었다. 둘 다 `index.ts`에서 안 내보내서 공개 API는 그대로다

## [0.50.0] - 2026-08-06

### Changed
- 공유 룰북 세 개(author-voice, ai-tell-quick-rules, style-guide)를 `plugin/role-agents/_shared/references/`로 옮겼다. 다섯 개 넘는 에이전트가 함께 쓰는데 경로가 technical-writer 하위였다
  - 참조 26곳을 고치면서 원래 깨져 있던 링크 2개도 같이 고쳤다

## [0.49.1] - 2026-08-06

### Fixed
- "수준"으로 정도를 뭉개지 않는다. "매끄럽게 다듬는 수준이고"는 등급 어감이 실려서 채점처럼 읽힌다 → "정도"로 쓰거나 아예 동사로 푼다
- I-5 세는 단위 규칙에 가드를 붙였다. "안 돌려본 건 PR에 적어두셔서"의 "건"은 "것은"의 준말이라 늘려 쓰면 오히려 딱딱해지는데, 글자로 매칭하면 이걸 잘못 고쳤다
- 가운뎃점을 금지하는 문서가 정작 본문 산문에서 가운뎃점을 쓰고 있었다

## [0.49.0] - 2026-08-06

### Added
- 리뷰 리포트 이슈마다 해당 라인 주변 코드를 붙인다. 고정 3줄은 코드마다 안 맞아서, 위아래 5줄에서 시작해 들여쓰기로 감싸는 블록을 추정해 창을 조정한다
  - 위로는 감싸는 선언을 2단계까지 붙인다. 함수 안 for 문에서 걸린 이슈면 for와 함수 선언이 함께 보인다
  - 아래로는 감싸는 블록이 끝나는 라인에서 멈춘다. 다음 함수를 넘보지 않는다

### Fixed
- 리뷰 코멘트를 "지적"이라 부르지 않는다. 상대를 잡아세우는 뉘앙스가 붙어 제안형 어투와 어긋난다. 내가 남긴 건 "남겼던 의견", 상대가 남긴 건 "짚어주신 부분"으로 쓴다
- 식별자 뒤 조사 붙여쓰기 점검 추가: `6564d04 에서` → `6564d04에서`, `c: 로` → `c:로`
- 한자어 명사를 동사로 풀고, 추상명사에 이동 동사를 붙이지 않는다: "강등 방향도 맞게 갔습니다" → "심각도 내린 것도 맞습니다"

### Documentation
- 릴리즈 절차에 태그 이동 단계(5.5)를 넣었다. `npm version`이 찍는 태그가 매니페스트 커밋보다 앞을 가리키는데 Actions는 태그를 체크아웃해 빌드해서, v0.47.1 태그에 0.47.0 매니페스트가 실려 나갔다

## [0.48.0] - 2026-08-06

### Added
- humanize-monolith에 탐지 모드 추가. 고치지 말고 짚어만 달라는 요청용으로, 원문을 한 글자도 안 바꾸고 룰 ID와 원문 인용, 한 줄 처방만 돌려준다
  - 교정문을 예시로도 안 붙인다. 붙이면 복붙해서 사실상 윤문 모드가 된다
  - AI가 썼는지 판정하지 않고 A~D 등급도 안 매긴다. 남의 원문에 등급을 붙이면 점수질이 된다. S1과 S2 개수만 센다
- `pnpm verify:plugin` — `dist/plugin`이 원본과 바이트 단위로 같은지 확인한다. postbuild가 `cp -r`만 해서 `plugin/`에서 지운 스킬이 dist에 남아 유령 스킬로 로드됐다

### Changed
- 삭제 처방은 삭제다. 모델이 리듬을 살리려고 새 마무리 문장이나 새 부제를 지어 넣는 일이 잦았다
  - 콜론 부제는 콜론 뒤를 버리고 앞부분만 남긴다. 부제를 갈아끼우면 패턴이 그대로 남는다
  - hype 어휘는 원문에 수치가 없으면 만들지 말고 수식어만 지운다

## [0.47.1] - 2026-08-04

### Added
- Codex 슬래시 커맨드 6개. skills만 내보내면 Codex의 `/` 목록에 안 떠서 자연어나 멘션으로만 부를 수 있었다. Codex에 내장 review가 있어 `gestalt-` 접두어를 붙였다

## [0.47.0] - 2026-08-04

### Added
- Codex 플러그인 매니페스트. `codex plugin add`로 MCP 서버와 스킬 18개를 한 번에 받는다. 그전까지 Codex 사용자는 MCP 도구만 쓸 수 있었다

### Changed
- 배포 자산 다섯 개를 `plugin/` 하나로 모아 단일 소스로 뒀다. Codex는 마켓플레이스가 가리킨 디렉토리를 통째로 복사해서 레포 루트를 가리키면 `.git`과 `node_modules`까지 딸려가 1.6GB가 되고, 심링크는 따라가지 않아 자산을 링크로 공유할 수도 없었다

### Fixed
- `npm version` 후 `plugin/.codex-plugin/plugin.json`만 옛 버전으로 남던 문제. `codex plugin list`가 이 값을 보여줘서 설치된 버전이 실제와 달라 보였다

## [0.46.1] - 2026-08-04

### Fixed
- 어투 문서가 자기가 금지한 말을 본문에서 쓰고 있었다. 에이전트가 그걸 배워 산출물로 내보내는 경로다
  - 증류 7곳 → 추려낸, 뽑아낸 (금지어 예시 자리는 그대로 뒀다)
  - 레지스터(음차) 8개와 register(영어) 7개 → "말투"로 통일
  - lexicon, metric, anchor → 표현, 지표, 근거
- "실측"을 걷어냈다. code-review-writer가 이 문서를 필수로 읽다 보니 실제 PR 리뷰에 "레포 실측으로 1444개 중"으로 새어나갔다. 세어본 걸 그렇게 부르면 단어만 튀지만, 대조한 걸 그렇게 부르면 근거 과장이라 리뷰이가 검증 없이 받아들이는 쪽으로 간다

## [0.46.0] - 2026-08-04

### Added
- 리뷰 코멘트 헤지 밀도 상한. "~것 같아요"를 보존 대상으로만 규정해두니 모든 문장에 붙어서, 문장은 자연스러운데 리뷰 전체가 기계로 읽혔다. 코멘트당 1회, 리뷰 전체의 절반 이하로 뒀다
- 안 굳은 음차(에스케이프 해치, 스파이크)가 리뷰 대상 원문에 있다는 이유로 화이트리스트를 통과하던 것을 막았다. 코드블록과 인용은 그대로 두고, 리뷰어 자기 문장은 첫 등장에 풀어쓴다

## [0.45.0] - 2026-07-31

### Added
- `dispatch` 스킬 — execute의 실행 단계를 외부 에이전트 런타임 터미널로 뿌린다
  - 병렬 자체가 목적이 아니다. execute가 이미 Agent 도구로 병렬을 돌린다. 이걸로 얻는 건 워커별 다른 CLI와 사람이 들여다볼 수 있는 터미널, worker_done 생애주기 셋이다
  - 런타임 감지에 실패하면 흉내내지 않고 기본 경로를 권하며 멈춘다

### Fixed
- SQLite 연결에 `busy_timeout` 설정. 이벤트 DB가 홈 글로벌 경로(`~/.gestalt/events.db`)이고 MCP 서버는 세션마다 프로세스가 따로 떠서, 같은 레포에서 창을 두 개만 열어도 잠금이 풀리기를 기다리지 않고 SQLITE_BUSY로 즉시 실패했다
  - 코드 그래프 DB도 같이 걸었다. post-commit 훅이 증분 빌드를 도는 동안 다른 창에서 blast_radius를 돌리는 상황이 실제로 생긴다

## [0.44.0] - 2026-07-31

### Added
- `review-reply` 스킬 — 받은 리뷰를 반영하고 답글까지 게시한다. review 스킬은 리뷰를 만드는 방향이라 게시 경로가 `pulls/{n}/reviews`뿐이었고, 답글은 스레드 API라 붙일 데가 없었다
  - 미해결 스레드는 REST가 resolved 여부를 안 줘서 GraphQL `reviewThreads`로 조회한다
  - accept로 분류했는데 커밋이 없으면 답글을 쓰지 않는다. "반영했습니다"는 리뷰어가 approve 근거로 삼는 사실 주장이라서다
  - 스레드 resolve 기본값은 false로 뒀다. 해결 판단은 리뷰어 몫이다
- `code-review-responder` 에이전트 — 리뷰 받는 쪽 답글 전담. 기존 code-review-writer는 리뷰어 관점 전용이라 severity 판정과 r/c/a 접두어가 답변에 안 맞았다
- `sessionId`에 `active`, `latest` 셀렉터 지원

### Documentation
- 외부에서 읽어온 텍스트를 다루는 규칙과 도구가 없을 때의 대응을 `_shared/`로 뺐다

## [0.43.0] - 2026-07-30

### Added
- `nextTaskIds` — 지금 동시에 착수 가능한 태스크 집합을 `execute_task`, `resume`, `status` 세 경로에 싣는다. 실행 자체는 그대로 순차고, 병렬로 붙일지는 호스트가 판단한다
  - 세션 갱신과 이벤트 replay가 `computeReadyTaskIds` 한 함수를 쓴다
  - replay 경로가 그동안 `nextTaskId`를 null에서 갱신하지 않아, 서버 재시작 후 `ges_status`는 null인데 `resume`은 정상값을 내보내 같은 세션에 두 응답이 어긋났다. 이번에 함께 풀렸다

### Documentation
- 스킬 description에 경계 선언 추가. 겹치는 스킬이 여럿인데 언제 쓸지만 적혀 있어 오발동 여지가 있었다. blast-radius는 안 고친 코드, diff-radius는 이미 고친 변경, pr은 만들기, review는 검토 식으로 한 줄씩 달았다

## [0.42.1] - 2026-07-26

### Fixed
- 인터뷰 Continuity 원리의 모순 감지가 존재하지 않는 차원명을 비교해 항상 false로 나오던 버그. 감지된 모순을 세션과 이벤트에 남겨 라운드별로 조회할 수 있게 했다
- 코드 그래프 증분 빌드에서 역방향 엣지가 사라지던 문제. 파일 F만 바뀌면 F를 참조하는 A가 재파싱 대상에서 빠져 `deleteByFile`이 지운 A→F 엣지가 안 살아났다. 1-hop 참조 파일을 함께 재파싱한다
- Drift 감지가 상시 발화하던 문제. Jaccard 유사도가 구조적으로 낮게 나와 정렬된 산출물도 CRITICAL로 판정됐다. 임베딩 코사인 유사도로 바꾸고 임계값을 0.3에서 0.6으로 올렸다 (임베딩 실패 시 Jaccard 폴백)
- 세션 replay가 `completedTaskIds`를 복원하지 않아 서버 재시작 후 진행률이 0%로 보이던 문제. `evolve_fix`가 이벤트 없이 세션을 직접 바꿔 replay가 라이브와 어긋나던 것도 함께 고쳤다
- 텍스트 기반 스펙 생성이 `resolutionScore`를 1로 하드코딩해 "완벽 해상도" 스펙으로 오기록되던 문제 → null(명시적 미채점)
- `force: true`로 해상도 임계값을 우회할 때 감사 이벤트(`SPEC_FORCE_OVERRIDE`)가 안 남던 문제

## [0.42.0] - 2026-07-25

### Added
- `presentation-writer` 에이전트와 `presentation` 스킬. 슬라이드별 메시지와 카피, 발표 노트는 writer가 쓰고 Reveal.js 구조와 비주얼은 기존 presentation-designer가 맡아 역할을 나눴다

### Fixed
- `ges_code_graph`에 `diff_radius` 액션과 `diffMode` 파라미터가 MCP 클라이언트에 광고되지 않던 문제. `server.ts`의 입력 스키마가 `schemas.ts`와 어긋나 있었다

### Documentation
- README와 CLAUDE.md, mcp-reference의 도구 개수와 에이전트 개수를 실제 코드에 맞췄다. 설치 안내 표에 "13 Role+3 Review"라고 적혀 있었는데 실제는 9 Role에 4 Review였다
- 누락된 MCP 도구 5개(`ges_graph_visualize`, `ges_generate_kb`, `ges_search`, `ges_sync` 등) 문서화
- v0.27.0~v0.41.1 이력 보강

## [0.41.1] - 2026-07-23

### Documentation
- 코드 리뷰 코멘트 어투: 명사 압축·기술 비유 명사 교정 룰 추가

## [0.41.0] - 2026-07-21

### Added
- `jira-writer` role agent + `jira-create` 스킬 추가 — 지라 티켓 본문 구조화 후 승인 게이트를 거쳐 생성
- `slack-send` 스킬 추가 — 슬랙 메시지 다듬기 → 승인 게이트 → 전송·예약 발송

## [0.40.0] - 2026-07-18

### Added
- `slack-messenger` role agent 추가 — 슬랙 메시지 작성 및 어투 다듬기, 자동 라우팅 표 등록

## [0.39.0] - 2026-07-15

### Changed
- 게슈탈트 용어(Figure-Ground 등)의 표면/심층 분리 — MCP 경계에서만 sanitize, 매핑 소스는 `src/gestalt/surface-labels.ts`

### Documentation
- 코드 리뷰 코멘트에 r/c/a 접두어 컨벤션 도입, GFM 개행 규칙 적용

## [0.38.0] - 2026-07-14

### Added
- `continuity-judge` 정합 심급(consistency judge) 감독 단계 추가 — 리뷰 결과의 결함 여부뿐 아니라 목표 정합까지 판단
- `review_consensus` 판정에 정합 심급 결과 병합 (blocking)
- `ges_agent` get 액션에 원리 에이전트(gestalt principle agent) 레지스트리 fallback 추가

### Documentation
- `gestalt-develop`, `/review` 스킬에 정합 심급 판단 단계 반영, 재리뷰 시 재평가 명시

## [0.37.0] - 2026-07-03

### Added
- `reasoningModel` / `reasoningModelFallback` 설정 추가 — 스펙·플래닝 등 깊은 추론용 모델 지정
- `ges_status` 응답에 `reasoningModel` 설정값 노출

### Fixed
- 은퇴한 모델 ID를 현행 alias로 교체

### Documentation
- `reasoningModel` 설정 문서화, spec/execute 스킬에 서브에이전트 스폰 지시 추가

## [0.36.2] - 2026-07-02

### Changed
- 어투 규칙: 가운뎃점 나열(C-12) 규칙을 S1(강제)로 승격

## [0.36.1] - 2026-07-02

### Documentation
- 어투 규칙: 어색한 조어 교정 규칙(B-4) 추가

## [0.36.0] - 2026-07-01

### Added
- PR description에 흐름 변화(AS-IS → TO-BE) 섹션 추가, `change-context-writer`에도 동일 섹션 반영

## [0.35.0] - 2026-06-30

### Added
- `impact-writer` role agent + `brief` 스킬 추가 — 성과 분석·KPI 회고·제안서·RFC 등 의사결정용 산문 작성

## [0.34.0] - 2026-06-29

### Added
- `/review` 스킬에 PR 인라인 코멘트 게시 단계 추가 (`code-review-writer` 경로)

### Documentation
- 한글 산문 가운뎃점(·) 나열 절제 규칙(C-12) 전파

## [0.33.3] - 2026-06-24

### Fixed
- `code-review-writer`에 음차 표기 교정 규칙 추가, voice 가이드 내 모순 제거

## [0.33.2] - 2026-06-24

### Added
- `gh pr create` 호출에 `GESTALT_PR` 표식 추가 — PreToolUse 훅 우회용

## [0.33.1] - 2026-06-24

### Documentation
- PR 작성 요청 시 `gestalt:pr` 스킬로 라우팅하도록 CLAUDE.md에 추가

## [0.33.0] - 2026-06-24

### Added
- `humanize-monolith` · `change-context-writer` · 리뷰 파이프라인에 작성자 본인 voice 보존 연결
- `code-review-writer` 어투를 실제 PR 코멘트 voice 기반으로 재작성

### Changed
- CI Node 24로 업그레이드, GitHub Actions 버전 갱신

## [0.32.5] - 2026-06-24

### Added
- PR 생성 시 작성자 본인 자동 어사인

### Documentation
- 굳어진 음차 표기 화이트리스트를 Do-NOT 규칙에 명시

## [0.32.4] - 2026-06-23

### Documentation
- 비표준 영어 구 음차 표기 교정 룰(B-3) 추가

## [0.32.3] - 2026-06-23

### Added
- `AtomicTask`에 `model` 힌트 필드 추가, Passthrough 태스크에 model 힌트 자동 할당 및 프롬프트 반영

## [0.32.2] - 2026-06-21

### Fixed
- `client: "claude-code"`에서도 passthrough를 강제하도록 수정 — API 키가 있어도 호스트가 LLM 주체가 되도록 통일

## [0.32.1] - 2026-06-21

### Fixed
- `ges_create_agent` normal mode 등록 누락 수정, `ges_execute`에 client per-call 지정 지원 추가

### Documentation
- Codex 호스트 패스스루 동작 설명 보강

## [0.32.0] - 2026-06-20

### Added
- `solve` 스킬 추가 — 인터뷰 완료 후 실행 루프를 자율로 드라이빙

## [0.31.2] - 2026-06-20

### Added
- 한국어 응답 생성 시 AI 어투 제거 가이드, 영어 약어·한자어 대신 일상 단어를 우선하는 어휘 선택 규칙 추가

## [0.31.1] - 2026-06-18

### Added
- `ux-writer` role agent 추가 — UX 문구 작성·교정 전담

### Changed
- `technical-writer` / `ux-writer` 에이전트에서 특정 브랜드 레퍼런스 제거, 범용 가이드라인으로 대체

## [0.31.0] - 2026-06-18

### Added
- `/pr` 스킬 추가 — repo 규칙 탐색 + 미니 인터뷰 + `gh pr create` 흐름
- 인터뷰 세션에 PR/review 키워드 intent routing 추가 — 해당 키워드 감지 시 `/pr`·`/review`로 안내

## [0.30.1] - 2026-06-18

### Added
- `/review` 스킬에 0단계 mini-interview 추가 — 리뷰 컨텍스트 확보

## [0.30.0] - 2026-06-18

### Added
- `change-context-writer` role agent 추가 — 기획 컨텍스트 분석 전담
- `/review` 스킬에 1.5단계 기획 컨텍스트 분석 단계 추가

## [0.29.1] - 2026-06-17

### Added
- 페르소나 파이프라인 및 `personasDir` 설정 지원, `medicine-seller`·`trickster` 캐릭터 에이전트 추가

### Changed
- humanize 단계를 `humanize-monolith` 에이전트에 위임하도록 리팩터링 (`ges_agent` 경유)

## [0.29.0] - 2026-06-17

### Added
- `frontend-reviewer` review agent 추가
- `code-review-writer` role agent 추가 — repo rule discovery, `humanize-monolith` S1 규칙 통합

### Fixed
- 파서의 pipeline zod enum에 `review` 값 누락 수정

## [0.28.1] - 2026-06-14

### Changed
- `gestalt-release` 체크리스트에 `format:check` 단계 추가, 테스트 파일에 prettier 포맷 적용

## [0.28.0] - 2026-06-14

### Added
- Memory 격상 3단계, `HostAdapter` 추상화, `usage-report` CLI 추가

## [0.27.0] - 2026-06-14

### Added
- 벤치마크 코어 테스트 스위트, resolution benchmark 추가
- `evolve_viz`(evolution_viz) 액션 추가 — Chart.js 기반 진화 궤적 시각화
- LLM `RetryingAdapter` / `FallbackAdapter` 추가 — tier cascade 폴백

### Changed
- Knowledge Base 임베딩을 `@xenova/transformers` 네이티브 배열 입력으로 배치 처리해 성능 개선

### Documentation
- README를 Interview 차별점과 자기 자신을 개발하는 dogfooding 스토리 중심으로 재구성

## [0.26.0] - 2026-06-14

### Added
- Memory → Interview 피드백 루프: 이전 스펙·실행 이력이 있으면 interview 시작 시 `gestaltContext.systemPrompt`에 자동 주입
- `CodeGraphEngine.listAllFiles()` — 명시적 전체 파일 목록 API 추가

### Fixed
- better-sqlite3 Node 버전 불일치 시 MCP 서버가 초기화 전에 죽는 문제 수정 (`CodeGraphStore` static import → lazy load)
- `searchByKeywords([''])` 빈 문자열 우회로 차단 — 빈/공백 키워드는 항상 `[]` 반환

### Changed
- `execute-passthrough.ts` 1296줄 God File → `src/mcp/tools/execute/` 하위 8개 파일 분리 (dispatch map 패턴)
- review `context-collector` 의존성 분석을 정규식에서 code-graph `blastRadius()`로 교체, DB 없으면 graceful fallback
- ESLint flat config 도입 + CI에 `typecheck → lint → format:check` 3단 게이트 추가
- 다국어 code-graph 플러그인 지원 수준 문서 정직화 (TS/JS: 1급, 나머지 7개: 정규식 best-effort)
- Codex CLI 진입점(`AGENTS.md`) 및 스킬 미러 추가

## [0.25.3] - 2026-06-14

### Fixed
- MCP startup no longer fails when the native `better-sqlite3` binding is missing or incompatible; the event store falls back to a JSONL backend.
- Event store initialization now falls back to project or temp storage when the default user data directory is unavailable.
- Skill and agent file watcher errors are downgraded to warnings so `EMFILE` does not close the MCP server during initialization.
- Dotenv startup output is silenced to keep MCP stdio clean.

## [0.20.2] - 2026-06-07

### Fixed
- `ges_execute` MCP tool registration now uses the shared execute input schema, so implemented actions such as `resume`, `audit`, and `spawn` are exposed consistently.
- Invalid configuration fields now fall back individually instead of discarding otherwise valid configuration values.

### Documentation
- Updated the MCP reference tool overview and `ges_execute` action list to match the current server surface.

## [0.14.0] - 2026-04-12

### Added
- Knowledge Base 모듈 (`src/knowledge-base/`): 코드 그래프 분석 결과 및 도메인 콘텐츠를 MD 파일로 내보내기
- `ges_generate_kb` MCP 도구: 프로젝트 지식베이스 생성 및 임베딩 사전 계산 (`.gestalt-kb/`)
- `ges_search` MCP 도구: 로컬 파일 기반 시맨틱 검색 (네트워크 호출 없음, 코사인 유사도)
- `ges_sync` MCP 도구: 지식베이스 디렉토리를 다른 레포로 동기화
- 5가지 KnowledgeEntry 타입 지원: `code-graph`, `business-logic`, `api-spec`, `adr`, `policy`
- `@xenova/transformers` (Xenova/all-MiniLM-L6-v2) 기반 임베딩 벡터 분리 저장 (`embeddings.json`)

### Changed
- `execute_task` 응답에서 `retrospectiveContext.systemPrompt` 제거 (taskContext와 동일한 내용 — 중복 제거)
- `execute_task` 응답의 `pendingTasks`를 경량화 (`taskId`, `title`, `dependsOn`만 포함)

## [0.13.0] - 2026-04-12

### Added
- **멀티 프로바이더 LLM 지원**: `gestalt.json`에 `frugal`/`standard`/`frontier` tier별 provider 설정 추가
  - `provider: 'anthropic' | 'openai'`, `apiKey`, `baseURL`(Ollama 등), `model` 설정 가능
  - `src/llm/factory.ts`: `createAdapter()`, `createTierMapping()`, `hasLLMApiKey()` 팩토리 함수 신규 추가
  - 기존 `llm.apiKey` + `llm.model` 단일 구조와 완전 하위 호환
  - Ollama 로컬 모델(Gemma 4 등) 연결 지원
- **Prettier 설정**: `.prettierrc.json` 추가, `pnpm format` / `pnpm format:check` 스크립트 추가
- **CI 커버리지 수정**: `@vitest/coverage-v8` devDependency 추가로 `pnpm test --coverage` CI 실패 해결

### Changed
- `src/llm/openai-adapter.ts`: `baseURL` 옵션 파라미터 추가 (Ollama 호환)
- `src/mcp/server.ts`, CLI 커맨드: `new AnthropicAdapter(...)` 하드코딩 → `createAdapter(config.llm)` 팩토리 교체
- `gestalt.json`: `ambiguityThreshold` → `resolutionThreshold` 키 수정
- `skills/interview/SKILL.md`: 인터뷰 중 Claude가 스스로 질문에 답변하는 문제 방지 규칙 추가
- 전체 소스 파일 Prettier 포맷 일괄 적용

### Documentation
- `docs/configuration.md`: 멀티 프로바이더 설정 방법 및 Ollama 연결 가이드 추가
- `docs/code-graph.md`, `docs/configuration.md`: 신규 문서 추가
- `README.md` / `README.ko.md`: `ges_code_graph`, `ges_graph_visualize`, `ges_benchmark` 툴 추가, 멀티 프로바이더 설정 섹션 추가
- `schemas/gestalt.schema.json`: tier 구조 및 `llmTierConfig` 정의 추가

## [0.12.3] - 2026-04-09

### Changed
- `ges_execute` MCP 액션 description 축약으로 토큰 사용량 절감

---

## [0.12.2] - 2026-04-08

### Documentation
- `gestalt-release` 스킬에 플러그인 매니페스트 커밋 단계 추가

---

## [0.12.1] - 2026-04-08

### Fixed
- 릴리즈 스킬 단계 순서 정리

---

## [0.12.0] - 2026-04-08

### Changed
- **모호성(ambiguity) → 해상도(resolution) 전면 리네이밍**
  - `AmbiguityScorer` → `ResolutionScorer`, 점수 방향 반전 (낮을수록 명확 → 높을수록 명확)
  - `ambiguityThreshold: 0.2` → `resolutionThreshold: 0.8`
  - 환경변수 `GESTALT_AMBIGUITY_THRESHOLD` → `GESTALT_RESOLUTION_THRESHOLD`
  - 레거시 이벤트 replay 시 기존 ambiguity 점수 자동 반전 처리

### Fixed
- 레거시 Spec 메타데이터 하위 호환 처리
- execute 엔진 내 레거시 fallback의 ambiguityScore → resolutionScore 처리

---

## [0.11.0] - 2026-04-05

### Added
- **시맨틱 검색 / 하이브리드 검색**: Code Knowledge Graph에 임베딩 기반 검색 추가
  - `@xenova/transformers` 로컬 임베딩 (외부 API 불필요)
  - `node_embeddings` 테이블 추가 (`buildEmbeddings`, `searchBySemantic`, `searchByHybrid`)
  - RRF(Reciprocal Rank Fusion) 알고리즘으로 키워드 + 시맨틱 결합
  - `EmbeddingProvider`, `SummaryProvider` 인터페이스 (Anthropic/OpenAI/Gemini/Local 지원)
  - Execute Engine에 `hydrateSuggestedFiles()`로 시맨틱 검색 결과 자동 주입

---

## [0.10.0] - 2026-04-05

### Added
- **Graph Visualization**: `ges_graph_visualize` MCP 툴 추가 — D3.js 인터랙티브 코드 그래프 시각화
- **Setup Skill**: `/setup` 슬래시 커맨드로 `gestalt init` 원클릭 실행
- **개발 자동화**: `gestalt-develop`, `gestalt-release` 스킬 추가
- **전문 에이전트**: `gestalt-analyst`, `gestalt-developer`, `gestalt-qa` 에이전트 추가

---

## [0.9.2] - 2026-04-05

### Added
- **Code Knowledge Graph**: 정적 분석 기반 의존성 그래프 (`ges_code_graph` MCP 툴)
  - `build` / `blast_radius` / `diff_radius` / `query` / `stats` / `db_exists` 액션
  - Execute Engine에 blast-radius 기반 suggestedFiles 자동 주입
  - `build-graph`, `blast-radius`, `diff-radius` 슬래시 커맨드 스킬 추가
- **OS 알림**: 파이프라인 이벤트 시 데스크탑 알림 (`notifications` 설정)
- **병렬 에이전트 실행**: `/execute` 스킬에서 `parallelGroups` 기반 동시 실행
- **`gestalt init`**: `gestalt.json` 생성 + 코드 그래프 빌드 + post-commit 훅 설치 원스텝 온보딩
- **`.claude/rules` 라이프사이클**: `gestalt-active.md` 자동 생성·삭제

### Changed
- `interview.maxRounds` 기본값 10 → 20

---

## [0.9.0] - 2026-03-29

### Added
- **공통 진행 패널**: `/interview`, `/spec`, `/execute` 스킬 실행 중 Claude Code Task 패널에 실시간 진행 상태 표시
  - Planning 시작 시 `TaskCreate`로 패널 생성, 각 단계(`plan_step`, `execute_task`, `evaluate`)마다 `TaskUpdate`로 갱신
  - Interview: 라운드 번호 / 현재 게슈탈트 원리 / 모호성 점수 추이 표시
  - Spec: 생성 중 → 완료(specId 포함) 상태 표시
  - Execute: `{완료}/{총합} 완료 | 현재: {태스크명} | 실패: {n}개 | 그룹 {x}/{y}` 형식 표시
  - best-effort — 패널 업데이트 실패가 파이프라인 실행을 중단하지 않음
  - 스킬 레벨(SKILL.md)에서 동작, MCP 서버 코드 변경 없음

### Changed
- `skills/interview/SKILL.md`: 버전 1.0.0 → 1.1.0, 공통 진행 패널 섹션 추가
- `skills/spec/SKILL.md`: 버전 1.0.0 → 1.1.0, 공통 진행 패널 섹션 추가
- `skills/execute/SKILL.md`: 버전 1.1.0 → 1.2.0, 공통 진행 패널 섹션 추가

### Documentation
- `docs/03-execute.md`: 공통 진행 패널 섹션 추가
- `docs/mcp-reference.md`: execute 섹션에 Progress Panel 설명 추가
- `README.md` / `README.ko.md`: Execute 섹션에 실행 진행 패널 언급 추가
- `CLAUDE.md`: Skill System 항목에 TaskCreate/TaskUpdate 진행 패널 설명 추가

## [0.8.0] - 2026-03-28

### Added
- **Execution Continuity (Resume)**: 중단된 실행 세션을 이어서 실행하는 `resume` MCP action 추가
  - `ges_execute({ action: "resume", sessionId })` — 완료된 태스크 목록 + 다음 태스크 컨텍스트 반환
  - `ResumeContext`: `completedTaskIds`, `nextTaskId`, `totalTasks`, `progressPercent` 포함
  - `ges_status` 응답에 `resumeContext` 자동 포함 (executing 상태 세션)
- **Context Compression**: 인터뷰 컨텍스트가 길어질 때 자동 압축하는 `compress` MCP action 추가
  - 5라운드 초과 시 `compress` 권장 (`needsCompression`, `compressionContext` 응답 포함)
  - `compress` action: 2-Call 패턴 — compressionContext 반환 → caller가 요약 생성 → 제출
  - 압축 요약은 세션에 저장(`compressedContext`)되어 이후 라운드에 자동 주입
  - `ProjectMemoryStore.addCompressedContext()` — `.gestalt/memory.json`에 압축 이력 영속화
- **Spec Template Library**: `ges_generate_spec`에 `template` 파라미터 추가
  - 3개 내장 템플릿: `rest-api`, `react-dashboard`, `cli-tool`
  - 템플릿 제약 조건과 완료 기준이 Spec 생성 프롬프트에 자동 주입
  - `SpecTemplateRegistry`: `list()`, `get()`, `has()`, `buildTemplateContext()`
- **Brownfield Audit**: 기존 코드베이스와 Spec 간 갭을 분석하는 `audit` MCP action 추가
  - 2-Call 패턴: `audit` (context 요청) → codebaseSnapshot + auditResult 제출
  - `AuditResult`: `implementedACs`, `partialACs`, `missingACs`, `gapAnalysis`, `auditedAt`
- **Parallel Task Groups**: 동시 실행 가능한 태스크 그룹 자동 계산
  - `computeParallelGroups()` — DAG 레이어 기반 병렬 그룹 배열 생성
  - `ExecutionPlan.parallelGroups: string[][]` 필드 추가 — `plan_complete` 응답에 포함
- **Sub-agent Spawning**: `spawn` MCP action으로 동적 하위 태스크 생성
  - `ges_execute({ action: "spawn", sessionId, parentTaskId, subTasks })` — SubTask[] 등록
  - `SubTask`: 부모 태스크 컨텍스트를 상속, 독립 실행 가능

### Changed
- `ges_execute` action enum에 `resume`, `audit`, `spawn` 추가
- `ges_interview` action enum에 `compress` 추가
- `ExecuteSession`에 `completedTaskIds`, `nextTaskId`, `subTasks` 필드 추가
- `InterviewSession`에 `compressedContext` 필드 추가

## [0.6.0] - 2026-03-27

### Added
- **Terminal Recording**: `gestalt interview --record` 플래그로 인터뷰 세션 전체를 GIF로 녹화
  - `TerminalRecorder`: `process.stdout.write` 인터셉션으로 NDJSON `.frames` 파일에 실시간 저장
  - `GifGenerator`: jimp(텍스트 렌더링) + gifencoder(GIF 인코딩) — 외부 바이너리 없음
  - `FilenameGenerator`: LLM이 인터뷰 주제 기반 kebab-case slug + YYYYMMDD 날짜로 파일명 자동 생성
  - `SegmentMerger`: 복수 세그먼트 병합 + 5초 이상 갭 3초 압축
  - `ResumeDetector`: `.frames` 파일 존재 시 `--record` 없이도 자동으로 이어서 녹화
  - GIF 생성 완료 후 임시 `.frames` 파일 자동 삭제

## [0.5.1] - 2026-03-20

### Added
- **Node.js 버전 체크**: 실행 시 Node.js >= 20.0.0 검증, 미달 시 업그레이드 안내 메시지 출력
- **README Prerequisites 섹션**: Node.js 최소 버전 요구사항 및 nvm 설치 가이드 추가

### Fixed
- `bin/gestalt.ts` TypeScript 컴파일 에러 수정 (`TS18048: 'major' is possibly undefined`)

## [0.5.0] - 2026-03-20

### Added
- **Code Review Pipeline**: Evolve 이후 최종 완료 직전에 PR 수준의 종합 코드리뷰 게이트 추가
  - `review_start`, `review_submit`, `review_consensus`, `review_fix` 4개 action (ges_execute 통합)
  - 카테고리별 리뷰 에이전트가 독립 리뷰 → 토론/병합 → 최종 합의
  - critical/high 이슈 0건이면 통과, warning 허용
  - 자동 수정 루프 최대 3회, 초과 시 마크다운 리포트로 사람에게 위임
  - 수정 후 Structural 재검증(lint/build/test)만 수행, Contextual 스킵
- **3개 코드리뷰 전용 에이전트**: security-reviewer, performance-reviewer, quality-reviewer
- **ReviewReportGenerator**: 리뷰 결과 JSON → 마크다운 리포트 변환 (severity별 그룹핑, 통계 테이블)
- **ReviewContextCollector**: 변경 파일 + import 의존성 분석으로 리뷰 범위 수집
- **ReviewAgentMatcher**: 기존 Role Agent + 코드리뷰 전용 에이전트 통합 매칭
- `REVIEW_*` 이벤트 7종 추가 (이벤트 소싱)
- **벤치마크 시스템**: `ges_benchmark` MCP 도구, 3개 시나리오 (auth-system, dashboard, api-gateway)
- **TUI 대시보드**: `gestalt monitor` CLI (ink 기반)
- **ges_status 확장**: execute 세션 조회 + sessionType 필터
- **GitHub Actions CI/CD** 워크플로우

### Changed
- `AgentPipeline` 타입에 `'review'` 추가
- `ges_execute` action enum에 `review_start`, `review_submit`, `review_consensus`, `review_fix` 추가
- `executeInputSchema`에 리뷰 관련 입력 필드 추가 (reviewResult, reviewConsensus, reviewSessionId 등)
- execute-passthrough.ts에 default case 추가 (TS exhaustiveness)

## [0.2.0] - 2026-03-14

### Added
- **Role Agent System**: 8개 내장 Role Agent (architect, backend-developer, designer, devops-engineer, frontend-developer, product-planner, qa-engineer, researcher)
- **`ges_create_agent` MCP 도구**: 인터뷰 기반 커스텀 Role Agent 자동 생성 (2-Call: start, submit)
- **Lateral Thinking Personas**: Multistability, Simplicity, Reification, Invariance — stagnation 패턴별 자동 분기
- **Human Escalation**: 4개 persona 소진 시 actionable suggestions 제공
- **Configuration System**: nested config (llm, interview, execute), gestalt.json + dotenv 지원, JSON Schema
- **`gestalt setup` CLI**: gestalt.json 초기 생성 명령어
- **업데이트 알림**: npm 최신 버전 자동 확인
- **Claude Plugin marketplace 매니페스트**: 플러그인 설치 지원
- **TUI Dashboard**: `gestalt monitor` 명령어 (ink 기반)
- **AgentCreationError** 에러 클래스 및 AGENT_CREATED 이벤트 타입

### Changed
- Evolution Loop 종료 시 즉시 종료 대신 lateral thinking으로 자동 분기
- Configuration: flat → nested 구조 (`config.llm.apiKey`, `config.interview.ambiguityThreshold` 등)
- `constants.ts`에서 `process.env` 의존 제거 → 순수 상수

### Fixed
- Claude Code 플러그인 설치 오류 (agents 필드 제거)
- postbuild에 package.json dist 복사 누락
- simulate-lateral TS 에러
- marketplace metadata.version sync
- bin 파일 실행 권한 누락

## [0.1.0] - 2026-03-11

### Added
- **Interview Engine**: 게슈탈트 5원리 기반 요구사항 인터뷰 (start, respond, score, complete)
- **Passthrough Mode**: API 키 없이 MCP 서버 운영, caller에게 LLM 호출 위임
- **Spec Generator**: 인터뷰 완료 후 구조화된 Spec 생성 (2-Call Passthrough 패턴)
- **Execute Engine**: 4단계 Planning (Figure-Ground → Closure → Proximity → Continuity)
- **Execution Phase**: 위상 정렬 기반 태스크 실행 + Similarity 원리 참조 컨텍스트
- **Evaluate 2-Stage Pipeline**: Structural (lint/build/test) → Contextual (LLM AC 검증)
- **Drift Detection**: 3차원 Jaccard (Goal 50%, Constraint 30%, Ontology 20%)
- **Evolution Loop**: Structural Fix + Contextual Evolution + Spec Patch 적용
- **Event Sourcing**: SQLite WAL 모드, Event Replay 기반 세션 재구성
- **Agent System**: 5개 Gestalt 에이전트, FiguralRouter, multi-provider LLM (Anthropic + OpenAI)
- **Skill System**: SKILL.md 파서, chokidar hot-reload
- **MCP Server**: stdio transport, 5개 도구 (ges_interview, ges_generate_spec, ges_execute, ges_create_agent, ges_status)
- **CLI**: interview, spec, status 명령어

### Changed
- Seed → Spec 전면 리네이밍 (타입, 클래스, 필드, MCP 도구, 이벤트, CLI, 문서)

[0.5.1]: https://github.com/tienne/gestalt/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/tienne/gestalt/compare/v0.2.0...v0.5.0
[0.2.0]: https://github.com/tienne/gestalt/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tienne/gestalt/releases/tag/v0.1.0
