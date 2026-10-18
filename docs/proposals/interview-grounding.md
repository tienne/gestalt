# 인터뷰 근거 보강: 관련 코드 주입과 남은 가정 목록

## 배경

인터뷰는 요구사항을 수치로 좁히는 단계인데, 브라운필드에서는 두 군데가 근거 없이 돈다.

첫째, 기존 코드를 보지 않는다. 브라운필드 판정은 마커 파일 10개(`src/interview/brownfield.ts:5-16`) 중 2개 이상이 있는지만 센다(`src/interview/brownfield.ts:34`). 판정이 끝나면 코드는 더 쓰이지 않는다. 질문 프롬프트에는 토픽과 원리, 이전 라운드만 들어간다(`src/llm/prompts.ts:44-67`). 그래서 "알림 예약 발송을 넣고 싶다"는 답에 "어떤 방식으로 예약할까요"라고 묻는다. 레포에 이미 예약 큐 모듈이 있어도 그렇다. 해상도의 `contextClarity`는 브라운필드 가중치 0.2를 받는 차원이다. 그런데 채점 프롬프트에는 대화록만 들어가고(`src/llm/prompts.ts:69-97`) 이 차원은 JSON 키 한 줄로만 요구된다(`src/llm/prompts.ts:93`). 일반 모드 채점기도 같은 프롬프트를 쓴다(`src/interview/resolution.ts:23-30`). 채점자는 사용자가 기존 코드와의 관계를 말했는지 대조할 대상이 없다. 그러니 "기존 시스템과 잘 맞는다고 말했다" 수준의 답에도 높은 점수를 준다.

둘째, 0.8을 넘겨 끝낸 인터뷰에도 답하지 않은 것이 남는다. 0.8은 가중 평균이라 `priorityClarity`가 0.6이어도 다른 차원이 메우면 통과한다. 지금 `complete`는 라운드 수와 최종 점수, `forced`만 돌려준다(`src/mcp/tools/interview-passthrough.ts:201-210`). 무엇이 비었는지는 응답에 없다. Spec 생성 프롬프트(`src/llm/prompts.ts:99-126`)는 빈 곳을 constraints나 acceptanceCriteria에 조용히 채운다. Evolve가 Contextual 실패를 고칠 때도 미충족 AC와 권고만 보고 패치를 짠다(`src/execute/prompts.ts:572-640`). 실패의 원인이 "인터뷰 때 누구도 확인하지 않은 전제"였는지 알 길이 없다.

코드 그래프에는 이미 쓸 만한 재료가 있다. 훅이 쓰는 `rankPointers`(`src/code-graph/hooks/pointers.ts:202`)는 영문 식별자, 한국어 bigram(주석과 커밋 메시지), 티켓 키를 파일 단위로 합쳐 포인터를 고른다. 다만 이슈 #51에 적힌 대로 한국어만 쓴 프롬프트에서는 회수율이 매우 낮다. 커밋 재현에서 맞힌 비율이 2~3%, 실제 프롬프트에서는 0%였다. 정밀도를 지키려고 문턱을 `max(4, 3.5 × ln(1 + N))`로 올렸기 때문이다(`src/code-graph/hooks/pointers.ts:20`, `:30`). KB 생성기가 만드는 파일별 한 줄 요약은 `.gestalt-kb/code-graph/*.md` 본문에 `<!-- summary -->` 표식과 함께 들어가지만(`src/knowledge-base/summarizer.ts:217`) 아직 bigram 색인에는 안 들어가 있다. 엔트리 제목은 레포 기준 상대 경로다(`src/knowledge-base/generator.ts:93`).

이 문서는 두 가지를 설계한다. 하나는 인터뷰 질문과 채점에 관련 코드를 근거로 넣는 것이고 다른 하나는 인터뷰가 끝날 때 남은 가정을 목록으로 뽑아 Spec과 Evolve까지 들고 가는 것이다.

## 설계

### 파트 1. 브라운필드 인터뷰에 코드 맥락 넣기

#### 원칙

- 찾은 모듈은 후보이고 사실이 아니다. 질문은 "X가 이미 이걸 하는 것 같은데 확장할까요, 새로 만들까요"처럼 확인을 구하는 꼴로 만든다. 후보가 틀리면 한 라운드를 쓰지만 사용자가 바로잡을 수 있다. 반면 단정하고 넘어가면 틀린 전제가 Spec까지 간다.
- 정밀도 쪽 문턱은 훅과 같은 값을 쓴다. 회수율은 문턱을 내려서 올리지 않는다. 재료를 늘리는 방법(KB 요약)과 사용자에게 식별자를 묻는 방법(앵커 질문)으로 올린다.
- 그래프가 없거나 아무것도 못 찾았을 때의 상태를 응답과 프롬프트에 그대로 적는다. 호스트 LLM이 빈자리를 그럴듯한 모듈 이름으로 채우지 못하게 하려는 것이다.

#### 타입

새 파일 `src/interview/code-context.ts`에 둔다.

```ts
export type CodeContextSource = 'symbol' | 'korean-index' | 'kb-summary';

export interface CodeContextModule {
  path: string; // 레포 기준 상대 경로
  line?: number;
  symbol?: string; // 파일 노드로 걸렸으면 없다
  summary?: string; // KB 한 줄 요약. 없으면 생략
  sources: CodeContextSource[];
  evidence: string; // 'commit "예약 발송" 3건' 꼴. evidenceLabel()과 같은 문구
  score: number;
  firstSeenRound: number; // 0은 start(토픽)에서 찾은 것
}

export type CodeContextStatus =
  | 'found' // 이번 조회에서 1개 이상
  | 'none-matched' // 그래프는 있는데 문턱을 넘은 후보가 없다
  | 'no-graph' // .gestalt/code-graph.db 없음
  | 'no-repo-root' // 세션에 repoRoot가 없다 (옛 세션, 그린필드)
  | 'error'; // 조회 중 예외. 인터뷰는 계속한다

export interface CodeContextLookup {
  status: CodeContextStatus;
  modules: CodeContextModule[];
  elapsedMs: number;
}

export interface CodeContextProvider {
  lookup(repoRoot: string, text: string, round: number): CodeContextLookup;
}
```

`InterviewSession`(`src/core/types.ts:56-68`)에 선택 필드 두 개를 더한다.

```ts
repoRoot?: string;                 // 그래프를 찾은 레포 루트. 브라운필드일 때만
codeContext?: CodeContextModule[]; // 세션 동안 누적. 최대 8개
```

#### 조회 방법

`DefaultCodeContextProvider.lookup`은 아래 순서로 돈다. 모두 동기 호출이다. `CodeGraphStore`가 better-sqlite3를 쓰므로 `PassthroughEngine`의 동기 시그니처를 바꾸지 않아도 된다.

1. `${repoRoot}/.gestalt/code-graph.db`가 없으면 `no-graph`로 끝낸다. 훅과 같은 이유로 DB를 새로 만들지 않는다.
2. 질의 텍스트를 `tokenizePrompt`(`src/code-graph/hooks/rank.ts:141`)로 쪼개고 `rankPointers(store, repoRoot, tokens, 5)`를 부른다. 게이트(`MIN_POINTER_SCORE`, `TEXT_PROMPT_IDF_MULTIPLE`, `hasEnoughEvidence`)는 그대로 둔다. 질의 전 최신화는 하지 않는다. 엔진이 파서를 불러오는 데만 260ms가 걸리고(docs/code-graph.md "그래프 갱신은 백그라운드로"), 인터뷰는 개념 수준이라 커밋 사이 변경까지 반영할 필요가 없다.
3. KB 요약이 있으면 보조 신호로 쓴다. `.gestalt-kb/code-graph/*.md`에서 `<!-- summary -->` 다음 줄과 제목(상대 경로)을 읽어 프로세스 안에서 `koreanEojeols`(`src/code-graph/ko-text.ts:188`) 기반 bigram 맵을 만든다. 디렉토리 mtime을 키로 캐시한다. 매칭 규칙은 #51 제안과 같다. 어절 bigram의 절반 이상이 맞아야 그 어절을 걸린 것으로 치고 서로 다른 어절 2개 이상이 한 요약에서 맞아야 후보로 올린다. 2번에서 이미 고른 파일이면 `sources`에 `kb-summary`를 더하고 `summary`를 붙인다. 새 파일이면 요약 점수로 후보에 넣는다.
4. 2번에서 고른 파일도 KB 요약이 있으면 `summary`를 붙인다. 이름만 보고는 판단이 안 되는 호스트 LLM에게 "이 파일이 무슨 일을 하는지"를 같이 보여주려는 것이다.
5. 전체 예산은 200ms다. 넘으면 그때까지 모은 결과만 돌려준다. 예외가 나면 `error`로 돌려주고 `logger.warn`만 남긴다.

`rankPointers`는 지금 `src/code-graph/hooks/` 아래 있다. 인터뷰가 훅 디렉토리를 직접 import하지 않게 `src/code-graph/index.ts`에서 다시 내보낸다.

KB 요약을 프로세스 안 맵으로 따로 매칭하는 건 #51이 들어오기 전까지 쓰는 다리다. #51이 요약을 `cg_doc_terms`에 넣으면 3번은 지우고 2번만 남긴다. `CodeContextModule.sources`의 `kb-summary` 값은 그대로 쓴다.

#### 질의 텍스트

- `start`: 토픽.
- `respond`: 이번 라운드의 사용자 답 한 개. 질문은 넣지 않는다. 질문은 호스트 LLM이 앞 라운드의 "관련 코드" 블록을 보고 쓴 문장이라, 넣으면 이미 찾은 모듈을 다시 찾는 되먹임이 생긴다.

#### 앵커 질문

한국어만으로는 대부분 `none-matched`가 날 것으로 본다(#51 수치). 그래서 회수율은 사용자에게 식별자를 얻어서 올린다. 브라운필드이고 그래프가 있는데 2라운드가 끝나도록 세션 누적 후보가 0개면, 다음 질문 프롬프트에 지시 한 줄을 더한다. "이번 질문 끝에, 비슷한 일을 하는 기존 파일이나 함수 이름을 알면 알려달라는 부탁을 한 문장 붙인다. 모르면 넘어가도 된다고 덧붙인다." 사용자가 `scheduleMessage`나 `notify/` 같은 이름을 적으면 영문 경로가 잘 잡는다. 통째로 적힌 식별자는 문턱 예외이기도 하다(`namedExactly`). 이 지시는 세션당 한 번만 붙인다.

#### 흐름

`PassthroughEngine`(`src/interview/passthrough-engine.ts`)을 이렇게 바꾼다.

- 생성자에 `codeContextProvider?: CodeContextProvider`를 받는다. 없으면 조회를 아예 안 한다. 테스트에서는 가짜 provider를 넣는다.
- `start`(`:79-120`): `detectProjectType`(`:85`) 다음에 `resolveGraphRoot(cwd)`를 부른다. cwd부터 git 최상위까지 올라가며 `.gestalt/code-graph.db`를 찾는 함수다. 찾았으면 마커 수와 상관없이 `projectType`을 `brownfield`로 둔다. 그래프가 있다는 건 코드가 있다는 뜻이기 때문이다. `repoRoot`는 `INTERVIEW_SESSION_STARTED` 페이로드에 싣는다(`src/interview/session.ts:77-80`). 그다음 토픽으로 조회하고 결과를 `buildGestaltContext`(`:101`)에 넘긴다.
- `respond`(`:122-232`): 응답을 기록한(`:147`) 직후 이번 답으로 조회한다. 결과는 세션 누적 목록에 합친다. 같은 path는 점수가 높은 쪽을 남기고 `firstSeenRound`는 처음 값을 유지한다. 8개를 넘으면 점수가 가장 낮은 것부터 뺀다. 조회 결과는 새 이벤트 `INTERVIEW_CODE_CONTEXT_FOUND`로 남긴다. 페이로드는 `{ roundNumber, status, modules }`이고 `src/interview/repository.ts`의 replay가 같은 병합 규칙으로 세션에 복원한다. 그다음 `buildGestaltContext`(`:196-203`)에 이번 조회 결과와 누적 목록을 넘긴다.
- `score`(`:234-271`): 점수 프롬프트를 만들 때(`:264`) 누적 목록을 근거로 넘긴다.

주입 자리는 `systemPrompt`가 아니라 `questionPrompt`와 `scoringPrompt`다. 이유는 셋이다.

1. 메모리 맥락은 `start`에서만 `systemPrompt` 뒤에 붙고(`:103-105`) `respond`가 만드는 `systemPrompt`에는 없다(`:312-316`). 코드 맥락은 라운드마다 바뀌는데 이 경로를 따르면 1라운드 이후에 사라진다.
2. `questionPrompt`는 호스트가 매 라운드 새로 읽는 자리라 "이번 답에서 찾은 것"을 싣기에 맞다.
3. 옛 스킬도 `questionPrompt`를 그대로 쓰므로 스킬을 안 고쳐도 효과가 난다.

#### 토큰 예산

| 자리                                   | 넣는 것                                                           | 상한     |
| -------------------------------------- | ----------------------------------------------------------------- | -------- |
| `questionPrompt`의 "관련 코드" 블록    | 이번 라운드 새 후보 먼저, 나머지는 누적 목록에서 점수순. 최대 5줄 | 1200자   |
| `scoringPrompt`의 "Code evidence" 블록 | 누적 목록 전체. 최대 8줄. 줄마다 `firstSeenRound` 표시            | 1500자   |
| 줄 하나                                | `path:line — symbol. 요약 (근거)`. 요약은 100자에서 자른다        | 약 220자 |

훅의 `UserPromptSubmit`이 포인터 3개에 800자를 쓰는 것(docs/code-graph.md "이벤트별로 넣는 것")과 비슷한 밀도다. 요약 한 줄이 더 붙는 만큼 늘렸다. 메모리 블록은 필드당 300자로 접혀(`src/memory/memory-context-injector.ts:122`) 시스템 프롬프트에 한 번만 들어간다. 둘을 합쳐도 라운드당 추가분은 블록 하나, 1200자다.

#### 프롬프트 변경

`buildQuestionPrompt`(`src/llm/prompts.ts:44`)에 선택 인자 `codeContext?: { status: CodeContextStatus; block: string; anchorAsk: boolean }`를 더한다. 이전 라운드 다음, 지시문 앞에 넣는다.

```text
## 관련 코드 (코드 그래프, 라운드 3 답변 기준)
답변 낱말로 찾은 후보다. 사실로 단정하지 말고 질문으로 확인한다.
- src/notify/scheduler.ts:42 — scheduleMessage. 예약 발송 큐에 메시지를 넣고 꺼낸다 (주석 "예약 발송")
- src/notify/slack.ts:10 — sendSlack (커밋 "슬랙 발송" 2건)

When a candidate overlaps the user's intent, ask whether to extend it, replace it,
or build something new alongside it. Name the file. Do not assume it is the right one.
```

상태별 블록은 이렇다.

| status                   | 블록                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `found`                  | 위와 같다                                                                                            |
| `none-matched`           | `## 관련 코드\n코드 그래프에서 이번 답과 겹치는 후보를 못 찾았다. 기존 모듈 이름을 지어내지 않는다.` |
| `no-graph`               | `## 관련 코드\n코드 그래프가 없다. 기존 코드 근거 없이 묻는다. 모듈 이름을 지어내지 않는다.`         |
| `no-repo-root`, 그린필드 | 블록 없음                                                                                            |
| `error`                  | `none-matched`와 같은 문구                                                                           |

`buildResolutionPrompt`(`src/llm/prompts.ts:69`)에도 선택 인자 `codeEvidence?: { status; block }`를 더한다. 브라운필드일 때만 넣는다.

```text
## Code evidence (candidates found from the user's answers)
- [R3] src/notify/scheduler.ts:42 — scheduleMessage. 예약 발송 큐 ...

contextClarity rubric:
- 0.8+ : the transcript states how the change relates to the listed modules
         (extend / replace / build alongside / unrelated), confirmed by the user.
- 0.5-0.7 : existing code is mentioned but the relation is not settled.
- <0.5 : listed candidates were never addressed.
List in "contextEvidence" the paths your contextClarity relies on.
```

그래프가 없으면 블록 대신 이 루브릭이 들어간다. "코드 근거가 없다. 사용자가 기존 파일이나 모듈을 직접 짚고 관계를 말했을 때만 0.8 이상을 준다."

JSON 응답 예시에 `"contextEvidence": []`를 더한다.

#### MCP 요청과 응답 변경

`ges_interview` 입력(`src/mcp/schemas.ts:26-63`)의 `resolutionScore`에 선택 필드 하나를 더한다.

```ts
contextEvidence: z.array(z.string()).optional()
  .describe('contextClarity 채점에 쓴 코드 경로. scoringPrompt의 Code evidence에서 고른다'),
```

서버는 이 값을 점수 계산에 쓰지 않는다. 대신 세 경우에 `scoreWarnings`를 붙인다. 브라운필드이고 누적 후보가 1개 이상이고 `contextClarity`가 0.8 이상인데 `contextEvidence`가 비었을 때가 첫째다. 둘째는 `contextEvidence`에 누적 목록에도 대화록에도 없는 경로가 있을 때다. 셋째는 그래프가 있는데 대화록에 경로나 식별자가 하나도 없는데 `contextClarity`가 0.8 이상일 때다. 거절하지는 않는다. Passthrough 점수는 호스트가 매긴 값이고 서버는 부풀리기를 막지 않는다는 지금 원칙(docs/01-interview.md "Passthrough 모드의 해상도 점수")을 유지한다. 경고만 이벤트에 남겨 나중에 잴 수 있게 한다.

`start`와 `respond` 응답(`src/mcp/tools/interview-passthrough.ts:35-49`, `:68-94`)에 최상위 필드 하나를 더한다.

```json
"codeContext": {
  "status": "found",
  "newThisRound": ["src/notify/scheduler.ts"],
  "modules": [
    {
      "path": "src/notify/scheduler.ts",
      "line": 42,
      "symbol": "scheduleMessage",
      "summary": "예약 발송 큐에 메시지를 넣고 꺼낸다",
      "sources": ["korean-index", "kb-summary"],
      "evidence": "주석 \"예약 발송\"",
      "firstSeenRound": 3
    }
  ]
}
```

그린필드이거나 `repoRoot`가 없으면 필드를 아예 싣지 않는다. `sanitizeSurfaceContext`(`src/gestalt/surface-labels.ts:144`)는 모르는 키를 그대로 통과시키므로 손대지 않는다.

#### 메모리 주입과의 관계

|      | 메모리(`src/memory/`)                                           | 코드 맥락                         |
| ---- | --------------------------------------------------------------- | --------------------------------- |
| 무엇 | 지난 스펙 목표, ADR, 실행 이력                                  | 지금 레포의 파일과 심볼           |
| 언제 | `start` 한 번                                                   | `start`와 매 `respond`            |
| 어디 | `systemPrompt` 끝                                               | `questionPrompt`, `scoringPrompt` |
| 조회 | 임베딩 3초 타임아웃(`src/memory/memory-context-injector.ts:11`) | SQLite 조회와 파일 읽기, 200ms    |

둘은 층이 다르므로 합치거나 중복을 거르지 않는다. ADR에 모듈 이름이 나오고 코드 맥락에도 같은 파일이 나오면 서로를 보강하는 신호로 둔다. 메모리가 1라운드 뒤 `systemPrompt`에서 빠지는 현상은 이번 범위 밖이다. 열린 질문에 남긴다.

훅과의 관계도 정리해 둔다. 코드 그래프 훅을 켠 레포에서는 사용자 답을 보낼 때 `UserPromptSubmit` 포인터가 따로 붙을 수 있다. 훅은 Claude 세션 상태 파일로 중복을 막고(docs/code-graph.md "같은 포인터를 두 번 넣지 않는다") 인터뷰는 세션 누적 목록으로 막는다. 둘이 같은 파일을 한 번씩 보여줄 수는 있다. 훅은 기본 꺼짐이고 인터뷰 주입은 훅 설정과 무관하게 돈다. 그래서 둘을 엮지 않는다.

#### Spec으로 이어가기

Spec에 선택 필드 `codeContext`를 더한다.

```ts
export interface SpecCodeContext {
  path: string;
  symbol?: string;
  relation: 'extend' | 'replace' | 'reuse' | 'avoid';
  note: string; // 인터뷰에서 정한 내용 한 문장
  source: 'code-graph' | 'user';
}
```

- Spec Call 1: `buildSpecPrompt`(`src/llm/prompts.ts:99`)에 세션 누적 목록을 싣는다. 지시는 이렇다. "대화록에서 사용자가 관계를 정한 모듈만 `codeContext`에 넣는다. 정하지 않은 후보는 넣지 않는다."
- Spec Call 2: `validateAndStore`(`src/spec/passthrough-generator.ts:73`)가 경로를 대조한다. 세션 누적 목록에 있으면 `source: 'code-graph'`, 대화록 답변에 문자열로 나오면 `source: 'user'`로 받는다. 둘 다 아니면 빼고 응답의 `droppedCodeContext`에 사유와 함께 적는다. 정하지 않은 후보를 서버가 채워 넣지는 않는다. 관계를 모르는 항목이 Spec에 섞이면 Execute가 그걸 결정 사항으로 읽는다.

Execute가 `codeContext`를 쓰는 일(계획 프롬프트 노출, `hydrateSuggestedFiles` 시드)은 이번 범위에 넣지 않는다.

### 파트 2. 남은 가정 목록

#### 타입

`src/core/types.ts`에 더한다.

```ts
export type AssumptionSource = 'interview-gap' | 'default' | 'inferred';
export type ResolutionDimensionName =
  | 'goalClarity'
  | 'constraintClarity'
  | 'successCriteria'
  | 'priorityClarity'
  | 'contextClarity';

export interface Assumption {
  id: string; // 서버가 매긴다. A1, A2 ...
  statement: string; // 300자 이하, 한 문장
  source: AssumptionSource;
  relatedDimension: ResolutionDimensionName;
  confidence: number; // 0~1. 사용자 의도와 맞을 거라 보는 정도
  confirmed: boolean; // 인터뷰 끝에서 사용자가 그대로 두라고 했다
  evidence?: string; // 'R4', 'src/notify/scheduler.ts' 같은 근거
  status?: 'open' | 'held' | 'broken'; // Evolve가 갱신. 없으면 open
}
```

요청받은 네 필드(`statement`, `source`, `relatedDimension`, `confidence`)에 네 필드를 더했다. `id`는 Evolve 패치가 항목을 가리키는 데 필요하다. `confirmed`는 인터뷰 끝 확인 결과이고 `status`는 실행 뒤 판정이다. `evidence`는 선택이다.

`source`의 뜻은 이렇다.

| source          | 뜻                                                       | 예                                             |
| --------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `interview-gap` | 물었지만 답이 흐렸거나, 점수가 낮은 차원이라 안 다뤄졌다 | "실패한 예약 발송은 재시도하지 않는다"         |
| `default`       | 아무도 말하지 않아 관례나 조직 표준으로 뒀다             | "시간대는 KST로 둔다"                          |
| `inferred`      | 답에서 끌어냈지만 사용자가 그 말을 직접 하지는 않았다    | "관리자만 예약을 취소한다(R3의 권한 언급에서)" |

`InterviewSession`에 `assumptions?: Assumption[]`를, `Spec`(`src/core/types.ts:95-103`)에 `assumptions?: Assumption[]`와 `codeContext?: SpecCodeContext[]`를 더한다.

#### 흐름

1. `respond`나 `score`가 `isReady: true`를 돌려줄 때 응답에 `completionContext.assumptionsPrompt`를 싣는다. 프롬프트 재료는 세 가지다. 대화록, 마지막 점수의 차원별 clarity와 `improvementHint`, 브라운필드면 코드 맥락 누적 목록이다.
2. 호스트는 그 프롬프트로 가정 목록을 만들고 사용자에게 보여준 뒤 한 번 확인받는다(아래 "사용자 확인"). 사용자가 다른 답을 주면 그 항목은 가정이 아니다. 호스트는 그 항목을 질문으로 바꿔 `respond` 한 라운드로 먼저 기록한다. 대화록을 하나의 원본으로 남기려는 것이다. 이 라운드로 점수가 0.8 아래로 떨어지면 인터뷰를 이어간다.
3. `complete`에 `assumptions`를 넘긴다. 서버는 Zod로 검증하고 id를 매긴 뒤 `INTERVIEW_SESSION_COMPLETED` 페이로드(`src/interview/session.ts:225-229`)에 싣는다. replay(`src/interview/repository.ts:148-150`)가 복원한다.
4. `force`로 끝낼 때도 같다. 단, `complete` 거절 메시지와 force 확인 단계에서 가정 프롬프트를 먼저 돌리게 안내한다. 0.8 미만으로 끝낸 세션이야말로 빈 곳이 많아서다.
5. `assumptions` 없이 `complete`를 부르면(옛 스킬) 지금처럼 완료한다. 응답에 `assumptionsRecorded: false`를 싣는다. 이 경우 Spec 단계가 가정을 만든다(아래).

#### Spec 생성

- Call 1: 세션에 가정이 있으면 `specPrompt`에 "Recorded assumptions" 절로 싣고 지시한다. "이 목록은 고치지 않고 그대로 둔다. Spec을 쓰면서 새로 생긴 전제만 `assumptions`에 더한다." 가정이 없으면 Call 1이 1번의 프롬프트 내용을 품어 처음부터 만들게 한다.
- Call 2: 서버가 합친다. 세션 가정은 id와 `confirmed`를 그대로 두고 앞에 놓는다. LLM이 빠뜨려도 서버가 다시 붙인다. LLM이 새로 낸 항목은 문장 정규화(공백, 끝 문장부호 제거) 후 같은 게 없을 때만 뒤에 붙인다. 이때 `confirmed: false`로 두고 id를 이어서 매긴다. 전체 상한은 15개다.
- 응답에 `assumptionSummary: { total, unconfirmed }`를 싣는다.

#### 사용자 확인

인터뷰 스킬(`plugin/skills/interview/SKILL.md`)의 Process 4단계 앞에 "남은 가정 확인"을 넣는다. 보여주는 꼴은 이렇다.

```text
해상도 0.84로 인터뷰를 끝낼 수 있어요. 끝내기 전에, 묻지 않고 넘어간 전제가 4개 있어요.

| # | 전제 | 왜 남았나 | 확신 |
|---|---|---|---|
| A1 | 실패한 예약 발송은 재시도하지 않는다 | 인터뷰에서 안 다룸 (우선순위) | 낮음 |
| A2 | 시간대는 KST로 둔다 | 관례대로 둠 | 높음 |
| A3 | 관리자만 예약을 취소한다 | 3번 답에서 추론 | 중간 |
| A4 | 기존 scheduler.ts 큐를 확장한다 | 2번 답에서 추론 (코드) | 중간 |

그대로 두면 Spec에 "확인한 전제"로 들어가요. 틀린 건 번호와 바른 내용을 알려주세요.
```

- 확인은 한 번만 받는다. "다 괜찮다"면 전부 `confirmed: true`다.
- 답이 없거나 "나중에"면 전부 `confirmed: false`로 넘긴다.
- 번호로 고친 항목은 2번 흐름대로 `respond` 라운드가 된다. 고친 항목은 목록에서 뺀다.
- 표의 "왜 남았나"는 사용자 문구로 바꿔 보여준다. 내부 값(`interview-gap` 등)은 화면에 내지 않는다(docs/roadmap.md 2절의 사용자 노출 원칙).

이 단계는 스킬의 "Never Self-Answer" 규칙과 맞물린다. 가정 목록은 에이전트가 답을 대신 채우는 게 아니다. 이미 대화록에 생긴 빈 곳을 드러내고 사용자에게 넘기는 것이다. 0.5단계의 "물음을 없애되 그 사실을 사용자에게 알린다"와 같은 방향이다.

#### Evolve

Contextual 평가가 실패해 `evolve`가 `evolveContext`를 낼 때(`src/execute/orchestrators/evolution.ts:191-208`) 가정을 먼저 보게 한다.

- `buildContextualEvolvePrompt`(`src/execute/prompts.ts:572`)에 "Assumptions to check first" 절을 넣는다. 자리는 "Unsatisfied Criteria" 앞이다. 순서는 `confirmed: false`가 먼저고 그 안에서는 `confidence`가 낮은 순이다. 이미 `broken`인 항목은 맨 뒤에 따로 표시한다.
- 지시를 더한다. "각 미충족 AC의 gap이 어느 가정에서 왔는지 먼저 본다. 가정이 깨졌으면 `assumptions`에 `broken`으로 적고 그걸 반영해 constraints나 acceptanceCriteria를 고친다. 가정과 무관하면 지금처럼 패치한다."
- `EVOLVE_CONTEXTUAL_SYSTEM_PROMPT`(`src/execute/prompts.ts:556-570`)의 Patch Scope에 한 줄을 더한다. "Assumptions: status only (held / broken). Never edit statement, never add or remove."
- `ContextualEvolveContext`(`src/execute/orchestrators/types.ts:139-146`)에 `assumptions?: Assumption[]`를 더해 정렬된 목록을 그대로 싣는다. MCP 응답(`src/mcp/tools/execute/evolve.ts:131-139`)의 `hint`는 Spec에 가정이 있을 때 이 문구로 바꾼다. "evolveContext.assumptions부터 보세요. 확인 안 된 가정이 깨졌으면 사용자에게 알린 뒤 패치하세요."

패치 스키마는 이렇게 바뀐다.

```ts
// src/core/types.ts SpecPatch (:393-400)
assumptions?: { id: string; status: 'held' | 'broken'; note?: string }[];
```

- 검증(`src/execute/spec-patch-validator.ts:22`): 없는 id면 거절한다. `statement`나 `source` 같은 키가 오면 거절한다. `broken`이 하나라도 있는데 `constraints`와 `acceptanceCriteria`가 둘 다 안 바뀌었으면 거절한다. 가정만 뒤집고 요구사항을 안 고치면 재실행해도 결과가 같다.
- 적용(`src/execute/spec-patch-applier.ts:10-57`): 해당 항목의 `status`를 바꾸고 `fieldsChanged`에 `assumptions`를 더한다. `serializeComparable`(`:82-89`)에는 가정을 넣지 않는다. 유사도는 요구사항 변화량을 재는 값이라, 상태 플래그가 바뀐 것으로 정체 판정이 흔들리면 안 된다.
- `evolve_patch` 응답에 `brokenUnconfirmed: [{ id, statement }]`를 싣는다. 확인 안 된 가정이 깨졌다는 건 사용자 의도를 모른 채 고치고 있다는 뜻이다. 막지는 않고 알리기만 한다. 게이트로 세울지는 열린 질문에 남긴다.

#### MCP 요청과 응답 변경 요약

`ges_interview`:

```ts
// 입력 추가 (src/mcp/schemas.ts:26-63)
assumptions: z.array(z.object({
  statement: z.string().min(1).max(300),
  source: z.enum(['interview-gap', 'default', 'inferred']),
  relatedDimension: z.enum(['goalClarity','constraintClarity','successCriteria','priorityClarity','contextClarity']),
  confidence: z.number().min(0).max(1),
  confirmed: z.boolean(),
  evidence: z.string().max(200).optional(),
})).max(15).optional()
  .describe('complete only: 사용자에게 보여주고 확인받은 남은 가정. 고친 항목은 넣지 말고 respond로 먼저 기록한다'),
```

```json
// respond / score, isReady일 때
"completionContext": {
  "assumptionsPrompt": "...",
  "message": "complete 전에 assumptionsPrompt로 남은 가정을 만들고 사용자에게 한 번 확인받으세요."
}

// complete
{
  "status": "completed",
  "assumptionsRecorded": true,
  "assumptions": [{ "id": "A1", "statement": "...", "source": "interview-gap",
                    "relatedDimension": "priorityClarity", "confidence": 0.4, "confirmed": true }],
  ...기존 필드
}
```

`ges_generate_spec`: 입력 `spec`(`src/mcp/schemas.ts:92-104`)에 `assumptions`와 `codeContext`를 선택 필드로 더한다. 응답에 `assumptionSummary`, `droppedCodeContext`를 더한다.

`ges_execute`: 입력 `spec`(`src/mcp/schemas.ts:178-197`)에 두 필드를 선택으로 더하고 `specPatch`(`:342-370`)에 `assumptions`를 더한다. `spec` 쪽은 빠뜨리면 안 된다. `z.object`는 모르는 키를 조용히 버린다. 그래서 Spec에만 필드를 넣고 여기를 안 고치면 `start` 시점에 가정이 사라지고 Evolve는 빈 목록을 본다.

#### 가정 프롬프트

`src/llm/prompts.ts`에 `buildAssumptionsPrompt(topic, rounds, dimensions, codeContext?)`를 둔다.

```text
The interview for "<topic>" reached the resolution threshold. List what the spec
will have to assume because the user never settled it.

Dimension clarity (lower = more likely to hide assumptions):
- priorityClarity 0.62: <improvementHint>
- ...

Rules
1. One sentence per assumption, stated as the choice that will be made ("X는 Y로 둔다").
2. source:
   - interview-gap: asked or relevant to a weak dimension, but the answer left it open
   - default: nobody mentioned it; you are filling a convention
   - inferred: follows from an answer, but the user did not say it
3. Do not restate anything the user explicitly decided. Those are requirements, not assumptions.
4. Prefer dimensions below 0.8. At most 8 items. Fewer is fine.
5. confidence = how likely the user agrees if asked. Be honest; low is useful.
6. evidence: round number (R3) or code path when there is one.

Respond with ONLY: {"assumptions": [{statement, source, relatedDimension, confidence, evidence}]}
```

`confirmed`는 프롬프트가 만들지 않는다. 확인 단계를 거친 뒤 호스트가 채운다.

## 바꿀 파일

| 파일                                                                     | 바꾸는 것                                                                                                                      | 파트 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `src/core/types.ts`                                                      | `Assumption`, `SpecCodeContext`, `CodeContextModule` 재수출. `InterviewSession`, `Spec`, `SpecPatch`에 선택 필드               | 1, 2 |
| `src/spec/schema.ts`                                                     | `assumptionSchema`, `specCodeContextSchema`. `specSchema`에 `.optional()`로 추가                                               | 1, 2 |
| `src/mcp/schemas.ts`                                                     | interview `assumptions`, `resolutionScore.contextEvidence`. spec과 execute의 `spec`에 두 필드. `specPatch.assumptions`         | 1, 2 |
| `src/interview/code-context.ts` (새 파일)                                | provider, 그래프 루트 찾기, KB 요약 맵 캐시, 블록 포매터, 병합 규칙                                                            | 1    |
| `src/code-graph/index.ts`                                                | `rankPointers`, `tokenizePrompt`, `evidenceLabel` 재수출                                                                       | 1    |
| `src/interview/brownfield.ts`                                            | `hasCodeGraph`와 `graphRoot` 반환. 그래프가 있으면 brownfield                                                                  | 1    |
| `src/interview/passthrough-engine.ts`                                    | provider 주입, start와 respond에서 조회, `buildGestaltContext` 인자, `isReady` 시 `completionContext`, `complete(assumptions)` | 1, 2 |
| `src/interview/session.ts`                                               | `create`에 `repoRoot`, `recordCodeContext`, `complete`에 `assumptions`                                                         | 1, 2 |
| `src/interview/repository.ts`                                            | 새 이벤트와 완료 페이로드 replay                                                                                               | 1, 2 |
| `src/events/types.ts`                                                    | `INTERVIEW_CODE_CONTEXT_FOUND`                                                                                                 | 1    |
| `src/llm/prompts.ts`                                                     | `buildQuestionPrompt`, `buildResolutionPrompt`, `buildSpecPrompt` 선택 인자. `buildAssumptionsPrompt`                          | 1, 2 |
| `src/mcp/tools/interview-passthrough.ts`                                 | `codeContext`, `scoreWarnings`, `completionContext`, complete 응답 필드                                                        | 1, 2 |
| `src/mcp/server.ts` 또는 엔진 생성부                                     | `PassthroughEngine`에 기본 provider 연결                                                                                       | 1    |
| `src/spec/passthrough-generator.ts`                                      | 가정 병합, codeContext 경로 대조, 두 필드 저장                                                                                 | 1, 2 |
| `src/mcp/tools/spec-passthrough.ts`                                      | `assumptionSummary`, `droppedCodeContext`                                                                                      | 1, 2 |
| `src/execute/prompts.ts`                                                 | Evolve 시스템 프롬프트 한 줄, "Assumptions to check first" 절                                                                  | 2    |
| `src/execute/orchestrators/types.ts`, `evolution.ts`                     | `ContextualEvolveContext.assumptions`                                                                                          | 2    |
| `src/execute/spec-patch-validator.ts`, `spec-patch-applier.ts`           | 가정 상태 패치                                                                                                                 | 2    |
| `src/mcp/tools/execute/evolve.ts`                                        | hint 문구, `brokenUnconfirmed`                                                                                                 | 2    |
| `plugin/skills/interview/SKILL.md`, `spec/SKILL.md`, `solve/SKILL.md`    | 가정 확인 단계, 관련 코드 질문 꼴, 응답 필드 표                                                                                | 1, 2 |
| `docs/01-interview.md`, `02-spec.md`, `05-evolve.md`, `mcp-reference.md` | 흐름과 스키마                                                                                                                  | 1, 2 |

일반 모드 엔진(`src/interview/engine.ts`, `src/spec/generator.ts`)은 이번에 안 바꾼다. MCP는 API 키가 없으면 Passthrough로 돌고 Execute는 항상 Passthrough다(CLAUDE.md "설계 전제"). 프롬프트 빌더의 새 인자는 모두 선택이라 일반 모드는 지금 출력을 그대로 낸다.

## 하위 호환

- **옛 세션**: `INTERVIEW_SESSION_STARTED`에 `repoRoot`가 없으면 `no-repo-root`로 보고 조회를 건너뛴다. 응답에 `codeContext`를 싣지 않는다. 새 이벤트가 없는 세션은 replay 결과가 지금과 같다.
- **옛 Spec**: 두 필드가 모두 선택이라 `specSchema`를 그대로 통과한다. `metadata` 변환(`src/spec/schema.ts:27-42`)도 안 건드린다. `version`은 `1.0.0`으로 둔다.
- **옛 스킬, 새 서버**: `complete`를 `assumptions` 없이 부르면 지금처럼 끝나고 Spec Call 1이 가정을 만든다. `questionPrompt` 안의 관련 코드 블록은 스킬을 안 고쳐도 질문에 반영된다. 새 응답 필드는 무시해도 흐름이 안 깨진다. 스킬들이 `content[0]`을 파싱하는 구조(src/mcp/CLAUDE.md)도 그대로다.
- **새 스킬, 옛 서버**: `assumptions` 입력과 `contextEvidence`는 옛 서버의 Zod가 조용히 버린다. 스킬은 `complete` 응답에 `assumptionsRecorded`가 없으면 옛 서버로 보고 확인한 목록을 사용자에게 보여준 데서 멈춘다. 버전 알림이 함께 뜨므로 업데이트 안내는 그쪽에 맡긴다.
- **execute 입력 스키마**: 위에 적은 대로 `src/mcp/schemas.ts:178-197`을 같은 PR에서 고친다. 안 고치면 오류 없이 필드가 사라진다. 그래서 회귀 테스트를 따로 둔다.
- **그래프 판정 변화**: 마커 1개 이하인데 그래프가 있는 디렉토리는 이제 brownfield다. 가중치가 바뀌어 `contextClarity` 0.2가 생긴다. 응답의 `detectedFiles`에 `.gestalt/code-graph.db`를 더해 이유를 보이게 한다.
- **훅 동작**: 훅 코드는 재수출만 더하고 로직은 안 바꾼다. `scripts/eval-hook-korean.ts` 결과가 그대로여야 한다.

## 테스트

| 파일                                                                             | 확인할 것                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/interview/code-context.test.ts` (새 파일)                            | 그래프 없음이면 `no-graph`. 한국어 두 어절이 KB 요약에서 맞으면 `kb-summary` 후보가 생긴다. 한 어절만 맞으면 안 생긴다. 통째 식별자는 문턱 예외로 걸린다. 200ms 예산을 넘기면 부분 결과를 낸다. 병합할 때 path가 겹치면 점수가 높은 쪽이 남고 `firstSeenRound`는 유지된다. 상한 8개를 지킨다. 블록이 1200자를 넘지 않는다 |
| `tests/unit/interview/passthrough-engine.test.ts`                                | 가짜 provider로 `questionPrompt`에 상태별 블록이 들어간다. 그린필드는 블록이 없다. 질문 텍스트는 질의에 안 들어간다. 2라운드 뒤 후보 0개면 앵커 지시가 한 번만 붙는다. `isReady`일 때 `completionContext`가 실린다. `contextEvidence` 경고 세 경우                                                                        |
| `tests/unit/interview/repository.test.ts`                                        | `repoRoot`, 코드 맥락 이벤트, 완료 페이로드의 가정 replay. 옛 이벤트열은 결과가 같다                                                                                                                                                                                                                                      |
| `tests/brownfield.test.ts`                                                       | 그래프가 있으면 마커 수와 무관하게 brownfield. cwd가 하위 디렉토리일 때 git 최상위까지 올라가 찾는다                                                                                                                                                                                                                      |
| `tests/unit/spec/passthrough-generator.test.ts`                                  | 세션 가정을 LLM이 빠뜨려도 다시 붙는다. 중복 정규화. 새 항목은 `confirmed: false`. 상한 15개. codeContext 경로 대조와 `droppedCodeContext`. 두 필드가 없는 옛 입력도 통과한다                                                                                                                                             |
| `tests/unit/execute/spec-patch*.test.ts` (기존 validator, applier 테스트에 추가) | 없는 id 거절. statement 수정 거절. `broken`만 있고 요구사항이 안 바뀌면 거절. 적용 뒤 유사도가 가정 변화에 안 흔들린다                                                                                                                                                                                                    |
| `tests/unit/mcp/` 스키마 테스트                                                  | execute `spec`에 `assumptions`를 넣어 `start`한 뒤 세션 Spec에 남아 있는지 (strip 회귀)                                                                                                                                                                                                                                   |
| `tests/integration/interview-to-spec.test.ts`                                    | 브라운필드 픽스처 레포에 작은 그래프와 KB 요약을 두고 start부터 respond, complete(가정 포함), spec까지 한 번에 돈다                                                                                                                                                                                                       |
| `tests/unit/code-graph/hooks.test.ts`                                            | 기존 기대값이 그대로다 (재수출만 했는지)                                                                                                                                                                                                                                                                                  |

효과는 따로 잰다. `benchmarks/`의 golden set 중 브라운필드 과제를 골라 그래프 있음과 없음으로 인터뷰를 돌린다. 비교할 값은 셋이다. 질문에 실제 파일 경로가 나온 라운드 비율, `contextClarity` 점수 분산, 생성 Spec의 `codeContext` 경로가 실제 수정 파일과 겹친 비율이다.

## PR 나누기

1. **Spec 스키마 확장**: 타입, `specSchema`, MCP 세 자리(spec 입력, execute `spec`, `specPatch`)의 선택 필드와 strip 회귀 테스트. 동작 변화는 없다. 나머지 PR이 모두 이걸 깔고 선다.
2. **인터뷰 끝 가정 목록**: `buildAssumptionsPrompt`, `completionContext`, `complete(assumptions)`, 이벤트 replay, Spec 병합, 인터뷰와 spec 스킬, 문서. 1 다음에 한다.
3. **Evolve가 가정부터 보기**: 프롬프트 절, `ContextualEvolveContext.assumptions`, 패치 검증과 적용, `brokenUnconfirmed`, 05-evolve 문서. 2 다음에 한다.
4. **관련 코드 조회와 질문 주입**: `code-context.ts`, 재수출, 그래프 판정, `repoRoot` 저장, 새 이벤트, `questionPrompt` 블록, 앵커 질문, `codeContext` 응답 필드. 1과 독립이라 2와 나란히 갈 수 있다.
5. **채점 근거와 Spec 이월**: `scoringPrompt` 근거 블록과 루브릭, `contextEvidence`와 `scoreWarnings`, Spec `codeContext` 경로 대조. 1과 4 다음에 한다.

#3과 #5는 서로 독립이다. #51이 먼저 들어오면 4의 KB 요약 맵은 빼고 시작한다.

## 열린 질문

- **`contextClarity` 서버 상한**: 근거가 없는데 0.8 이상인 경우를 지금은 경고만 한다. 브라운필드에서 그래프가 있는데 `contextEvidence`가 비면 서버가 0.7로 깎을지 정해야 한다. 깎으면 0.8 관문의 뜻이 강해지지만 "점수 정직성은 호스트 몫"이라는 지금 원칙과 부딪힌다. 경고를 한동안 모아 비율을 보고 정한다.
- **호스트에게 직접 찾게 할지**: Passthrough 호스트는 Grep과 `ges_code_graph`를 쓸 수 있다. `none-matched`일 때 "질문 전에 직접 찾아봐도 된다"고 지시하면 회수율은 오른다. 대신 라운드마다 도구 호출과 토큰이 늘고 인터뷰어가 조사자로 바뀐다. 지금 설계는 앵커 질문으로 사용자에게 묻는 쪽을 골랐다.
- **훅과 중복 상태 공유**: 훅의 세션 상태 파일과 인터뷰 누적 목록이 따로라 같은 파일이 두 번 보일 수 있다. Claude 세션 id를 인터뷰가 알 방법이 없어서 이번에는 엮지 않았다.
- **메모리 맥락 유실**: 메모리는 `start`의 `systemPrompt`에만 붙고 `respond`부터 빠진다(`src/interview/passthrough-engine.ts:103-105`, `:312-316`). 호스트가 첫 시스템 프롬프트를 계속 들고 있으면 문제가 없지만 압축 뒤에는 사라질 수 있다. 이번 범위 밖이지만 같은 자리를 만지므로 따로 이슈로 연다.
- **Execute에서의 `codeContext`**: `extend`, `replace`로 정한 경로를 계획 프롬프트와 `suggestedFiles` 시드에 쓸지. 쓰면 인터뷰 근거가 실행까지 이어지고 안 쓰면 Spec의 기록으로만 남는다.
- **깨진 미확인 가정에서 게이트를 세울지**: 지금은 `brokenUnconfirmed`로 알리기만 한다. 사람 판단 게이트(`awaiting_human`)를 바로 열면 사용자 의도를 모른 채 패치하는 일을 막는다. 대신 Evolve 루프가 자주 멈춘다.
- **Lateral 페르소나에 가정 넘기기**: Reification("암묵적으로 빠진 조각을 명시적으로 채운다")은 가정 목록과 맞닿아 있다. Flow C 프롬프트에도 넣을지는 3번 PR 결과를 보고 정한다.
- **KB 요약 맵 비용**: 파일 수천 개 레포에서 md를 처음 다 읽는 비용을 아직 재지 않았다. 4번 PR에서 모노레포로 재고 크면 #51을 먼저 끝낸다.
