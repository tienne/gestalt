# Configuration Reference

## 우선순위

설정값은 다음 순서로 병합된다 (위로 갈수록 높은 우선순위).

1. `loadConfig(overrides)` — 코드에서 직접 전달
2. Shell 환경변수 (`export GESTALT_*`)
3. `.env` 파일 (dotenv)
4. `gestalt.json` 파일
5. 기본값

리뷰 기본값을 정하는 사용자 프로필은 이 병합에 안 들어간다. 따로 읽는다 → [사용자 프로필](#사용자-프로필-gestaltprofilejson)

---

## `gestalt.json`

`gestalt init` 명령으로 생성된다. JSON Schema로 IDE 자동완성을 지원한다.

```json
{
  "$schema": "./node_modules/@tienne/gestalt/schemas/gestalt.schema.json",
  "llm": { "apiKey": "", "model": "claude-sonnet-5" },
  "interview": { "resolutionThreshold": 0.8, "maxRounds": 10, "rescore": "record" },
  "execute": { "driftThreshold": 0.6, "successThreshold": 0.85, "goalAlignmentThreshold": 0.80 },
  "reasoningModel": "fable",
  "reasoningModelFallback": "opus",
  "tierModels": { "frugal": "haiku", "standard": "sonnet", "frontier": "opus" },
  "relatedRepos": ["acme/widget-kit"],
  "codeGraph": { "hooks": { "enabled": false } },
  "webFetchCache": { "enabled": false },
  "conductor": { "maxConcurrentWorkers": 10, "defaultScope": "approval" },
  "dbPath": ".gestalt/gestalt.db",
  "logLevel": "info"
}
```

---

## `GestaltConfig` 타입

```typescript
interface GestaltConfig {
  llm: { apiKey: string; model: string };
  interview: { resolutionThreshold: number; maxRounds: number; rescore: 'off' | 'record' | 'gate' };
  execute: { driftThreshold: number; successThreshold: number; goalAlignmentThreshold: number };
  reasoningModel: string;
  reasoningModelFallback: string;
  tierModels: {
    frugal: string;
    standard: string;
    frontier: string;
  };
  relatedRepos: string[]; // 'owner/name' 형식, 최대 64개, 기본 []
  ruleSources: Array<{
    id: string;
    kind: 'mcp' | 'file' | 'skill';
    ref: string;
    scope: string[];
    trust: 'convention' | 'delegate';
    onMissing: 'skip' | 'warn' | 'stop';
  }>;
  /** 게슈탈트가 채운다. 비어 있지 않으면 ruleSources 선언이 깨진 것이다 */
  ruleSourceErrors: string[];
  ruleSourceWarnings: string[];
  notifications: boolean;
  codeGraph: {
    hooks: { enabled: boolean }; // Claude Code 훅 자동 주입, 기본 false
  };
  webFetchCache: { enabled: boolean }; // WebFetch 디스크 캐시 훅, 기본 false
  conductor: {
    maxConcurrentWorkers: number; // 동시 워커 상한, 기본 10
    pollIntervalSec: number; // 진행 감시 주기, 기본 60
    maxResumeAttempts: number; // 체크포인트 재개 횟수 상한, 기본 3
    staleAfterSec: number; // 소식이 이만큼(초) 없으면 끊긴 워커로 본다, 기본 1800
    defaultScope: 'merge-through' | 'approval' | 'interview-first'; // 기본 approval
    resultMaxChars: number; // 워커 결과 요약 글자 수 상한, 기본 2000
    stateDir?: string; // 실행 상태 저장소, 기본 ~/.gestalt/conductor
    accounts: Record<string, string>; // 레포별 인증 계정
    repoPaths: Record<string, string>; // 레포별 로컬 경로
    defaultAgent: string; // 기본 오르카 워커 에이전트 (claude)
    repoAgents: Record<string, string>; // 레포별 오르카 워커 에이전트
  };
  dbPath: string;
  skillsDir: string;
  agentsDir: string;
  roleAgentsDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  client: 'claude-code' | 'codex' | 'both' | 'grok';
  hostClient?: 'claude-code' | 'codex' | 'grok'; // 서버가 채우는 모델 기본값용 호스트
}
```

---

## 환경변수 레퍼런스

| 변수명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `ANTHROPIC_API_KEY` | string | `""` | Anthropic API 키. 없으면 Interview/Spec에서 Passthrough 모드로 동작. `client`가 `"claude-code"`, `"codex"`, `"grok"`이면 API 키가 있어도 Interview/Spec은 Passthrough. `"both"`는 강제하지 않는다. Execute는 항상 Passthrough. |
| `GESTALT_MODEL` | string | `"claude-sonnet-5"` | 기본 LLM 모델 이름 (`llm.model` 매핑) |
| `GESTALT_RESOLUTION_THRESHOLD` | number (0–1) | `0.8` | 인터뷰 완료 기준 해상도 점수. 이 값 이상이면 인터뷰를 충분히 완료된 것으로 판단 |
| `GESTALT_MAX_ROUNDS` | number (int) | `10` | 인터뷰 최대 라운드 수 |
| `GESTALT_DRIFT_THRESHOLD` | number (0–1) | `0.6` | Execute 평가 시 드리프트 허용 임계값. 초과 시 Evolve 루프 진입 |
| `GESTALT_EVOLVE_SUCCESS_THRESHOLD` | number (0–1) | `0.85` | Evolve 성공 판정 기준 점수 |
| `GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD` | number (0–1) | `0.80` | 목표 정렬도 최소 임계값. 미달 시 재실행 트리거 |
| `GESTALT_REASONING_MODEL` | `"fable"` \| `"opus"` \| `"sonnet"` \| `"haiku"` | `"fable"` | 스펙 생성과 실행 플래닝의 깊은 추론에 쓸 Agent 서브에이전트 모델. Interview는 대상이 아님 |
| `GESTALT_REASONING_MODEL_FALLBACK` | `"fable"` \| `"opus"` \| `"sonnet"` \| `"haiku"` | `"opus"` | 위 모델을 Agent 도구가 지원하지 않을 때 쓸 폴백 모델 |
| `GESTALT_NOTIFICATIONS` | boolean | `false` | 완료/실패 시 OS 알림 전송 여부 (`"true"` 문자열로 설정) |
| `GESTALT_CODE_GRAPH_HOOKS` | `"1"` \| `"true"` \| `"0"` \| `"false"` | — | Claude Code 플러그인 훅의 코드 그래프 자동 주입을 켜고 끈다. `0`/`false`는 `gestalt.json` 설정보다 우선해서 끈다. 동작은 [Claude Code 훅 (자동 주입)](./code-graph.md#claude-code-훅-자동-주입) |
| `GESTALT_WEBFETCH_CACHE` | `"1"` \| `"true"` \| `"0"` \| `"false"` | — | WebFetch 디스크 캐시 훅을 켜고 끈다. `0`/`false`는 `gestalt.json` 설정보다 우선해서 끈다. 동작은 [WebFetch 디스크 캐시](./webfetch-cache.md) |
| `GESTALT_CONDUCTOR_MAX_WORKERS` | number | `10` | 컨덕터의 동시 워커 상한. 동작은 [컨덕터](./conductor.md) |
| `GESTALT_DB_PATH` | string | `"~/.gestalt/events.db"` | SQLite 이벤트 스토어 파일 경로 |
| `GESTALT_SKILLS_DIR` | string | `"skills"` | 스킬 SKILL.md 파일들이 위치한 디렉터리 |
| `GESTALT_AGENTS_DIR` | string | `"agents"` | 커스텀 에이전트 정의 디렉터리 |
| `GESTALT_ROLE_AGENTS_DIR` | string | `"role-agents"` | Role Agent 정의 디렉터리 |
| `GESTALT_REVIEW_AGENTS_DIR` | string | `"review-agents"` | Review Agent 정의 디렉터리 |
| `GESTALT_RESEARCH_SOURCES_DIR` | string | `"plugin/research-sources"` | 리서치 내장 출처(SOURCE.md) 디렉터리. 개인 출처는 `~/.gestalt/research-sources/`에서 따로 읽고 같은 이름이면 개인 쪽이 이긴다 |
| `GESTALT_LOG_LEVEL` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | 로그 출력 레벨 |
| `GESTALT_CLIENT` | `"claude-code"` \| `"codex"` \| `"both"` \| `"grok"` | `"claude-code"` | 액티브 세션 컨텍스트를 쓰는 호스트. `grok`는 `.grok/rules/gestalt-active.md`만 쓰고 Interview/Spec passthrough를 강제한다. `"both"`는 Claude와 Codex만 쓰며 Grok 경로는 쓰지 않는다 |
| `GESTALT_NO_UPDATE_CHECK` | `"1"` | — | `"1"` 로 설정하면 버전 업데이트 확인을 건너뜀 |
| `GESTALT_DIGEST_EXTERNAL_FONTS` | `"0"` \| `"false"` | — | 영상 요약과 읽기 렌즈 뷰어가 손글씨 제목 글꼴(Nanum Pen Script)을 구글 폰트에서 받는 링크를 싣지 않는다. 끄면 제목이 명조로 보이고 요약을 열 때 밖으로 나가는 요청이 없다. 이미 만든 `digest.html`에는 링크가 남아 있으니 끈 뒤 다시 렌더한다 |
| `GESTALT_LENS_MODELS` | string (절대 경로) | — | 팟캐스트 화자를 가르는 모델(sherpa-onnx)을 둘 폴더. 없으면 `~/.local/share/gestalt/lens-models`를 쓴다. 모델이 없으면 처음 쓸 때 받고 sha256을 확인한다 |
| `GESTALT_LENS_PYTHON` | string (절대 경로) | — | 읽기 렌즈 추출(pdfplumber, trafilatura, faster-whisper)에 쓸 파이썬. 없으면 `~/.local/share/gestalt/lens-venv/bin/python`, 그것도 없으면 `python3`. 상대 경로는 거절한다. 동작은 [읽기 렌즈](#읽기-렌즈-lens) |

잘못된 설정값은 경고를 출력하고 기본값으로 fallback한다 (에러를 throw하지 않음).

### Config 경로 매핑 (빠른 참조)

| 환경변수 | Config 경로 |
|----------|-------------|
| `ANTHROPIC_API_KEY` | `llm.apiKey` |
| `GESTALT_MODEL` | `llm.model` |
| `GESTALT_RESOLUTION_THRESHOLD` | `interview.resolutionThreshold` |
| `GESTALT_MAX_ROUNDS` | `interview.maxRounds` |
| `GESTALT_DRIFT_THRESHOLD` | `execute.driftThreshold` |
| `GESTALT_EVOLVE_SUCCESS_THRESHOLD` | `execute.successThreshold` |
| `GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD` | `execute.goalAlignmentThreshold` |
| `GESTALT_REASONING_MODEL` | `reasoningModel` |
| `GESTALT_REASONING_MODEL_FALLBACK` | `reasoningModelFallback` |
| `GESTALT_TIER_MODEL_FRUGAL` | `tierModels.frugal` |
| `GESTALT_TIER_MODEL_STANDARD` | `tierModels.standard` |
| `GESTALT_TIER_MODEL_FRONTIER` | `tierModels.frontier` |
| `GESTALT_NOTIFICATIONS` | `notifications` |
| `GESTALT_CODE_GRAPH_HOOKS` | `codeGraph.hooks.enabled` |
| `GESTALT_WEBFETCH_CACHE` | `webFetchCache.enabled` |
| `GESTALT_CONDUCTOR_MAX_WORKERS` | `conductor.maxConcurrentWorkers` |
| `GESTALT_DB_PATH` | `dbPath` |
| `GESTALT_SKILLS_DIR` | `skillsDir` |
| `GESTALT_AGENTS_DIR` | `agentsDir` |
| `GESTALT_ROLE_AGENTS_DIR` | `roleAgentsDir` |
| `GESTALT_REVIEW_AGENTS_DIR` | `reviewAgentsDir` |
| `GESTALT_RESEARCH_SOURCES_DIR` | `researchSourcesDir` |
| `GESTALT_LOG_LEVEL` | `logLevel` |
| `GESTALT_CLIENT` | `client` |

---

## 다시 채점하기 (`interview.rescore`)

인터뷰 점수가 `resolutionThreshold`를 넘으면 그 채점을 한 번 더 받는다. `record`는 처음 넘을 때 한 번만 요청하고 `gate`는 받을 때까지 넘을 때마다 요청한다. 같은 대화를 다시 물었을 때 점수가 얼마나 바뀌는지 남기려는 것이다. 환경변수는 없고 `gestalt.json`에서만 정한다.

| 값 | 동작 |
|---|---|
| `off` | 다시 채점하지 않는다 |
| `record` (기본) | 다시 채점해서 기록만 한다. `isReady`는 다시 채점 직전 점수 그대로 둔다 |
| `gate` | 다시 채점을 받기 전까지 `isReady`를 `false`로 둔다. 받은 뒤에는 두 overall 중 낮은 쪽으로 정하고 차원 하나라도 0.2보다 크게 흔들렸으면 `false`로 둔다. 다시 채점은 인터뷰마다 한 번이라 보류된 뒤 다시 기준값을 넘은 채점은 기본 규칙(overall ≥ 기준값)으로 정한다. `rescoreMode`가 `same-context`여도 같은 규칙으로 정하고 이걸 그대로 둘지는 [제안서 열린 질문 6](./proposals/resolution-calibration.md#열린-질문)에서 정한다 |

흐름과 응답 필드는 [`mcp-reference.md`](./mcp-reference.md#다시-채점하기)에 있다.

---

## Reasoning Model (`reasoningModel` / `reasoningModelFallback`)

게슈탈트는 Passthrough 모드라 인터뷰→스펙→실행 플래닝의 추론을 호스트 세션 모델이 수행한다. 이 중 상위 추론 모델이 진짜 값을 하는 곳은 leaf 실행 태스크가 아니라 **스펙 생성과 실행 플래닝(스펙→태스크 DAG 분해)의 깊은 one-shot 추론**이다. 그래서 spec 스킬과 execute 스킬의 Phase 1 플래닝은 `reasoningModel`(기본 `fable`)을 Agent 서브에이전트 `model` 파라미터로 스폰한다.

- **적용 대상**: 스펙 생성(spec 스킬), 실행 플래닝(execute 스킬 `plan_step` / `plan_complete`).
- **비대상**: 인터뷰(Phase 1 Q&A는 대화형이라 제외), execute Phase 2 실행 태스크(기존 태스크별 `model` 힌트를 각 호스트의 `tierModels`로 해석).
- **값**: 호스트가 받는 모델 ID, Claude 별칭 또는 `inherit`. 영문/숫자로 시작하는 최대 128자 토큰이며 `. _ : / @ + -`를 포함할 수 있다. 서버는 모델 가용성을 검사하지 않는다.
- **Codex 기본값**: `reasoningModel`, `reasoningModelFallback`, `tierModels`의 세 tier 모두 `inherit`. 스킬은 모델 인자를 생략해 현재 세션 모델을 상속한다. 명시적으로 지정한 모델은 이 기본값보다 우선한다.
- **Claude 기본값**: reasoning은 `fable`, fallback은 `opus`, tier는 `haiku`/`sonnet`/`opus`를 유지한다.

`ges_status`는 sessionId 없이 호출해도 resolve된 `reasoningModel` / `reasoningModelFallback`을 노출한다. 스킬은 `gestalt.json`을 직접 파싱하지 않고 이 값을 읽는다.

### MCP 호스트와 초기 설정

MCP 초기화의 `clientInfo.name`이 알려진 Codex/Grok 이름이면 해당 호스트를 기본 `client`로 사용한다. `gestalt.json`, `GESTALT_CLIENT`, 코드 override에 적은 `client`가 감지값보다 우선하고, 실행 요청의 `client`는 그 요청에만 우선한다. 호스트 이름을 인식하지 못했거나 CLI로 실행했을 때는 명시한 `client`가 `codex`나 `grok`이면 해당 모델 기본값을 사용한다. 그 밖에는 Claude 기본값을 사용한다.

`ges_status`의 `client`는 컨텍스트 파일을 기록할 대상이고 `hostClient`는 모델 기본값을 선택한 호스트다. 예를 들어 Codex에서 `client: "both"` 프로젝트를 열면 두 파일 기록은 유지하면서 모델 기본값은 Codex의 `inherit`를 쓴다. 알 수 없는 호스트는 Claude 호환 기본값을 사용한다.

`ges_status.clientDetection`은 MCP initialize 때 받은 클라이언트 이름과
`nameTruncated`, `detectedHost`, `warning`을 보여 준다. 표시하는 이름은 유니코드
코드포인트 128개까지다. 제어 문자와 보이지 않는 서식 글자는 공백으로 바꾼다.
상한을 넘으면 `nameTruncated: true`로 알린다. 감지는 원문 이름으로 한다.
`hostClient`는 설정에서 복구된 기본값일 수도 있으므로 자동 감지 성공 여부는
`clientDetection.detectedHost`로 확인한다. 이름이 없을 때와 인식하지 못했을 때는
각각 다른 경고를 표시한다. 명시한 `client` 설정은 유지한다.
MCP `initialized` 알림을 받기 전에 상태를 만들면 `clientDetection`은 `null`이다.
클라이언트 이름이 없으면 `name: null`과 `warning`을 담은 객체를 보여 준다.
CLI `gestalt status`는 이 진단 필드를 출력하지 않는다.
Codex CLI 0.166.0이 initialize 때 보낸 이름 `codex-mcp-client`는 fixture로 검증한다.
Desktop/IDE의 이름은 캡처하지 않았다.

`ges_status.modelWarnings`는 문서의 모델 별칭(`inherit`, `fable`, `haiku`,
`sonnet`, `opus`)과 비슷한 값을 찾아 필드 경로와 함께 알려 준다.
한 글자가 빠지거나 더해지거나 다른 글자로 바뀐 값, 이웃한 두 글자가 서로 바뀐
값이 대상이다. 예를 들어 `opuss`를 찾으면 `opus`를 제안한다.
사용자 별칭일 수 있어 모델 값은 유지한다. 영문 알파벳으로만 된 별칭을 검사한다.
숫자나 기호가 섞인 전체 모델 ID는 검사에서 뺀다. 실제 모델 가용성은 호스트가 판단한다.

새 프로젝트는 `gestalt setup --client codex` 또는 `gestalt init --client codex`로 설정할 수 있다. `setup`은 기존 파일을 덮어쓰지 않고 `init`은 기존 확인 절차를 유지한다. client 옵션은 `claude-code`, `codex`, `both`, `grok` 중 하나다.

### 폴백 발동 지점

`reasoningModelFallback`은 폴백 **대상**일 뿐이다. 서버는 모델 가용성을 감지하지 않으며, 폴백을 발동하지도 않는다. 실제 발동은 **스킬 런타임**에서 일어난다. Claude에서 `fable` 스폰이 거부되면 기본 fallback인 `opus`로 한 번 재시도한다. Codex의 기본 fallback은 `inherit`이므로 모델 인자를 생략한다. 호스트가 모델 선택을 지원하지 않으면 해당 도구의 스키마에 맞게 세션 모델을 상속한다.

---

## 코드 그래프 훅 (`codeGraph.hooks`)

`codeGraph.hooks.enabled`를 `true`로 두면 Claude Code 플러그인 훅이 세션에 코드 그래프 컨텍스트를 넣는다. 세션을 열 때 레포 맵, 프롬프트마다 관련 심볼 위치, 파일을 고친 뒤 영향 범위가 들어간다. Claude만 지원한다.

```json
{
  "codeGraph": { "hooks": { "enabled": true } }
}
```

- 기본은 `false`다. 플러그인 훅은 게슈탈트 플러그인이 깔린 모든 레포의 모든 프롬프트에 걸리므로 쓰려는 레포에서만 켠다
- 환경변수 `GESTALT_CODE_GRAPH_HOOKS=1`(또는 `true`)로도 켠다. `0`이나 `false`는 `gestalt.json` 설정보다 우선해서 끈다
- 그래프 DB(`.gestalt/code-graph.db`)가 있어야 동작한다. 훅은 그래프를 새로 만들지 않으니 처음에는 `gestalt init`이나 `ges_code_graph build`로 빌드한다

이벤트별로 넣는 내용과 랭킹, 타임아웃은 [Claude Code 훅 (자동 주입)](./code-graph.md#claude-code-훅-자동-주입)에 있다.

---

## WebFetch 디스크 캐시 (`webFetchCache`)

`webFetchCache.enabled`를 `true`로 두면 Claude Code 플러그인 훅이 WebFetch 결과를 디스크에 저장한다. 같은 요청이 다시 오면 원본 서버가 "바뀌지 않았다(304)"고 답할 때만 저장본을 돌려준다. Claude만 지원한다.

```json
{
  "webFetchCache": { "enabled": true }
}
```

- 기본은 `false`다. 플러그인 훅은 게슈탈트 플러그인이 깔린 모든 레포의 모든 WebFetch에 걸리므로 쓰려는 레포에서만 켠다
- 환경변수 `GESTALT_WEBFETCH_CACHE=1`(또는 `true`)로도 켠다. `0`이나 `false`는 `gestalt.json` 설정보다 우선해서 끈다
- 캐시는 레포 밖 `${XDG_CACHE_HOME:-$HOME/.cache}/gestalt/webfetch-cache/<프로젝트 해시>/`에 쌓인다. `jq`와 `curl`이 없으면 훅은 아무것도 하지 않고 지나간다

저장 규칙과 한계는 [WebFetch 디스크 캐시](./webfetch-cache.md)에 있다.

---

## 컨덕터 (`conductor`)

설정은 두 자리에 나뉜다. 레포의 `gestalt.json`은 클론한 레포가 쓰는 파일이라 감시 주기와 상한 같은 조율 값만 받는다.

```json
{
  "conductor": {
    "maxConcurrentWorkers": 10,
    "pollIntervalSec": 60,
    "maxResumeAttempts": 3,
    "staleAfterSec": 1800,
    "resultMaxChars": 2000
  }
}
```

머지 승인 범위와 워커 에이전트, 상태 저장소, 계정, 레포 경로는 사용자 전역 `~/.gestalt/conductor.json`에만 적는다. `GESTALT_HOME`을 바꿨으면 그 아래 `.gestalt/conductor.json`이다. 이 파일은 `conductor` 블록 없이 칸을 바로 적고 조율 값도 함께 둘 수 있다. 같은 칸이 두 파일에 다 있으면 이 파일이 앞선다.

```json
{
  "defaultScope": "approval",
  "defaultAgent": "claude",
  "repoAgents": { "acme/widget-kit": "codex" },
  "stateDir": "/path/to/conductor-state",
  "accounts": { "acme/widget-kit": "work" },
  "repoPaths": { "acme/widget-kit": "/path/to/widget-kit" }
}
```

레포 `gestalt.json`에 이 칸들을 적으면 버리고 버린 칸 이름을 경고로 알린다. 남이 만든 레포 안에서 컨덕터 세션을 열었다고 머지 승인이 꺼지거나 워커가 남이 정한 경로와 계정으로 뜨면 안 되기 때문이다.

- `maxConcurrentWorkers`를 넘는 주문은 큐에 쌓였다가 자리가 나면 뜬다. 컨덕터가 진행을 볼 때마다 다시 읽으므로 돌고 있는 중에 바꿔도 다음 감시부터 적용된다
- `defaultScope`는 주문에 범위를 안 적었을 때 쓴다. `merge-through`는 머지까지 승인 없이 가고 `approval`은 머지 전에 사람 승인을 받는다. `interview-first`는 인터뷰 답을 사람이 직접 한다
- `defaultAgent`(기본 `claude`)와 `repoAgents`는 오르카 워커의 에이전트를 고른다. 주문의 `--agent`가 있으면 가장 먼저 쓰고 재개는 앞 워커의 에이전트를 유지한다. 빈 문자열과 공백은 받지 않는다. subagent와 git-worktree에서는 무시한다
- `accounts`에 적힌 레포는 워커를 띄우기 전에 그 계정으로 맞춘다. 맞추는 절차가 없으면 사람에게 올린다
- `repoPaths`는 오르카가 없을 때 git 워크트리를 만들 원본 체크아웃 경로다. 오르카가 있으면 레포를 가리키는 데 쓰고 비어 있으면 레포 이름으로 찾는다
- `staleAfterSec`(기본 1800초) 동안 보고도 체크포인트도 없는 워커는 끊긴 것으로 보고 마지막 체크포인트부터 다시 띄운다. 사람 결정을 기다리는 `waiting-gate` 주문의 워커는 이 셈에서 빠진다. CI 대기처럼 15분 넘게 걸릴 수 있는 대기는 워커가 앞뒤로 체크포인트를 남긴다
- `resultMaxChars`를 넘는 결과 요약이나 diff, 스택 트레이스가 섞인 결과는 받지 않고 요약을 다시 달라고 돌려보낸다

동작 전체는 [컨덕터](./conductor.md)에 있다.

---

## 읽기 렌즈 (`lens`)

`/lens` 스킬이 연결 카드 후보를 찾을 내 노트 폴더는 세 군데서 합친다.

1. 사용자 설정 `~/.gestalt/lens.json`. 처음 렌즈를 쓸 때 스킬이 노트 폴더 후보를 찾아 묻고 고른 폴더를 여기 적는다. 레포가 아니라 사용자 설정이라 한 번 연결하면 어느 레포에서든 쓴다. 손으로 고치려면 `gestalt lens notes` 명령을 쓴다
2. 레포의 `gestalt.json` `lens.knowledgeSources`. 팀이 함께 보는 레포 안 문서 폴더처럼 레포에 묶인 자리만 적는다. 레포 안 경로만 받는다. 레포 밖을 가리키면 버리고 경고한다. 남의 레포를 열었을 때 그 레포의 설정이 내 개인 폴더를 읽기 대상으로 정하지 못하게 하려는 것이다. 레포 밖 폴더는 1이나 3으로 연결한다
3. 부를 때 넘긴 폴더(스킬 입력 `knowledge`, `gestalt lens knowledge --source`)

```bash
gestalt lens notes list                 # 연결한 폴더와 노션 사용 여부
gestalt lens notes detect [--scan <dir>]  # 후보 찾기
gestalt lens notes add <폴더>...          # 연결
gestalt lens notes remove <폴더>
gestalt lens notes notion-on|notion-off  # 노션 MCP로도 찾기
gestalt lens notes decline              # 쓰지 않음. 다음부터 묻지 않는다
```

후보 찾기는 Orca 없이 돈다. 이 레포와 옆 레포(상위 폴더), 홈의 흔한 작업 폴더와 문서 폴더(`~/Documents`, `~/Desktop`, `~/Downloads`, `~/notes`, `~/work`, `~/projects`, `~/code`, `~/dev`, `~/src`, `~/repos`, `~/github`, iCloud Obsidian)를 3단까지 훑는다. 이름이 notes, kb, wiki, journal 꼴인 폴더와 Obsidian 보관함(`.obsidian`), Logseq 그래프(`logseq/config.edn`), 노션 내보내기 폴더(`제목 <32자리 id>.md` 파일)를 찾고 노트가 셋 넘게 든 폴더만 낸다. 후보는 10개까지만 보인다. 그보다 많으면 사람용 출력에 "후보 N개 중 10개만 보여요"를 붙이고 `--json`에는 자르기 전 후보 수를 `totalCandidates`로 낸다. Orca가 있으면 스킬이 등록된 레포를 `--scan`으로 더 넘긴다.

노션은 파일이 아니라 노션 MCP가 붙은 세션에서만 찾는다. 스킬이 노션 페이지를 받아 리포트 폴더의 `knowledge-snapshots/`에 스냅샷으로 두고 다른 노트처럼 검사한다. 연결 카드에는 노션 원래 주소가 붙는다.

```json
{
  "lens": { "knowledgeSources": ["docs/notes", "kb"] }
}
```

- 상대 경로는 레포 루트 기준이다. 절대 경로도 레포 안이면 받는다. `../notes`처럼 레포 밖으로 나가는 경로는 버리고 경고한다
- 없는 폴더는 조용히 빠지고 `knowledge.json`의 `roots`에 안 실린다
- 노트 파일 수와 읽는 바이트, 후보 줄(40개), 검색어(30개)에 상한이 있고 1MB를 넘는 노트는 건너뛴다. 상한에 닿거나 큰 노트를 건너뛰면 `knowledge.json`의 `truncated`(`{ files, bytes, hits, terms, large }`)에 어느 쪽인지 적고 `totalHits`에 자르기 전 후보 줄 수를 적는다
- `.md`, `.markdown`, `.txt`만 읽고 숨김 폴더와 `node_modules`는 건너뛴다
- 노트 폴더는 읽기만 한다. 연결 카드의 인용은 그 폴더 안 파일에 글자 그대로 있어야 merge를 통과한다

추출 도구는 파이썬 패키지라 렌즈 전용 가상환경을 권한다. 시스템 파이썬의 pip가 오래돼 새 휠을 못 받는 머신이 있어서다.

```bash
python3 -m venv ~/.local/share/gestalt/lens-venv
~/.local/share/gestalt/lens-venv/bin/python -m pip install --upgrade pip
~/.local/share/gestalt/lens-venv/bin/python -m pip install pdfplumber trafilatura faster-whisper sherpa-onnx
```

팟캐스트 화자 구분은 sherpa-onnx가 내준 두 모델(pyannote segmentation 3.0의 ONNX판, wespeaker ResNet34)을 쓴다. Hugging Face 토큰 없이 GitHub 릴리스에서 받고 `gestalt lens ingest`가 처음 쓸 때 `~/.local/share/gestalt/lens-models`에 받아 둔다. 받은 파일은 코드에 박아 둔 sha256과 맞을 때만 모델 폴더로 옮긴다. 맞지 않으면 그 모델을 쓰지 않고 화자 없이 시각만 출처로 단다.

PDF는 300쪽을 넘으면 읽지 않고 멈춘다. 추출 프로세스에는 타임아웃만 있고 메모리 상한이 없다. 신뢰할 수 없는 PDF는 격리된 환경(컨테이너나 별도 계정)에서 돌린다.

다른 파이썬을 쓰려면 `GESTALT_LENS_PYTHON`에 절대 경로를 준다.

---

## 관련 레포 (`relatedRepos`)

하네스 리뷰(`harness-reviewer`)는 diff 밖에서 깨질 수 있는 다른 레포의 참조를 찾는다. 찾을 레포 목록은 자동 탐지가 기본이다. `relatedRepos`는 자동으로 못 찾은 레포를 손으로 더하는 자리다.

| 항목 | 값 |
|---|---|
| 형식 | `owner/name` 문자열 배열 (예: `acme/widget-kit`) |
| 기본값 | `[]` |
| 상한 | 64개, 항목당 256자 |
| 검증 | `src/core/config.ts`의 Zod 스키마와 `schemas/gestalt.schema.json` |

```json
{
  "relatedRepos": ["acme/widget-kit", "acme/design-kit"]
}
```

자동 탐지는 현재 레포 `origin` 원격의 owner를 조직으로 본다. 하네스 문서에서 `owner/repo` 표기, GitHub URL, `gh repo clone` 대상, 매니페스트의 플러그인 이름(marketplace 레포), MCP 패키지의 `package.json` `repository`를 순방향 언급으로 뽑아 같은 조직 레포만 남긴다. `relatedRepos`에 적은 레포는 이 결과에 합쳐진다.

이 필드는 추가만 받는다. `excludeRepos`, `ignoreRepos`, `skipRepos`, `disableXxx`처럼 제외로 읽히는 키(`exclude*`, `ignore*`, `skip*`, `disable*`, `remove*`, `blacklist*`, `deny*`)는 `loadConfig()`가 경고를 찍고 버린다. 제외가 곧 리뷰를 끄는 스위치가 되기 때문이다. JSON Schema도 `additionalProperties: false`라 IDE에서 먼저 걸린다.

### 탐지 결과 캐시

| 항목 | 값 |
|---|---|
| 위치 | `.gestalt/harness-refs-cache.json` (`DETECTION_CACHE_PATH`) |
| 커밋 | 안 한다. `.gestalt/`가 `.gitignore`에 걸려 있다 |
| 담기는 것 | 관련 레포 목록, 식별자, 하네스 문서 해시, 만료 시각, 현재 레포 이름 |

역방향 검색은 `gh search code`를 쓰고 속도 제한이 걸려 있다. 그래서 탐지를 매 리뷰마다 돌리지 않고 캐시를 쓴다. 다음 셋 중 하나면 다시 탐지한다.

- 하네스 문서 해시가 캐시와 다를 때 (`SKILL.md`, `AGENT.md`, `CLAUDE.md`, 매니페스트 같은 탐지 입력이 바뀐 경우)
- `expiresAt`이 지났을 때 (기본 24시간)
- 캐시에 적힌 현재 레포가 지금 `origin` 원격과 다를 때

`relatedRepos` 설정값은 캐시가 유효해도 매번 새로 합쳐지므로, 설정을 고친 뒤 캐시를 지울 필요는 없다. `origin`이 없거나 GitHub 주소가 아닌 레포는 조직을 정할 수 없어 탐지를 건너뛰고 리뷰는 참조 검사를 비워둘지 사용자에게 묻는다.

---

## 사용자 프로필 (`~/.gestalt/profile.json`)

리뷰를 부를 때마다 붙이던 옵션의 기본값을 사람마다 정해 두는 파일이다. 레포가 아니라 사용자 홈에 하나만 둔다. 어느 레포에서 리뷰를 돌려도 같은 값을 쓴다.

| 항목      | 값                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------- |
| 위치      | `~/.gestalt/profile.json`. `GESTALT_HOME`을 절대 경로로 주면 `$GESTALT_HOME/.gestalt/profile.json` |
| 만드는 법 | 손으로 만든다. 이 파일을 쓰는 명령은 없다                                                          |
| 읽는 곳   | review 스킬 0단계가 `gestalt profile show --json`으로 읽는다                                       |
| 확인      | `gestalt profile show` (사람이 읽는 출력), `--json` (스킬이 파싱하는 출력)                         |

```json
{
  "review": {
    "audience": "junior",
    "postVerdict": true,
    "approveWhenNoBlocking": true
  }
}
```

| 칸                             | 값                 | 비우면  | 하는 일                                                                                 |
| ------------------------------ | ------------------ | ------- | --------------------------------------------------------------------------------------- |
| `review.audience`              | `peer` \| `junior` | `peer`  | 인라인 코멘트를 누구 눈높이로 쓸지                                                      |
| `review.postVerdict`           | `true` \| `false`  | `true`  | GitHub PR에 APPROVE나 REQUEST_CHANGES 이벤트까지 남길지. `false`면 `COMMENT`로 고정한다 |
| `review.approveWhenNoBlocking` | `true` \| `false`  | `false` | 블로킹 이슈가 없으면 warning이 남아 있어도 `APPROVE`로 낼지. 아래 참고                 |

값은 호출 인자, 프로필, 스킬 기본값 순으로 정한다. `--junior`처럼 부를 때 붙인 값이 있으면 프로필보다 앞선다. 칸을 비워 두면 그 칸은 프로필이 없을 때와 똑같이 돈다. 리뷰를 시작할 때 어떤 값이 프로필에서 왔는지 한 줄로 알려 준다.

**로컬 PR에서는 프로필의 `junior`가 `peer`로 내려간다.** 로컬 PR 게시는 코멘트를 주니어 눈높이로 다시 쓰지 않고 합의 이슈를 그대로 옮긴다. `--junior`처럼 부를 때 준 값이면 review 스킬이 그대로 진행할지 묻는다. 프로필에서 온 값이면 묻지 않고 한 줄 알린 뒤 `peer`로 진행한다. ship은 `--audience` 없이 review를 부르므로 프로필에 `junior`를 둬도 ship 라운드마다 멈추지 않는다.

**`gestalt.json`과 섞지 않는다.** 이 파일은 위 [우선순위](#우선순위) 병합에 안 들어가고 `loadConfig()`도 안 읽는다. 레포의 `gestalt.json`이나 레포 안 `.gestalt/profile.json`에 같은 칸을 적어도 무시된다. `approveWhenNoBlocking`은 리뷰어 계정으로 승인을 내보내는 값이라, 리뷰받는 레포가 설정 한 줄로 켤 수 있으면 그 레포가 내 승인을 내게 된다.

**깨진 파일은 경고만 하고 기본값으로 돈다.** JSON이 아니거나 맨 바깥이 객체가 아니면 전부 기본값이다. 모르는 칸은 무시하고 경고한다. 값이 틀린 칸(예: `"audience": "senior"`)은 그 칸만 기본값으로 두고 나머지는 살린다. 파일 자리에 디렉토리가 있거나 권한이 없어 못 읽어도 경고하고 전부 기본값으로 둔다. 파일이 아예 없을 때만 경고 없이 넘어간다. 어느 경우든 `gestalt profile show`는 종료 코드 0으로 경고를 함께 낸다.

**`approveWhenNoBlocking`이 바꾸는 건 warning만 남은 리뷰 하나다.** critical이나 high가 있으면 그대로 `REQUEST_CHANGES`다. 프로필에서 켠 값은 approve를 명시한 것으로 치지 않으므로, 조회 막힘이나 원격 없는 레포, 연관 PR 미확정(`BLOCKING_ISSUES`)이 있거나 참조 검사를 비운 라운드면 `approve-gate`가 `COMMENT`로 내린다. `postVerdict: false`로 부른 리뷰와 본인 PR에는 안 걸린다. 게시하라고 했어도 이 값으로 나온 `APPROVE`는 미리보기 끝에서 승인으로 낼지 한 번 더 묻는다. 게시 의사만으로는 승인을 내지 않는다.

**review-loop는 프로필을 안 읽는다.** `approveWhenNoBlocking`은 열린 스레드가 남으면 승인하지 않는다는 그 스킬의 규칙이 앞서서 안 본다. `audience`는 그 스킬의 기본값 `junior`를 `review`에 넘기므로 프로필의 `audience`보다 앞선다. peer 눈높이로 돌리려면 `/review-loop <PR> --peer`로 부른다.

리뷰의 "맥락 소스"와 "어투"는 프로필 칸이 없다. review 스킬에 그 둘을 받는 입력이 없어서다. 맥락은 0단계 미니 인터뷰로 받고 어투는 `code-review-writer`가 정한다.

---

## 설정 동기화 (`~/.gestalt/agent-sync.json`)

`gestalt sync`와 `gestalt doctor`가 읽는 사용자 설정이다. 계정 이름과 확인할 도구 목록은 공개 레포에 넣을 수 없어서 이 파일에서만 읽는다. 동작은 [규칙과 스킬 동기화](./agent-sync.md)에 있다.

| 항목      | 값                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------- |
| 위치      | `~/.gestalt/agent-sync.json`. `GESTALT_HOME`을 절대 경로로 주면 `$GESTALT_HOME/.gestalt/agent-sync.json` |
| 만드는 법 | 손으로 만든다. 없으면 모든 칸이 비어 있는 것으로 돈다                                                    |
| 깨졌을 때 | JSON이 아니거나 칸 형식이 틀리면 어느 칸인지 알리고 종료 코드 1로 멈춘다. 아무것도 바꾸지 않는다         |

```json
{
  "tools": { "all": ["git"], "claude": ["gh"], "codex": ["rg"] },
  "accounts": {
    "<오르카 계정 id>": { "label": "work" },
    "<다른 계정 id>": { "skip": true }
  },
  "rules": { "claudeOnly": ["[Claude]", "mcp__"] },
  "orcaCommand": "/절대/경로/orca",
  "orcaDataDir": "/절대/경로/orca-data"
}
```

| 칸                  | 비우면                                  | 하는 일                                                                                                   |
| ------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tools.all`         | `[]`                                    | 모든 호스트에 있어야 하는 도구. doctor가 PATH에서 찾고 없으면 경고한다                                    |
| `tools.claude`      | `[]`                                    | Claude 홈에만 더 확인할 도구                                                                              |
| `tools.codex`       | `[]`                                    | Codex 홈에만 더 확인할 도구                                                                               |
| `accounts.<id>`     | 오르카가 알려 준 이름, 없으면 id 앞 8자 | `label`은 출력에 쓸 이름이다. `skip: true`면 그 계정 홈을 대상에서 뺀다                                   |
| `rules.claudeOnly`  | `[]`                                    | 처음 sync가 CLAUDE.md를 나눌 때 Claude 쪽에 남길 줄. 줄에 이 문자열이 들어 있으면 남긴다                  |
| `orcaCommand`       | `ORCA_CLI_COMMAND`, 없으면 `orca`       | 계정 목록을 받을 오르카 명령. 절대 경로나 PATH에서 찾을 이름만 받는다                                     |
| `orcaDataDir`       | Claude 계정 홈에서 거슬러 올라간 폴더   | Codex 계정 홈(`<여기>/codex-accounts/<id>/home`)을 만들 오르카 데이터 폴더. 절대 경로로 적고 `.`, `..`, 끝의 `/`, 겹친 `/`는 넣지 않는다. 설정하면 계정 홈은 이 폴더 아래에 있어야 하고 비우면 사용자 홈 아래만 받는다 |

도구 목록에 없는 도구는 확인하지 않는다. 규칙 본문에서 명령 이름을 뽑아 확인하지도 않는다. 도구 확인은 doctor를 부른 셸의 PATH 하나로 한다.

---

## 레포 밖 규칙 소스 (`ruleSources`)

게슈탈트는 규칙을 자기가 소유하는 전제로 만들어졌다. 어투는 `ai-tell-quick-rules.md`, 주석은 `comment-rules.md`가 원본이고 `verify:rules`가 사본과 갈라졌는지 검사한다.

따라야 할 기준이 밖에 있을 때가 있다. 디자인 토큰은 디자인 시스템 서버가 갖고 있고 조직 코딩 원칙은 다른 레포에 있다. 베껴 오면 기준이 두 벌이 된다. 안 읽으면 기준 없이 만든 결과가 기준을 지킨 결과와 똑같이 생긴다. `ruleSources`는 읽어오되 베끼지 않는 자리다.

```jsonc
{
  "ruleSources": [
    {
      "id": "design-tokens",
      "kind": "mcp",
      "ref": "mcp__plate__get_design_tokens",
      "scope": ["ui", "css"],
      "trust": "convention",
      "onMissing": "warn"
    }
  ]
}
```

| 필드 | 값 | 설명 |
|---|---|---|
| `id` | string (≤64자) | 보고에 쓰는 이름. 레포 안에서 고유해야 한다. 사용자에게 그대로 보이므로 줄이나 표의 칸을 새로 여는 문자는 못 쓴다 |
| `kind` | `mcp` \| `file` \| `skill` | 규칙이 어디 있나 |
| `ref` | string (≤512자) | `kind`별 대상 — MCP 도구 이름, 파일 경로, 스킬 이름 |
| `scope` | string[] (≤16개) | 이 태그가 걸린 작업에서만 읽는다. 비면 항상 읽는다 |
| `trust` | `convention` \| `delegate` | `convention`은 형식을 따른다. `delegate`는 그 작업을 넘긴다 |
| `onMissing` | `skip` \| `warn` \| `stop` | 못 읽었을 때 조용히 진행할지, 보고에 남길지, 멈출지 |

`ref`에는 선이 걸려 있다. `file`은 레포 기준 상대 경로여야 하고 절대 경로와 `..`, 자격 증명이 담기는 자리는 거부한다. `mcp`와 `skill`은 이름 꼴만 받는다. 배열은 32개까지다.

**검사하는 값과 실제로 여는 값을 갈라놓을 수 있는 문자도 거부한다.** 막을 글자를 세지 않고 받을 글자를 적는 쪽이다 — 경로에 들어갈 글자를 적으면 안 보이는 글자도 구분자를 닮은 글자도 함께 빠진다. 저장되는 `ref`는 검사한 값과 같은 꼴(NFC)이다.

**받는 글자와 상한의 원본은 [`rule-sources.md`](../plugin/skills/_shared/rule-sources.md)의 "`ref`에 걸린 선" 절이다** — 여기 옮겨 적으면 한쪽만 고쳐진다.

**상한을 넘으면 잘리는 게 아니라 거부된다.** 자른 `ref`는 스킬이 가진 유일한 `ref`라서, 읽기에 실패한 뒤 `onMissing`을 타고 조용히 지나간다. 거부하면 아래 `ruleSourceErrors`에 드러난다.

**선언한 것만 읽는다.** 붙어 있는 MCP 서버를 훑어 관련 있어 보이는 걸 골라 쓰지 않는다. 무엇을 근거로 삼았는지 불투명해진다. 이름만 비슷한 엉뚱한 걸 물 수 있다. 선언이 없으면 스킬은 이 단계를 통째로 건너뛴다.

`gestalt init`은 이 필드를 만들지 않는다. 기본값이 빈 배열이고 무엇을 기준으로 삼을지는 조직마다 다르기 때문이다. 쓰려면 위 예시처럼 직접 적는다.

**어느 쪽 `trust`든 작업 범위는 못 늘린다.** 읽어온 문서에 "이것도 같이 처리하라"가 적혀 있어도 할 일이 늘지 않는다. 형식은 받고 범위는 안 준다.

`ges_status`는 sessionId 없이 호출해도 resolve된 `ruleSources`를 노출한다. 스킬은 `gestalt.json`을 직접 파싱하지 않고 이 값을 읽는다.

적용 규칙의 원본은 [`plugin/skills/_shared/rule-sources.md`](../plugin/skills/_shared/rule-sources.md)다. 어느 스킬이 언제 읽는지는 [어느 스킬이 언제 규칙 소스를 읽나](./mcp-reference.md#어느-스킬이-언제-규칙-소스를-읽나)에 있다.

### `ruleSourceErrors` (읽기 전용)

사용자가 쓰는 필드가 아니라 게슈탈트가 채운다. `gestalt.json`에 적어도 무시된다.

잘못된 항목만 빠지고 나머지 소스와 다른 설정은 남는다. 그래서 `ruleSources`가 비어 있지 않아도 일부가 빠진 상태일 수 있다. 무엇이 왜 빠졌는지를 이 필드에 싣고 스킬이 멈춘다 — 안 알리면 `stop`으로 걸어둔 검사가 안 돈 채로 지나간다. **원소를 특정할 수 없는 오류는 배열 전체가 빠진다.** `id` 중복, 개수 상한 초과, 배열이 아닌 값이 그렇다. 설정을 통째로 복구하지 못한 경우도 마찬가지인데, 그때는 `ruleSources`가 멀쩡했어도 함께 날아가므로 그 사실이 이 필드에 실린다.

최상위 키 이름을 틀린 경우는 여기가 아니라 아래 `ruleSourceWarnings`로 간다.

오류가 많으면 `ges_status`에는 앞의 20줄만 실린다. 실제 개수는 같은 응답의 `ruleSourceErrorCount`에 있다. 각 줄도 200자에서 잘린다 — 오류 문구에는 대상 레포가 쓴 `id`와 `ref`가 되풀이돼 실리므로 길어질 수 있다.

```jsonc
// ges_status 응답
{
  "ruleSources": [],
  "ruleSourceErrors": [
    "ruleSources.1.kind (id: \"design-tokens\"): Invalid enum value. Expected 'mcp' | 'file' | 'skill', received 'http'"
  ],
  "ruleSourceErrorCount": 1,
  "ruleSourceWarnings": [],
  "ruleSourceWarningCount": 0
}
```

빈 `ruleSources`는 두 가지 뜻이다. 이 필드가 비어 있어야 "선언 안 함"이다. 차 있으면 "선언이 깨짐"이다.

인덱스 옆에 `id`가 붙는 건 응답의 `ruleSources`가 깨진 원소를 뺀 뒤 다시 매겨진 배열이라서다. 인덱스만 세어 가면 멀쩡한 다른 소스를 짚는다. `id`가 없는 원소는 `ref`로, 그것도 없으면 `kind`로 짚는다.

### `ruleSourceWarnings` (읽기 전용)

멈출 사유는 아닌데 짚어줄 것이 온다. 최상위 키 이름이 `ruleSources`를 적으려던 것처럼 보이는 경우가 그렇다. 최상위 스키마는 모르는 키를 조용히 버리는데, 하필 그 키가 `ruleSources`를 적으려던 것이면 결과가 "선언 안 한 레포"와 똑같아진다. `schemas/gestalt.schema.json`의 `additionalProperties: false`는 `$schema`를 건 에디터에서만 걸리고 런타임은 못 잡으므로 이 검사가 따로 있다.

**멈춤 사유와 한 필드에 담지 않는다** — 담으면 탐지기를 한 번 넓힐 때마다 그게 세션을 세우는 레버가 된다. 이름이 비슷하다는 건 정황이지 선언이 깨졌다는 증거가 아니다. 같은 이유로 **값이 선언 꼴일 때만 올린다.**

---

## 멀티 프로바이더 설정 (LLM Tier)

작업 복잡도에 따라 다른 LLM 프로바이더를 라우팅할 수 있다. `frugal`, `standard`, `frontier` 세 가지 tier로 구분한다.

| Tier | 용도 | 예시 모델 | 지금 실제로 쓰이는 자리 |
|------|------|-----------|------------------------|
| `frugal` | 가벼운 작업 — 점수 산정, 분류, 짧은 응답 | `llama3.2`, `claude-haiku-4-5` | 인터뷰 해상도 점수 산정(`ResolutionScorer`, 아래 조건), `ges_generate_kb`의 파일별 한 줄 요약(`summarize: true`일 때만) |
| `standard` | 일반 작업 — 인터뷰, 스펙 생성 | `claude-sonnet-5` | 질문 생성, Spec 생성. tier 미설정 시 flat `llm.apiKey`+`llm.model`로 폴백 |
| `frontier` | 고난도 추론 | `claude-opus-4-20250514`, `o1` | 아직 직접 호출 경로 없음 — 설정만 받아둔다 |

`frugal`은 위 두 자리에서 쓰인다. 정해진 기준에 점수를 매기거나 파일 하나를 한 문장으로 옮겨 적는 작업이라 질문 생성만큼의 모델이 필요 없어서다.

조건이 자리마다 다르다. 해상도 점수 산정은 tier를 설정하면 그쪽으로 내려간다. KB 요약은 tier만으로는 안 켜지고 `ges_generate_kb`를 `summarize: true`로 불러야 돈다. 둘 다 설정이 없으면 점수 산정은 `standard`(또는 flat 설정)를 그대로 쓰고 요약 단계는 통째로 건너뛴다 — 기존 동작과 같다.

**해상도 점수 산정은 서버가 직접 LLM을 부를 때만 이 경로를 탄다.** `client`가 `claude-code`, `codex`, `grok`이거나 API 키가 없으면 인터뷰는 Passthrough로 돈다. 그때는 점수를 호출자(호스트 LLM)가 매기므로 어댑터를 안 거친다. 그래서 이 라우팅이 실제로 사는 자리는 CLI(`gestalt interview`, `gestalt spec`)와 `client: "both"` + API 키 조합이다. KB 요약은 서버가 부르는 쪽이라 이 조건을 안 탄다. 대신 `summarize`를 켜야 돈다.

> **품질 영향은 아직 측정하지 않았다.** 해상도 점수는 인터뷰를 언제 끝낼지 정하는 값(기준값 `interview.resolutionThreshold`, 기본 0.8)이라 모델을 내려서 점수가 흔들리면 라운드 수가 달라진다. `pnpm tsx scripts/verify-frugal-scoring.ts`가 golden-set 20건을 두 tier로 채점해 편차와 기준값 판정이 뒤집힌 건수를 낸다. KB 요약 쪽은 그에 대응하는 검증이 아직 없어서 opt-in으로 둔다. 요약문은 KB 본문과 임베딩에 남는다. 되돌리려면 KB를 다시 만들어야 한다.

> **참고**: Execute Engine은 LLM 호출 방식과 무관하게 **항상 Passthrough 모드**로 동작합니다.
> API 키 유무는 Execute 동작에 영향을 주지 않습니다.
> Execute는 호스트 코딩 에이전트의 도구(Bash, Edit 등)를 활용해 실제 파일 수정과 코드 실행을 수행하므로,
> Claude Code나 Codex 같은 호스트가 LLM 실행 주체가 되는 것이 설계 의도입니다.

### Tier 객체 필드

| 필드 | 타입 | Required | Description |
|------|------|:--------:|-------------|
| `provider` | `"anthropic" \| "openai"` | Y | LLM 프로바이더 |
| `model` | `string` | Y | 모델 이름 |
| `apiKey` | `string` | N | 해당 tier의 API 키. 생략하면 `llm.apiKey`를 사용 |
| `baseURL` | `string` | N | API 엔드포인트 URL. Ollama 등 로컬 서버 연결 시 필요 |

tier를 설정하지 않으면 `llm.apiKey` + `llm.model` 조합으로 모든 tier에 Anthropic 어댑터를 사용한다. 기존 설정과 호환된다.

### `gestalt.json` 예시 (Anthropic + Ollama 혼합)

```json
{
  "$schema": "./node_modules/@tienne/gestalt/schemas/gestalt.schema.json",
  "llm": {
    "apiKey": "",
    "model": "claude-sonnet-5",
    "frugal": {
      "provider": "openai",
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "model": "llama3.2"
    },
    "standard": {
      "provider": "anthropic",
      "model": "claude-sonnet-5"
    },
    "frontier": {
      "provider": "anthropic",
      "model": "claude-opus-4-20250514"
    }
  }
}
```

### Tier별 환경변수

패턴: `GESTALT_LLM_{TIER}_{FIELD}`

| 환경변수 | Config 경로 |
|----------|-------------|
| `GESTALT_LLM_FRUGAL_PROVIDER` | `llm.frugal.provider` |
| `GESTALT_LLM_FRUGAL_API_KEY` | `llm.frugal.apiKey` |
| `GESTALT_LLM_FRUGAL_BASE_URL` | `llm.frugal.baseURL` |
| `GESTALT_LLM_FRUGAL_MODEL` | `llm.frugal.model` |
| `GESTALT_LLM_STANDARD_PROVIDER` | `llm.standard.provider` |
| `GESTALT_LLM_STANDARD_API_KEY` | `llm.standard.apiKey` |
| `GESTALT_LLM_STANDARD_BASE_URL` | `llm.standard.baseURL` |
| `GESTALT_LLM_STANDARD_MODEL` | `llm.standard.model` |
| `GESTALT_LLM_FRONTIER_PROVIDER` | `llm.frontier.provider` |
| `GESTALT_LLM_FRONTIER_API_KEY` | `llm.frontier.apiKey` |
| `GESTALT_LLM_FRONTIER_BASE_URL` | `llm.frontier.baseURL` |
| `GESTALT_LLM_FRONTIER_MODEL` | `llm.frontier.model` |

---

## Ollama 연결

Ollama는 OpenAI 호환 API를 제공한다. `openai` provider에 `baseURL`을 지정하면 바로 사용할 수 있다.

### 1. Ollama 설치 및 모델 준비

```bash
# macOS
brew install ollama

# 서버 시작
ollama serve

# 모델 다운로드
ollama pull llama3.2
```

### 2. `gestalt.json` 설정

```json
{
  "llm": {
    "apiKey": "",
    "frugal": {
      "provider": "openai",
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "model": "llama3.2"
    }
  }
}
```

Ollama의 OpenAI 호환 엔드포인트는 `http://localhost:11434/v1`이다. `apiKey`는 임의의 문자열을 넣으면 된다 (Ollama는 인증을 요구하지 않지만, OpenAI SDK가 빈 값을 허용하지 않는다).
