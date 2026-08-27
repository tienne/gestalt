# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`gestalt humanize-scan`** — 원문을 훑어 그 말투에서 실제로 걸린 S1 룰만 처방과 함께 추려요. 룰북 전체를 매번 펼치는 대신 이번에 볼 목록만 좁혀 줍니다. 종료 코드로도 답해요 (0 걸림 / 10 없음 / 3 파일 없음).

```bash
gestalt humanize-scan --file draft.md --register chat
```

### Changed

- **`gestalt humanize-check`의 채택 금지가 양방향이 됐어요.** 전에는 과윤문(변경률 50%, 보호 토큰 유실)만 막아서 원문을 그대로 돌려준 윤문본이 경고 하나로 통과했습니다. 이제 탐지 가능한 S1을 한 건도 못 줄였고 변경도 문턱 아래면 채택 금지예요. 새 AI-tell을 심은 경우도 막습니다.
- 리포트 마지막 줄에 `[다음]`으로 할 일을 찍어요 — `accept` / `accept-with-warning` / `retry` / `fallback`. `--attempt`로 몇 번째 시도인지 알려주면 재시도를 소진했을 때 원문으로 돌아가라고 지시합니다.

## [0.69.0] - 2026-08-26

에이전트끼리 레포 안에서 PR을 만들고 리뷰하고 머지하는 자리가 생겼어요. 원격에 안 나가요.

### Added

- **로컬 PR** — 원격 GitHub PR은 사람에게 넘기는 용도예요. 에이전트끼리 주고받는 데는 `gh`도 인증도 원격 왕복도 다 군더더기라 레포 안에서 끝내요.

  `gestalt pr` 17개 명령과 `ges_pr` 13개 액션이 생겼어요. 이벤트 소싱이라 상태를 따로 저장하지 않아요. 저장소는 `--git-common-dir` 기준으로 잡아서 워크트리 여럿이 `.gestalt/reviews.db` 하나를 공유해요. PR의 커밋은 `refs/gestalt/pr/<id>/head`가 붙잡아요 — 워커가 브랜치를 지워도 diff가 살아요.

  리젝이 새 PR을 만들지 않고 같은 PR에 라운드를 늘려요. 3차에서 다시 열린 코멘트가 어느 라운드에서 났고 어디서 닫혔는지가 한 자리에 남아요. 승인 게이트는 없어요 — 대신 머지 시점의 미해결 수가 이벤트에 남아서 나중에 그 판단을 되짚을 수 있어요.

- **`gestalt pr checkout`** — `pr diff`는 텍스트만 줘요. 그런데 테스트가 뭔가를 실제로 잡는지 보려면 코드를 일부러 깨고 돌려봐야 하거든요. 리뷰어들이 매번 손으로 임시 워크트리를 뜨고 있길래 명령으로 만들었어요.

  떼어낸 자리에 커밋 안 된 변경이나 거기서 쌓은 커밋이 있으면 안 지워요. 리뷰어가 검증 중이면 그건 일부러 깨놓은 코드예요. `--force`로 지울 때도 어느 ref도 안 품은 커밋은 `refs/gestalt/pr-checkout/<id>/<sha 8자>`가 붙잡아요.

- **`gestalt pr prune`** — `refs/gestalt/` 아래는 놓지 않으면 늘기만 해요. 기준은 하나예요. 놓아도 커밋이 안 사라지는가.

  머지된 PR의 base와 head를 놓는데, 놓기 전에 head가 정말 base 이력에 있는지 확인해요. 머지 뒤 base가 되돌아갔으면 근거가 깨지니까 안 놓고 이유를 돌려줘요. 닫힌 PR은 아무것도 안 놓아요. 체크아웃 자국은 어느 이력에도 없는 커밋이라 `--checkouts`로 뜻을 밝혀야 놓아요.

  CLI에만 뒀어요. 되돌릴 수 없게 놓는 자리라 도구 표면에 안 올렸어요.

- **`gestalt pr edit`** — PR 본문에 틀린 문장이 있어도 고칠 길이 없었어요. 리뷰 라운드를 돌다 워커 셋이 같은 벽에 부딪혀서 코멘트로 정정하고 스레드를 열어둬야 했어요.

  `pr update`에 `--body`를 그냥 더하면 안 됐어요. `PrEvent.UPDATED`는 `foldStatus`에서 `changes_requested`를 `open`으로 되돌리는 이벤트라, 그대로 쓰면 **본문 오타 수정이 리뷰 판정을 리셋해요.** 그래서 `pr.edited`를 새로 냈어요 — `fold`만 읽고 `foldStatus`는 안 읽어요. 라운드도 안 늘어요.

- **`gestalt pr repos`와 `gestalt pr unregister`** — 웹 UI가 보여주는 레포 목록을 확인하고 되돌리는 자리예요. 목록에 한 번 들어가면 뺄 방법이 없었어요.

- **로컬 PR 웹 UI** (`gestalt pr serve`) — 127.0.0.1에만 붙는 읽기 전용 뷰예요. 서버 하나가 등록된 레포를 전부 보여줘요. URL에는 경로가 아니라 레포 키가 실려요 — 요청이 레포 경로를 지정할 수 있으면 인증 없는 이 서버가 이 머신의 아무 git 레포나 읽어주는 도구가 되거든요.

- **리뷰 파이프라인 ↔ 로컬 PR** — `review_start`가 `prId`를 받고 `review_publish`가 합의 결과를 인라인 코멘트와 판정으로 되돌려 써요. 코멘트 작성자가 그 코멘트를 낸 에이전트로 남아요(`agent:security-reviewer` 꼴).

  두 번 불러도 코멘트가 안 늘어요. 코멘트에 합의 지문을 남겨서 프로세스가 죽은 뒤 다시 불러도 쓴 것을 다시 안 써요. PR은 이벤트 소싱이라 한 번 붙은 코멘트를 지울 수 없거든요.

- **`pnpm gate`와 pre-commit 훅** — 커밋 전 검사를 한 줄로 묶었어요.

  게이트를 만들어 놓고도 출력을 `grep`에 물리면 grep의 종료 코드가 남아서 검사가 실패해도 커밋이 나가요. 실제로 두 번 났어요. 규율에 맡길 자리가 아니라 커밋이 막혀야 하는 자리였어요. 훅에는 빠른 셋(11초)만 넣었어요 — 분 단위를 매 커밋에 물리면 `--no-verify`를 습관처럼 붙이게 되니까요.

### Fixed

- **스펙 프롬프트에 `[object Object]`가 실려 가던 자리** — 아키텍처 결정을 객체 그대로 문자열에 박고 있었어요. 바로 옆 `memory-context-injector`는 같은 타입을 제대로 펼치고 있어서 한쪽만 어긋난 상태였어요.

### 만든 방식

Phase 1을 만든 뒤 **나머지를 이 시스템 자신으로 만들었어요.** 워크트리 다섯 개를 나눠 각각 로컬 PR을 올리고 서로 다른 에이전트가 리뷰했어요. 그다음 브랜치 전체를 리뷰 파이프라인으로 한 바퀴 더 돌렸고요(서브에이전트 여덟, critical 2 / high 18 / warning 6).

리뷰가 잡은 것 중 통과 결과만 봐서는 안 보이는 것들이에요.

| 자리 | 내용 |
| --- | --- |
| 깨진 게이트 | `verify:rules`가 깨진 채 올라온 PR — 부모 커밋에서 돌려 이 PR이 들여온 실패임을 보였어요 |
| 빈 테스트 | 인자 전달을 통째로 지워도 통과하던 테스트 |
| 옮겨간 구멍 | 1라운드에 고친 판별 로직이 2라운드에 새 구멍을 만든 것 |
| 서버 크래시 | `GET /%` 한 번에 프로세스가 죽던 것 |
| 안 불리는 이음매 | `review_publish`를 만들어 놓고 유일한 소비자가 안 부르던 것 |

## [0.68.0] - 2026-08-20

코드가 실제로 안 하는 걸 산문이 약속하던 자리를 룰로 막았어요. 사람이 읽을 문장을 보는 리뷰어도 생겼고요.

### Added

- **writing-reviewer** — 변경된 문서와 사용자에게 보이는 문자열, 코드 주석의 어투를 AI-tell 룰북 기준으로 판정해요. 그 자리에서 사람이 실제로 고를 단어를 썼는지, 읽는 사람이 뜻을 바로 잡을 수 있는지를 룰 ID 단위로 봐요.

- **CM-8** — 주석이 코드가 보장하지 않는 걸 단언하면 안 돼요. 단언한 보장에는 관련 테스트가 있어야 하고요. 리뷰를 다섯 바퀴 돌리는 동안 같은 유형이 네 번 나왔거든요. 룰만 더하지 않고 `verify:rules`의 검사 범위를 `docs/`, README, `src/`, `scripts/`, `tests/`와 테스트 제목까지 넓혔어요.

- **frugal tier 연결** — 이름만 있고 실제 호출 경로가 없던 걸 이었어요. 해상도 채점과 KB 요약이 이 티어를 타요. KB 요약은 opt-in이에요. 요약문은 KB에 넣기 전에 형태를 무해하게 만들고요.

### Fixed

- **passthrough 경로에 `tierModels`가 안 실리던 것** — `handleStatus`에만 넣었는데 claude-code는 `handleStatusPassthrough`를 타요. 살아 있는 경로에는 안 들어갔던 거예요.

## [0.67.0] - 2026-08-16

### Changed

- **남은 여섯 스킬을 서브에이전트 위임으로 옮겼어요** — 에이전트 본문과 룰북을 메인 대화에 실으면 그게 작업이 끝난 뒤에도 매 턴 다시 실려 가요. 위임 규칙에 파일을 쓰는 자리도 함께 적었어요.

## [0.66.0] - 2026-08-16

잘린 결과를 완전한 답처럼 돌려주던 자리들을 막았어요.

### Added

- **잘린 결과를 잡는 룰북** — 첫 페이지만 보고 대상을 확정하거나, 앞에서 잘라 이유를 버리는 패턴을 룰로 세웠어요.

### Fixed

- `status`가 잘린 개수를 전체 개수로 출력하던 것
- 실행 실패 출력을 앞에서 잘라 실패 이유를 버리던 것
- 코드 그래프에서 빠진 파일이 결과에 안 실리던 것
- slack-send와 jira-create가 첫 페이지만 보고 대상을 확정하던 것

## [0.65.1] - 2026-08-15

### Fixed

- 리뷰 스레드 수집이 조용히 잘리던 것 — 왕복이 상한을 넘은 스레드에서 중간 코멘트를 마지막으로 착각하면 판정이 양쪽으로 뒤집혀요.

## [0.65.0] - 2026-08-15

### Changed

- better-sqlite3를 13.x로 올리고 CI에 arm64를 넣었어요. Node 24는 24.18.0에 묶어 CI를 되살렸고요.

## [0.64.0] - 2026-08-15

### Added

- **B-5** — 영어 개념어를 그대로 옮긴 직역을 막아요.

## [0.63.1] - 2026-08-15

### Added

- Grok 로컬 MCP와 호스트 shim, 공유 AGENTS.md 항목.

## [0.63.0] - 2026-08-15

### Added

- **D-8** — 과잉 자책을 막아요. 보고여야 할 자리가 자기 반성문이 되면 읽는 쪽이 무슨 일이 났는지 알 수 없어요.

### Changed

- 리뷰 서브에이전트를 Explore 타입으로 띄워요.

## [0.62.0] - 2026-08-15

리뷰 스킬이 에이전트를 부르는 방식을 바꿨어요. 리뷰가 짚은 것들도 반영했고요.

### Changed

- **리뷰 스킬의 에이전트 호출을 서브에이전트로 위임** — systemPrompt와 룰북을 전부 메인 대화에 실으면 100KB가 넘어요. 그게 리뷰가 끝난 뒤에도 매 턴 다시 실려 가고요.

### Fixed

- 리뷰 코멘트에 출처 태그와 내부 에이전트 이름이 드러나던 것 — 리뷰는 계정 주인이 남기는 거예요.
- `untrusted-input` 가드가 원본 규칙의 절반만 담고 있던 것, 위장 지시 보고가 사용자에게 안 닿던 것.
- humanize 검사가 펜스와 인용줄 안 산문을 안 보던 것.

## [0.61.0] - 2026-08-15

### Added

- **Grok 호스트 지원** — 어댑터와 passthrough, 플러그인 매니페스트. `client` 설정과 스키마에 `grok`이 들어갔어요.

## [0.60.0] - 2026-08-12

### Changed

- **리뷰에서 코드 그래프 의존을 제거** — 리뷰는 git 저장소이기만 하면 돌아야 해요. 그래프를 빌드해야 리뷰가 되면 전제가 하나 더 붙는 셈이거든요.

### Fixed

- gestalt MCP 서버의 시작 타임아웃을 늘렸어요.

## [0.59.0] - 2026-08-12

### Added

- **comment-reviewer** — 코드를 그대로 옮긴 주석, 변경 이력 메모, 주석 처리된 죽은 코드, 코드와 어긋난 주석을 CM 룰 ID 단위로 잡아요. 주석 룰은 `comment-rules.md` 룰북으로 분리했어요.

### Fixed

- **리뷰 에이전트 본문이 프롬프트에 안 실리던 것** — `ges_agent get`을 건너뛰면 frontmatter 한 줄만 남아요. 그러면 룰북을 참조하는 에이전트가 룰을 못 본 채로 리뷰해요.

## [0.58.0] - 2026-08-12

### Added

- 추상명사에 붙는 물리 동사 오용 패턴 두 종을 author-voice에 추가했어요.

## [0.57.0] - 2026-08-11

### Added

- **report 레지스터** — 문서와 대화 말고 보고서 어투를 따로 뒀어요.

## [0.56.0] - 2026-08-10

### Added

- **C-13** — 수치 단위 혼용을 잡아요.

### Fixed

- Role Agent 자동 라우팅 표를 플러그인 공유 참조로 통합했어요. 다른 레포에 설치된 세션도 같은 표를 봐요.
- PR description에 humanize 최종 패스를 넣었어요.

## [0.55.0] - 2026-08-09

### Added

- **I-6** — 측량투와 사무투 명사 패턴을 룰로 승격했어요.
- **output style 빌드** — 룰북에서 `~/.claude/output-styles/`를 생성해요. 룰이 한 곳에만 있어야 문서와 스타일이 안 갈려요.

## [0.54.0] - 2026-08-07

검사 출력이 읽히게 바뀌었어요. 문서에 AI 티가 다시 쌓이지 않게 기준도 세웠고요.

### Added

- **검사 출력에 룰 이름** — `C-11: 11 → 5`만 찍히면 룰북을 열어봐야 무슨 룰인지 알아요. 이제 `C-11 연결어미 뒤 쉼표: 11 → 5`로 나와요.

  이름은 룰북 패턴 칸에서 뽑아 씁니다. 코드에 따로 적어두지 않아서 문서와 따로 놀 일이 없어요. 패턴 칸은 조건과 예시까지 담고 있어 이름만 남기고 걷어냅니다.

  | 걷어내는 것 | 전 | 후 |
  | --- | --- | --- |
  | 대시 뒤 부연 | 복합명사 압축 — 명사구를 조사 없이… | 복합명사 압축 |
  | 긴 괄호 예시 | hype 어휘(파격적, 압도적, 강력한) 3회+ | hype 어휘 |
  | 뒤따르는 긴 인용 | 문두 접속사 "또한, 따라서, 즉, 나아가…" | 문두 접속사 |

  짧은 괄호는 이름의 일부라 남겨요 (`가운뎃점(·) 나열 남발`). 10자 이하 인용도 그 자체가 이름이라 남기고요 (`이중 피동 "~되어진다"`).

- **S1 어투 베이스라인 게이트** — `pnpm verify:rules`가 에이전트 문서의 S1 건수를 파일별로 세고 기준보다 늘면 실패해요. 한 번 청소해도 게이트가 없으면 다시 쌓이거든요.

  0건을 강제하지는 않아요. 남은 건 탐지기가 못 가리는 오탐이에요. "보고"나 "경고"는 `-고`로 끝나지만 명사라 쉼표를 빼면 뜻이 깨져요. 0건을 걸면 오탐을 피하려고 문장을 비트는 일이 생깁니다.

  문서를 더 정리한 뒤 `pnpm humanize:baseline`으로 기준을 다시 낮춰요.

### Changed

- **에이전트 문서 어투 정리** — 룰을 가르치는 문서가 정작 그 룰을 제일 많이 어기고 있었어요. 에이전트가 읽는 문서라 그대로 산출물로 샙니다. S1 649건에서 11건까지 내렸어요.

  | 룰 | 전 | 후 |
  | --- | --- | --- |
  | C-11 연결어미 뒤 쉼표 | 106줄 | 4 |
  | C-12 가운뎃점 나열 | 383개 | 3 |

  ```
  한 문장이 전경이고, 지표 표는  →  전경이고 지표 표는
  의도·동작 변화·정책 변화        →  의도, 동작 변화, 정책 변화
  신규·삭제된 단계               →  새로 생기거나 삭제된 단계
  ```

  룰 예외는 남겼어요. 굳어진 음차 화이트리스트와 룰 ID 나열은 용어 목록이지 산문이 아니에요. 표 안, 코드블록, 백틱과 따옴표, 괄호 안도 건드리지 않았고요.

  두 개짜리 묶음은 쉼표가 어색한 자리가 있어서 12곳을 손으로 고쳤어요. 둘이 한 덩어리로 읽히는 자리예요.

- **어투 레퍼런스에서 개인 정보를 걷어냈어요** — `plugin/`이 npm 배포에 포함돼서 어투 예시가 그대로 공개되고 있었어요. 예시에 인용된 사람 이름과 연락처, 조직 식별자를 일반 표현으로 바꿨습니다. 어투 예시는 이름 없이도 성립해요. 무엇을 어떻게 말하는지가 모델이지 누구에게 말했는지가 모델은 아니니까요.

## [0.53.0] - 2026-08-07

코드 리뷰가 불필요한 주석까지 잡아내요.

### Added

- **주석 위생 검사 (quality-reviewer)** — `/review`가 코드 품질을 볼 때 주석도 함께 검사해요. 코드를 읽거나 `git log`로 확인되는 내용은 주석으로 남길 이유가 없어요. 코드가 바뀔 때 같이 고쳐지지 않아서 결국 사실과 어긋나요.

  코멘트가 붙는 주석은 여섯 가지예요.

  | 유형 | 예 | 심각도 |
  | --- | --- | --- |
  | 코드를 그대로 옮긴 것 | `count += 1` 위의 `// 카운트를 1 증가` | `warning` |
  | 변경 이력 메모 | `// 2026-03-12 수정`, `// 기존 로직 제거` | `warning` |
  | 섹션 배너 | `// ===== helpers =====` | `warning` |
  | 티켓 번호 없는 TODO | `// TODO: 나중에 정리` | `warning` |
  | 코드와 어긋난 주석 | 설명하는 동작이 지금 코드에 없는 것 | `high` |
  | 주석 처리된 죽은 코드 | `// const legacy = ...` | `high` |

  앞의 넷은 읽는 시간만 써요. 뒤의 둘은 읽는 사람을 잘못된 방향으로 끌기 때문에 심각도를 높였어요.

  남기는 주석은 왜 그렇게 짰는지 하나뿐이에요. 외부 API 버그 우회, 성능 제약, 겉보기에 틀려 보이는 코드가 의도된 것이라는 근거, 그리고 공개 API와 공용 유틸의 JSDoc이에요.

  코멘트는 지우자는 말로 끝나지 않고 대체안까지 내요. 이름 풀어쓰기, 블록을 함수로 빼기, 매직 넘버를 이름 붙은 상수로 올리기, 배경이 길면 README나 ADR로 옮기고 링크만 남기기예요.

  PR에 인라인으로 게시할 때는 강제성 접두어가 붙어요. `high`는 `r:`(꼭 반영), `warning`은 `c:`(웬만하면 반영)이에요.

## [0.52.0] - 2026-08-06

윤문 결과를 모델 자평이 아니라 코드로 검증해요.

> 📝 **Note** — 이 릴리즈부터 어투 룰 용어가 자주 나와요. **S1**은 반드시 고쳐야 하는 룰, **S2**는 문맥을 보고 판단하는 룰이에요. **음차**는 영어를 소리대로 옮긴 말(에스케이프 해치 등), **윤문**은 뜻을 유지한 채 어투만 다듬는 작업이에요.

### Added

- **`gestalt humanize-check`** — 윤문 전후 두 파일을 넣으면 변경률, S1 잔존, 보호 토큰 생존, 구조 보존을 각각 재고 exit code로 답해요.

  ```bash
  gestalt humanize-check --before draft.md --after revised.md --register chat
  ```

  모델이 스스로 매긴 변경률과 등급은 참고값이라 과윤문을 실제로 막지 못했어요. 문자 기반 변경률 하나로는 구조 편집이 드러나지 않아요. 변경률 2.8%인데 문장 3할이 통째로 바뀐 경우가 있었어요.

  - 룰 목록은 `ai-tell-quick-rules.md`를 읽어서 만들어요. 코드에 룰을 복사하지 않아요
  - 정규식으로 오탐 없이 셀 수 있는 21개만 탐지해요. 뜻을 봐야 하는 룰은 뺐어요
  - `--register`가 `doc`이냐 `chat`이냐에 따라 S1 대상이 달라져요
  - 변경률은 어절 단위 LCS(Longest Common Subsequence)로 재요. 6천 어절이 넘으면 겹침 비율로 떨어져요
  - 보호 토큰(수치, 인용, 코드, URL)이 유실되면 경고가 아니라 채택 금지예요

- **`pnpm verify:rules`** — 룰북과 에이전트 문서 14곳의 룰 ID와 심각도가 어긋났는지 봐요. 기준 문서에서 ID를 지우거나 심각도를 바꿔도 손으로 옮겨 적은 사본은 그대로 남아요. 그래서 아무도 모르는 채 어긋나요. 처음 돌렸을 때 7개가 어긋나 있었어요.

  룰북에 없는 ID 인용, 자체검증 목록에서 빠진 S1, 표와 목록의 심각도 불일치, S1 자리에 섞인 S2, 룰 문서 본문의 금지 표현을 잡아요. `pnpm test`와 `pnpm build` 양쪽에 걸려 있어요.

### Changed

- **어투 룰 심각도 재조정** — AI 산문 60편과 2022년 이전 한국어 산문 60편을 대조한 결과를 반영했어요. 원어민이 오히려 더 쓰는 표현을 무조건 지우면 사람 글이 AI 글이 돼요.

  | 룰 | 전 | 후 | 근거 |
  | --- | --- | --- | --- |
  | `~를 통해` | S1 | S2 | 비번역 84.4 vs 번역 42.1로 원어민이 2배 더 써요 |
  | `~한 것이다` | S1 | S2 (연속 3회 이상일 때만) | AI 20.4 vs 사람 43.0 |
  | 부정 대구 | S2 | S1 | 사람이 쓰는 빈도 대비 9.2배로 가장 센 신호 |

  앞의 두 룰은 대화와 리뷰 코멘트에서 S1로 남겼어요. 측정 대상이 문서 산문이라 말투에는 그대로 적용되지 않아요.

- **굳은 음차를 화이트리스트에 넣었어요** — 소스, 롤백, 파싱, 레지스트리, 불릿이에요. 업계에서 굳은 말인데 목록에 없어서 이론상 위반으로 잡혔어요. 즉석 조합인 "불릿 리스트"만 "불릿 목록"으로 바꿨어요. 화이트리스트나 체크리스트처럼 통째로 하나가 된 합성어는 그대로 뒀어요.

- **화이트리스트 밖 음차 정리** — 대표 예시가 "소스 오브 트루스"인데 정작 문서들이 약어로 우회하고 있었어요.

  | 전 | 후 |
  | --- | --- |
  | SSOT, SoT | 기준, 기준 문서 |
  | 승인 게이트 | 승인 단계 |
  | 결정적 게이트 | 코드 검사 |
  | 레이어 | 자리마다 계층, 묶음, 단계, 역할 |

  "레이어 → 계층"을 일괄 치환했더니 받침이 생기면서 조사가 두 군데 깨졌어요 (`계층라면`, `계층(…)는`). 찾아 바꾸기 한 번으로 끝낼 수 있는 작업이 아니에요.

- **지라 티켓 템플릿 헤딩** — `## 인수조건 (AC)`를 `## 완료 조건`으로 바꿨어요. WDS 전체에 "인수조건"이 5개뿐이었고 그중 넷이 한 묶음이라 팀이 쓰는 말이 아니었어요. 본문의 약칭 AC도 함께 걷어서 용어를 하나로 뒀어요.

## [0.51.0] - 2026-08-06

에이전트 tier가 라벨을 넘어 실제 모델 선택으로 이어져요.

### Changed

- **tier를 모델로 해석해요** — 에이전트 frontmatter의 `tier`가 그동안 라벨로만 남아 있었어요. tier를 모델로 바꾸는 라우터는 있었지만 인스턴스화하는 곳이 0곳이라, `frontier`로 선언한 architect, harness-architect, continuity-judge가 아무 효과가 없었어요.

  이제 `ges_agent get`이 tier와 함께 해석된 `model`을 돌려줘요. 스킬이 서브에이전트를 띄울 때 그 값을 Agent 도구 `model` 파라미터로 넘겨요. 세션에서 직접 수행하면 tier는 여전히 참고값이에요.

  ```jsonc
  // gestalt.json — 기본 표를 바꾸려면
  {
    "tierModels": { "frugal": "haiku", "standard": "sonnet", "frontier": "opus" }
  }
  ```

  `tierModels` 대신 환경변수 `GESTALT_TIER_MODEL_*`로도 덮어써요. 이 값은 API 모델 ID가 아니라 호스트 Agent 도구가 받는 별칭이라 `llm.model`과 층위가 달라요.

- **기본 모델이 `claude-sonnet-4-6`에서 `claude-sonnet-5`로 올라가요** — 문서에 남아 있던 deprecated 모델 ID 4곳도 함께 정리했어요.

  > ⚠️ **Warning** — 옛 모델을 그대로 쓰려면 `gestalt.json`의 `llm.model`에 명시하세요. 지정하지 않으면 새 기본값이 적용돼요.

### Removed

- **죽은 모델 라우팅 경로를 지웠어요** — `FiguralRouter`는 인스턴스화하는 곳이 0곳이었어요. `resolvePromptModel`은 결과를 읽어갈 훅이 레포에 없었고요. 둘 다 `index.ts`에서 내보내지 않아서 패키지 공개 API는 그대로예요.

## [0.50.0] - 2026-08-06

### Changed

- **공유 룰북을 옮겼어요** — author-voice, ai-tell-quick-rules, style-guide 세 문서를 `plugin/role-agents/_shared/references/`로 옮겼어요. 다섯 개가 넘는 에이전트가 함께 쓰는데 경로가 technical-writer 하위였어요. author-voice는 헤더에 "공유 레퍼런스"라고 적어두고도 경로가 그걸 반영하지 않았고요.

  `plugin/skills/_shared`와 같은 규칙이에요. `AGENT.md`가 없어서 레지스트리가 에이전트로 로드하지 않아요. 참조 26곳을 고치면서 원래 깨져 있던 링크 2개도 같이 고쳤어요.

## [0.49.1] - 2026-08-06

### Fixed

- **"수준"으로 정도를 뭉개지 않아요** — "매끄럽게 다듬는 수준이고"는 등급 어감이 실려서 채점처럼 읽혀요. 범위를 말할 때는 "정도"로 써요. 가능하면 형식명사를 빼고 동사로 풀고요.
- **세는 단위 룰(I-5)에 가드를 붙였어요** — "안 돌려본 건 PR에 적어두셔서"의 "건"은 "것은"의 준말이에요. 늘려 쓰면 오히려 딱딱해지는데 글자로 매칭하면 이걸 잘못 고쳤어요. 세는 단위일 때만 고치도록 두 층위를 표로 나란히 뒀어요.
- **가운뎃점을 금지하는 문서가 본문 산문에서 가운뎃점을 쓰고 있었어요** — 기존 문서의 용어 목록은 예외지만 산문 나열은 예외가 아니에요.

## [0.49.0] - 2026-08-06

리뷰 리포트에서 이슈 라인을 코드와 함께 읽어요.

### Added

- **이슈별 코드 스니펫** — 리뷰 리포트가 각 이슈 아래에 해당 라인 주변 코드를 붙여요. 지목한 라인에는 `>` 마커가 붙어요.

  고정 3줄은 코드마다 맞지 않았어요. 그래서 위아래 5줄에서 시작해 들여쓰기로 감싸는 블록을 추정해 창을 조정해요.

  - 위로는 감싸는 선언을 2단계까지 붙여요. 함수 안 for 문에서 걸린 이슈면 for와 함수 선언이 함께 보여요. 이슈가 어느 함수 안에 있는지가 가장 알고 싶은 정보인데 고정 창으로는 선언이 잘려 나갔어요
  - 아래로는 감싸는 블록이 끝나는 라인에서 멈춰요. 다음 함수를 넘보지 않아요
  - 창과 선언 사이가 잘리면 생략 표시(…)를 넣어요

### Fixed

- **리뷰 코멘트를 "지적"이라 부르지 않아요** — 상대를 잡아세우는 뉘앙스가 붙어서 제안형 어투와 어긋나요. 내가 남긴 것은 "남겼던 의견", 상대가 남긴 것은 "짚어주신 부분"으로 써요. 룰 문서가 스스로 쓰던 "지적"도 함께 걷어냈어요. 금지 어휘를 본문에서 쓰면 산출물로 새거든요.
- **식별자 뒤 조사를 붙여 써요** — 리뷰 코멘트는 커밋 해시나 브랜치명을 문장에 그대로 섞어서 조사 처리가 반복적으로 어긋났어요. `6564d04 에서`는 `6564d04에서`로, `c: 로`는 `c:로`로 고쳐요. 어투가 아니라 맞춤법이라 윤문 등급과 무관하게 고쳐요.
- **한자어 명사와 추상명사 이동 동사** — "강등 방향도 맞게 갔습니다"를 "심각도 내린 것도 맞습니다"로 고쳐요. 방향이나 결론 자체가 가는 게 아니라 무언가가 그 방향으로 가는 것이라, 사람이나 대상을 주어로 되돌려요.

### Documentation

- **릴리즈 절차에 태그 이동 단계(5.5)를 넣었어요** — `npm version`이 찍는 태그는 매니페스트 커밋보다 앞을 가리켜요. 그런데 Actions는 태그를 체크아웃해 빌드해요. 그대로 두면 배포 패키지에 한 버전 뒤처진 매니페스트가 실려요. v0.47.1 태그에 0.47.0 매니페스트가 실려 나간 적이 있어요. 푸시 전에만 안전하다는 조건도 함께 적었어요.

## [0.48.0] - 2026-08-06

윤문 말고 짚어만 달라는 요청을 받아요.

### Added

- **AI-tell 탐지 모드 (humanize-monolith)** — 원문을 한 글자도 바꾸지 않고 룰 ID와 원문 인용, 한 줄 처방만 돌려줘요. "이거 AI 같아?", "패턴만 짚어줘" 같은 요청이 이쪽으로 와요.

  탐지 모드에서 막아둔 것은 세 가지예요.

  - 교정문을 예시로도 붙이지 않아요. 붙이면 사용자가 그대로 복사해 쓰게 되어 사실상 윤문 모드가 돼요
  - AI가 썼는지 판정하지 않아요. 이름 붙은 패턴은 사용자가 확인할 수 있는 근거지만 저자 추측은 근거가 없어요
  - A~D 등급을 매기지 않아요. 등급은 윤문 결과 품질 지표라서 남의 원문에 붙이면 점수를 매기는 셈이 돼요. S1과 S2 개수만 세요

- **`pnpm verify:plugin`** — `dist/plugin`이 원본과 바이트 단위로 같은지 확인해요. npm 설치 환경의 런타임이 실제로 읽는 자산은 `plugin/`이 아니라 `dist/plugin/`이에요. 그런데 postbuild가 `cp -r`만 해서 삭제를 반영하지 못했어요. `plugin/`에서 지운 스킬이 dist에 남아 배포되면 유령 스킬이 로드돼요.

  postbuild 앞에 `rm -rf dist/plugin`을 넣어 원인을 막아요. 복사한 뒤에는 한 번 더 확인하고요. 복사 누락, dist에만 남은 파일, 내용 불일치를 각각 보고하고 하나라도 있으면 빌드를 끊어요.

### Changed

- **삭제 처방은 삭제예요** — 처방에 "삭제"가 적힌 항목에서 모델이 리듬을 살리려고 새 마무리 문장이나 새 부제를 지어 넣는 일이 잦았어요. 원문에 없던 수사를 더하는 것이라 자체검증에 걸리는데도, 룰 문구가 "삭제 또는 구체화"라 재작성 여지를 남겨뒀어요.

  - 콜론 부제는 콜론 뒤를 버리고 앞부분만 남겨요. 부제를 갈아끼우면 패턴이 그대로 남아요
  - hype 어휘는 원문에 수치가 없으면 만들지 말고 수식어만 지워요
  - `본질적으로` 같은 부사는 다른 부사로 갈아끼우지 말고 삭제해요

  자체검증 항목이 6개에서 7개로 늘어난 만큼 등급 기준도 맞췄어요. A는 7항, B는 6항 이상, C는 5항 이하예요.

## [0.47.1] - 2026-08-04

### Added

- **Codex 슬래시 커맨드 6개** — `skills`만 내보내면 Codex의 `/` 목록에 뜨지 않아요. 그래서 자연어나 `$gestalt:review` 멘션으로만 부를 수 있었어요. `commands/` 디렉토리를 두면 파일명이 그대로 슬래시 커맨드가 돼요. 매니페스트에 따로 선언할 필요는 없고요.

  이름에 `gestalt-` 접두어를 붙였어요. Codex에 내장 review 명령이 있어서 `/review`로 두면 충돌하거든요. 각 커맨드는 인자와 요약만 담고 절차는 해당 `SKILL.md`를 읽게 위임해요. 스킬을 고칠 때 커맨드까지 같이 고쳐야 하는 상황을 만들지 않으려고요.

## [0.47.0] - 2026-08-04

Codex에서도 스킬을 써요.

### Added

- **Codex 플러그인 매니페스트** — `codex plugin add`로 MCP 서버와 워크플로 스킬 18개를 한 번에 받아요. 그전까지 Codex 사용자는 MCP 도구만 쓸 수 있어서 review 같은 스킬을 쓰지 못했어요. 설치 크기는 680KB예요.

  - `.agents/plugins/marketplace.json` — Codex는 이 경로에서만 마켓플레이스를 찾아요. `.codex-plugin/marketplace.json`은 인식하지 않아요
  - `plugin/.codex-plugin/plugin.json` — `skills`와 `mcpServers` 키는 Claude Code 형식과 같고 `interface` 블록만 Codex 전용이에요
  - `plugin/mcp.json` — npx로 받아 실행하므로 설치 위치에 의존하지 않아요

### Changed

- **배포 자산을 `plugin/` 하나로 모았어요** — Codex는 마켓플레이스가 가리킨 디렉토리를 통째로 복사해요. 레포 루트를 가리키면 `.git`과 `node_modules`까지 딸려가서 1.6GB가 돼요. 심링크도 따라가지 않아서 자산을 링크로 공유할 수 없었고요.

  두 클라이언트가 같은 디렉토리를 각자 매니페스트로 가리키므로 복사본이 생기지 않아요. skills와 role-agents를 함께 옮겨서 review 스킬의 `../../role-agents/` 참조는 상대 깊이가 그대로예요. `src/core/config.ts`의 자산 디렉토리 기본값 다섯 개가 함께 바뀌었어요.

### Fixed

- **버전 동기화에서 Codex 매니페스트가 빠져 있었어요** — `npm version` 후 `plugin/.codex-plugin/plugin.json`만 옛 버전으로 남았어요. `codex plugin list`가 이 파일의 `version`을 보여줘서 설치된 플러그인 버전이 실제와 달라 보였어요.

## [0.46.1] - 2026-08-04

### Fixed

- **어투 문서가 자기가 금지한 말을 쓰고 있었어요** — 에이전트가 그걸 배워 산출물로 내보내는 경로예요. F-7이 "증류"를 금지하는데 문서 7곳이 그 단어를 쓰고 있던 게 대표적이에요.

  | 전 | 후 |
  | --- | --- |
  | 증류 (7곳) | 추려낸, 뽑아낸, 바꿔 넣는다 |
  | 코퍼스, authentic (9곳) | 직접 쓴 리뷰 1,300건, 표본 범위 |
  | lexicon, metric, anchor | 표현, 지표, 근거 |
  | 레지스터(음차 8개), register(영어 7개) | "말투" |

  금지어 예시로 인용하는 자리는 그대로 뒀어요.

- **"실측"을 걷어냈어요** — code-review-writer가 이 문서를 필수로 읽다 보니 실제 PR 리뷰에 "레포 실측으로 1444개 중"으로 두 번 새어나갔어요. 세어본 것을 그렇게 부르면 뜻은 맞고 단어만 어색해요. 하지만 대조한 것을 그렇게 부르면 뜻 자체가 어긋나요. 후자는 근거 과장이라 리뷰이가 검증 없이 받아들이는 쪽으로 가요.

## [0.46.0] - 2026-08-04

### Added

- **리뷰 코멘트 헤지 밀도 상한** — "~것 같아요"를 보존 대상으로만 규정해두니 모든 문장에 붙었어요. 문장 하나하나는 자연스러운데 리뷰 전체가 기계로 읽혔고요. 코멘트당 1회, 리뷰 전체의 절반 이하로 상한을 뒀어요. 분포는 문장 단위로 잡히지 않아서 자가점검 8개 항목을 따로 뒀어요.
- **원문 음차 처리 규칙** — 굳지 않은 음차(에스케이프 해치, 스파이크)가 리뷰 대상 원문에 있다는 이유로 화이트리스트를 통과하고 있었어요. 이제 막아요. 코드블록과 인용은 그대로 둬요. 리뷰어 자기 문장은 첫 등장에 풀어쓰고요.

## [0.45.0] - 2026-07-31

실행 태스크를 외부 런타임 터미널로 뿌려요.

### Added

- **`dispatch` 스킬** — execute의 실행 단계를 외부 에이전트 런타임 터미널로 돌리는 opt-in 백엔드예요. 계획 수립과 평가, 개선은 그대로 execute가 담당해요.

  병렬 자체가 목적은 아니에요. execute가 이미 Agent 도구로 병렬을 돌리거든요. 이 스킬로 얻는 건 워커별로 다른 에이전트 CLI, 사람이 들여다볼 수 있는 터미널, `worker_done` 생애주기 셋이에요. 필요 없으면 기본 경로가 더 가벼워요.

  - 런타임 감지에 실패하면 흉내내지 않고 기본 경로를 권하며 멈춰요
  - 리눅스에서 `orca`는 GNOME 스크린리더 이름이라 존재 확인이 아니라 status 응답으로 판단해요
  - 워커는 캐시된 세션 상태를 믿지 않고 `worker_done`마다 다시 읽어요. 서버 프로세스마다 인메모리 세션을 따로 들고 있거든요

### Fixed

- **SQLite 연결에 `busy_timeout`을 설정했어요** — `journal_mode`와 `foreign_keys`만 걸고 `busy_timeout`을 걸지 않았어요. 그래서 프로세스가 둘 이상 같은 DB에 쓰면 잠금이 풀리기를 기다리지 않고 SQLITE_BUSY로 즉시 실패했어요. pragma는 연결마다 설정해야 적용돼요.

  이벤트 DB는 홈 글로벌 경로(`~/.gestalt/events.db`)이고 MCP 서버는 클라이언트 세션마다 프로세스가 따로 떠요. 같은 레포에서 창을 두 개만 열어도 이미 겹쳐요. 코드 그래프 DB도 같이 걸었어요. post-commit 훅이 증분 빌드를 도는 동안 다른 창에서 blast radius를 돌리는 상황이 실제로 생기거든요.

  WAL(Write-Ahead Logging) 설정 직후에 넣었어요. 앞에 두면 `journal_mode` 전환 자체가 경합에 걸려요.

## [0.44.0] - 2026-07-31

받은 리뷰에 답글까지 달아요.

### Added

- **`review-reply` 스킬** — PR에 달린 리뷰 코멘트를 수집해 유형별로 처리하고 답글을 인라인으로 게시해요. review 스킬은 diff를 읽어 리뷰를 만드는 방향이라 게시 경로가 `pulls/{n}/reviews`뿐이었어요. 답글은 스레드 API(`comments/{id}/replies`)라 붙일 데가 없었고요.

  - 미해결 스레드는 REST가 resolved 여부를 주지 않아서 GraphQL `reviewThreads`로 조회해요
  - 승인 단계를 두 군데 뒀어요. 무엇을 수용하고 무엇을 반박할지 정하는 유형 분류, 그리고 게시 직전 답글 미리보기예요
  - accept로 분류했는데 커밋이 없으면 답글을 쓰지 않아요. "반영했습니다"는 리뷰어가 approve 근거로 삼는 사실 주장이거든요
  - 스레드 resolve 기본값은 false예요. 해결 판단은 리뷰어 몫이니까요

- **`code-review-responder` 에이전트** — 리뷰 받는 쪽 답글을 전담해요. 기존 code-review-writer는 리뷰어 관점 전용이라 severity 판정과 `r:`/`c:`/`a:` 접두어가 답변에 맞지 않았어요.
- **`sessionId` 셀렉터** — `active`와 `latest`로 세션을 지정해요.

### Documentation

- **`_shared/` 공유 규칙** — 외부에서 읽어온 텍스트를 다루는 규칙과 도구가 없을 때의 대응을 뺐어요. 스킬마다 반복해 적지 않으려고요.

## [0.43.0] - 2026-07-30

지금 동시에 붙일 수 있는 태스크를 호스트가 알아요.

### Added

- **`nextTaskIds`** — 착수 가능한 태스크 집합을 `execute_task`, `resume`, `status` 세 경로에 실어요. 2개 이상일 때만 안내 문구를 덧붙여요. 실행 자체는 그대로 순차예요. 병렬로 붙일지는 호스트가 판단하고요.

  기존 `nextTaskId`는 이 배열의 첫 원소에서 파생되므로 둘의 의미가 어긋나지 않아요. 세션 갱신과 이벤트 replay가 `computeReadyTaskIds` 한 함수를 써요. 순회 기준은 `topologicalOrder`예요. 순환이나 자기참조가 있으면 validator가 이 배열을 비우므로 빈 집합이 나와요.

  replay 경로가 그동안 `nextTaskId`를 초기값 null에서 갱신하지 않았어요. 그래서 서버 재시작 후 `ges_status`는 null인데 `resume`은 정상값을 내보내 같은 세션에 두 응답이 어긋났어요. 이번에 함께 풀렸어요.

### Documentation

- **스킬 description에 경계를 선언했어요** — 겹치는 스킬이 여럿인데 언제 쓸지만 적혀 있어서 오발동 여지가 있었어요. 어느 스킬을 대신 쓸지 한 줄씩 명시했어요. blast-radius는 안 고친 코드이고 diff-radius는 이미 고친 변경, pr은 만들기이고 review는 검토, setup은 최초 1회이고 build-graph는 그래프만이에요.

## [0.42.1] - 2026-07-26

### Fixed

- **인터뷰 Continuity 모순 감지가 항상 false였어요** — 존재하지 않는 차원명을 비교하고 있었어요. `contradictions` 배열 존재 여부로 바꿨어요. 감지된 모순은 세션과 이벤트에 남겨서 라운드별로 조회할 수 있어요.
- **코드 그래프 증분 빌드에서 역방향 엣지가 사라졌어요** — 파일 F만 바뀌면 F를 참조하는 A가 재파싱 대상에서 빠졌어요. 그래서 `deleteByFile`이 지운 A→F 엣지가 복원되지 않았어요. 이제 변경 파일을 참조하는 파일 목록(1-hop)을 함께 재파싱해요.
- **Drift 감지가 상시 발화했어요** — 목표와 산출물 문장 사이 Jaccard 유사도가 구조적으로 낮게 나와서, 정렬된 산출물조차 임계값을 넘겨 CRITICAL로 오판정됐어요. 임베딩 코사인 유사도로 바꾸고(임베딩 실패 시 Jaccard 폴백) 임계값을 0.3에서 0.6으로 올렸어요. 임베딩 호출이 비동기라 execute와 benchmark 호출 체인 전체에 async가 전파돼요.
- **세션 replay가 `completedTaskIds`를 복원하지 않았어요** — 서버 재시작 후 진행률이 0%로 잘못 표시됐어요. `evolve_fix`가 이벤트 없이 세션을 직접 바꿔 replay가 라이브 상태와 어긋나던 것도 함께 고쳤어요. 과거 이벤트 로그는 마이그레이션하지 않아서 신규 세션부터 적용돼요.
- **텍스트 기반 스펙 생성이 해상도를 하드코딩했어요** — `resolutionScore`를 무조건 1로 박아서 "완벽 해상도" 스펙으로 오기록됐어요. null(명시적 미채점)로 바꿨어요.
- **`force: true` 우회에 감사 기록이 없었어요** — `ges_generate_spec`을 `force: true`로 호출해 임계값을 넘길 때 `SPEC_FORCE_OVERRIDE` 이벤트를 남겨요.

## [0.42.0] - 2026-07-25

### Added

- **`presentation-writer` 에이전트와 `presentation` 스킬** — 슬라이드별 메시지와 카피, 데이터 요약, 발표 노트는 writer가 써요. Reveal.js 구조와 비주얼은 기존 presentation-designer가 맡아서 역할을 나눴어요. 미니 인터뷰로 주제와 청중, 분량을 확정하고 승인 단계를 거쳐 HTML까지 가요.

### Fixed

- **`diff_radius`가 MCP 클라이언트에 광고되지 않았어요** — `server.ts`에 등록된 입력 스키마가 `schemas.ts`의 `codeGraphInputSchema`와 어긋나서 액션과 `diffMode` 파라미터가 빠져 있었어요.

### Documentation

- **문서의 개수와 목록을 실제 코드에 맞췄어요** — 설치 안내 표에 "13 Role+3 Review"라고 적혀 있었는데 실제는 9 Role에 4 Review였어요. MCP 도구 목록, `src/` 디렉토리, 아키텍처 다이어그램도 함께 정합화했어요.
- **누락된 MCP 도구를 문서화했어요** — `ges_graph_visualize`, `ges_generate_kb`, `ges_search`, `ges_sync` 섹션을 새로 썼어요.
- **v0.27.0~v0.41.1 이력을 보강했어요**

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
