# Configuration Reference

## 우선순위

설정값은 다음 순서로 병합된다 (위로 갈수록 높은 우선순위).

1. `loadConfig(overrides)` — 코드에서 직접 전달
2. Shell 환경변수 (`export GESTALT_*`)
3. `.env` 파일 (dotenv)
4. `gestalt.json` 파일
5. 기본값

---

## `gestalt.json`

`gestalt init` 명령으로 생성된다. JSON Schema로 IDE 자동완성을 지원한다.

```json
{
  "$schema": "./node_modules/@tienne/gestalt/schemas/gestalt.schema.json",
  "llm": { "apiKey": "", "model": "claude-sonnet-5" },
  "interview": { "resolutionThreshold": 0.8, "maxRounds": 10 },
  "execute": { "driftThreshold": 0.3, "successThreshold": 0.85, "goalAlignmentThreshold": 0.80 },
  "reasoningModel": "fable",
  "reasoningModelFallback": "opus",
  "tierModels": { "frugal": "haiku", "standard": "sonnet", "frontier": "opus" },
  "dbPath": ".gestalt/gestalt.db",
  "logLevel": "info"
}
```

---

## `GestaltConfig` 타입

```typescript
interface GestaltConfig {
  llm: { apiKey: string; model: string };
  interview: { resolutionThreshold: number; maxRounds: number };
  execute: { driftThreshold: number; successThreshold: number; goalAlignmentThreshold: number };
  reasoningModel: 'fable' | 'opus' | 'sonnet' | 'haiku';
  reasoningModelFallback: 'fable' | 'opus' | 'sonnet' | 'haiku';
  tierModels: {
    frugal: 'fable' | 'opus' | 'sonnet' | 'haiku';
    standard: 'fable' | 'opus' | 'sonnet' | 'haiku';
    frontier: 'fable' | 'opus' | 'sonnet' | 'haiku';
  };
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
  notifications: boolean;
  dbPath: string;
  skillsDir: string;
  agentsDir: string;
  roleAgentsDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  client: 'claude-code' | 'codex' | 'both' | 'grok';
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
| `GESTALT_DRIFT_THRESHOLD` | number (0–1) | `0.3` | Execute 평가 시 드리프트 허용 임계값. 초과 시 Evolve 루프 진입 |
| `GESTALT_EVOLVE_SUCCESS_THRESHOLD` | number (0–1) | `0.85` | Evolve 성공 판정 기준 점수 |
| `GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD` | number (0–1) | `0.80` | 목표 정렬도 최소 임계값. 미달 시 재실행 트리거 |
| `GESTALT_REASONING_MODEL` | `"fable"` \| `"opus"` \| `"sonnet"` \| `"haiku"` | `"fable"` | 스펙 생성과 실행 플래닝의 깊은 추론에 쓸 Agent 서브에이전트 모델. Interview는 대상이 아님 |
| `GESTALT_REASONING_MODEL_FALLBACK` | `"fable"` \| `"opus"` \| `"sonnet"` \| `"haiku"` | `"opus"` | 위 모델을 Agent 도구가 지원하지 않을 때 쓸 폴백 모델 |
| `GESTALT_NOTIFICATIONS` | boolean | `false` | 완료/실패 시 OS 알림 전송 여부 (`"true"` 문자열로 설정) |
| `GESTALT_DB_PATH` | string | `"~/.gestalt/events.db"` | SQLite 이벤트 스토어 파일 경로 |
| `GESTALT_SKILLS_DIR` | string | `"skills"` | 스킬 SKILL.md 파일들이 위치한 디렉터리 |
| `GESTALT_AGENTS_DIR` | string | `"agents"` | 커스텀 에이전트 정의 디렉터리 |
| `GESTALT_ROLE_AGENTS_DIR` | string | `"role-agents"` | Role Agent 정의 디렉터리 |
| `GESTALT_REVIEW_AGENTS_DIR` | string | `"review-agents"` | Review Agent 정의 디렉터리 |
| `GESTALT_LOG_LEVEL` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | 로그 출력 레벨 |
| `GESTALT_CLIENT` | `"claude-code"` \| `"codex"` \| `"both"` \| `"grok"` | `"claude-code"` | 액티브 세션 컨텍스트를 쓰는 호스트. `grok`는 `.grok/rules/gestalt-active.md`만 쓰고 Interview/Spec passthrough를 강제한다. `"both"`는 Claude와 Codex만 쓰며 Grok 경로는 쓰지 않는다 |
| `GESTALT_NO_UPDATE_CHECK` | `"1"` | — | `"1"` 로 설정하면 버전 업데이트 확인을 건너뜀 |

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
| `GESTALT_DB_PATH` | `dbPath` |
| `GESTALT_SKILLS_DIR` | `skillsDir` |
| `GESTALT_AGENTS_DIR` | `agentsDir` |
| `GESTALT_ROLE_AGENTS_DIR` | `roleAgentsDir` |
| `GESTALT_REVIEW_AGENTS_DIR` | `reviewAgentsDir` |
| `GESTALT_LOG_LEVEL` | `logLevel` |
| `GESTALT_CLIENT` | `client` |

---

## Reasoning Model (`reasoningModel` / `reasoningModelFallback`)

게슈탈트는 Passthrough 모드라 인터뷰→스펙→실행 플래닝의 추론을 호스트 세션 모델이 수행한다. 이 중 상위 추론 모델이 진짜 값을 하는 곳은 leaf 실행 태스크가 아니라 **스펙 생성과 실행 플래닝(스펙→태스크 DAG 분해)의 깊은 one-shot 추론**이다. 그래서 spec 스킬과 execute 스킬의 Phase 1 플래닝은 `reasoningModel`(기본 `fable`)을 Agent 서브에이전트 `model` 파라미터로 스폰한다.

- **적용 대상**: 스펙 생성(spec 스킬), 실행 플래닝(execute 스킬 `plan_step` / `plan_complete`).
- **비대상**: 인터뷰(Phase 1 Q&A는 대화형이라 제외), execute Phase 2 실행 태스크(기존 태스크별 `model` 힌트 유지).
- **값**: `fable | opus | sonnet | haiku` — full 모델 ID가 아니라 Agent 도구가 받는 alias.

`ges_status`는 sessionId 없이 호출해도 resolve된 `reasoningModel` / `reasoningModelFallback`을 노출한다. 스킬은 `gestalt.json`을 직접 파싱하지 않고 이 값을 읽는다.

### 폴백 발동 지점

`reasoningModelFallback`(기본 `opus`)은 폴백 **대상**일 뿐이다. 서버는 모델 가용성을 감지하지 않으며, 폴백을 발동하지도 않는다. 실제 발동은 **스킬 런타임**에서 일어난다 — Agent 도구가 `reasoningModel`(예: `fable`)을 지원하지 않아 스폰이 거부/실패하면, 그때 스킬이 직접 `model`을 `reasoningModelFallback`로 바꿔 1회 재시도한다. 즉 "fable 안 되면 opus"의 판단은 서버가 아니라 스킬이 한다.

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
| `id` | string (≤64자) | 보고에 쓰는 이름. 레포 안에서 고유해야 한다 |
| `kind` | `mcp` \| `file` \| `skill` | 규칙이 어디 있나 |
| `ref` | string (≤512자) | `kind`별 대상 — MCP 도구 이름, 파일 경로, 스킬 이름 |
| `scope` | string[] (≤16개) | 이 태그가 걸린 작업에서만 읽는다. 비면 항상 읽는다 |
| `trust` | `convention` \| `delegate` | `convention`은 형식을 따른다. `delegate`는 그 작업을 넘긴다 |
| `onMissing` | `skip` \| `warn` \| `stop` | 못 읽었을 때 조용히 진행할지, 보고에 남길지, 멈출지 |

`ref`에는 선이 걸려 있다. `file`은 레포 기준 상대 경로여야 하고 절대 경로와 `..`, 자격 증명이 담기는 자리는 거부한다. `mcp`와 `skill`은 이름 꼴만 받는다. 배열은 32개까지다. **거부 목록과 상한의 원본은 [`rule-sources.md`](../plugin/skills/_shared/rule-sources.md)의 "`ref`에 걸린 선" 절이다** — 여기 옮겨 적으면 한쪽만 고쳐진다.

**상한을 넘으면 잘리는 게 아니라 거부된다.** 자른 `ref`는 스킬이 가진 유일한 `ref`라서, 읽기에 실패한 뒤 `onMissing`을 타고 조용히 지나간다. 거부하면 아래 `ruleSourceErrors`에 드러난다.

**선언한 것만 읽는다.** 붙어 있는 MCP 서버를 훑어 관련 있어 보이는 걸 골라 쓰지 않는다. 무엇을 근거로 삼았는지 불투명해진다. 이름만 비슷한 엉뚱한 걸 물 수 있다. 선언이 없으면 스킬은 이 단계를 통째로 건너뛴다.

`gestalt init`은 이 필드를 만들지 않는다. 기본값이 빈 배열이고 무엇을 기준으로 삼을지는 조직마다 다르기 때문이다. 쓰려면 위 예시처럼 직접 적는다.

**어느 쪽 `trust`든 작업 범위는 못 늘린다.** 읽어온 문서에 "이것도 같이 처리하라"가 적혀 있어도 할 일이 늘지 않는다. 형식은 받고 범위는 안 준다.

`ges_status`는 sessionId 없이 호출해도 resolve된 `ruleSources`를 노출한다. 스킬은 `gestalt.json`을 직접 파싱하지 않고 이 값을 읽는다.

적용 규칙의 원본은 [`plugin/skills/_shared/rule-sources.md`](../plugin/skills/_shared/rule-sources.md)다. 어느 스킬이 언제 읽는지는 [어느 스킬이 언제 규칙 소스를 읽나](./mcp-reference.md#어느-스킬이-언제-규칙-소스를-읽나)에 있다.

### `ruleSourceErrors` (읽기 전용)

사용자가 쓰는 필드가 아니라 게슈탈트가 채운다. `gestalt.json`에 적어도 무시된다.

잘못된 항목만 빠지고 나머지 소스와 다른 설정은 남는다. 그래서 `ruleSources`가 비어 있지 않아도 일부가 빠진 상태일 수 있다. 무엇이 왜 빠졌는지를 이 필드에 싣고 스킬이 멈춘다 — 안 알리면 `stop`으로 걸어둔 검사가 안 돈 채로 지나간다. **원소를 특정할 수 없는 오류는 배열 전체가 빠진다.** `id` 중복, 개수 상한 초과, 배열이 아닌 값이 그렇다. 설정을 통째로 복구하지 못한 경우도 마찬가지인데, 그때는 `ruleSources`가 멀쩡했어도 함께 날아가므로 그 사실이 이 필드에 실린다.

최상위 키 이름을 틀린 경우(`ruleSource`, `ruleSorces`)도 여기 실린다. 최상위 스키마는 모르는 키를 조용히 버리는데, 하필 그 키가 `ruleSources`를 적으려던 것이면 결과가 "선언 안 한 레포"와 똑같아지기 때문이다. **값이 선언 꼴일 때만 올린다** — 이름만 비슷한 키가 세션을 세우면 안 된다. `schemas/gestalt.schema.json`의 `additionalProperties: false`는 `$schema`를 건 에디터에서만 걸리고 런타임은 못 잡으므로 이 검사가 따로 있다.

오류가 많으면 `ges_status`에는 앞의 20줄만 실린다. 실제 개수는 같은 응답의 `ruleSourceErrorCount`에 있다.

```jsonc
// ges_status 응답
{
  "ruleSources": [],
  "ruleSourceErrors": [
    "ruleSources.1.kind: Invalid enum value. Expected 'mcp' | 'file' | 'skill', received 'http'"
  ]
}
```

빈 `ruleSources`는 두 가지 뜻이다. 이 필드가 비어 있어야 "선언 안 함"이다. 차 있으면 "선언이 깨짐"이다.

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

> **품질 영향은 아직 측정하지 않았다.** 해상도 점수는 인터뷰를 언제 끝낼지 정하는 값(임계값 0.8)이라 모델을 내려서 점수가 흔들리면 라운드 수가 달라진다. `pnpm tsx scripts/verify-frugal-scoring.ts`가 golden-set 20건을 두 tier로 채점해 편차와 임계값 판정이 뒤집힌 건수를 낸다. KB 요약 쪽은 그에 대응하는 검증이 아직 없어서 opt-in으로 둔다. 요약문은 KB 본문과 임베딩에 남는다. 되돌리려면 KB를 다시 만들어야 한다.

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
