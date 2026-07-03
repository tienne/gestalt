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
  "llm": { "apiKey": "", "model": "claude-sonnet-4-20250514" },
  "interview": { "resolutionThreshold": 0.8, "maxRounds": 10 },
  "execute": { "driftThreshold": 0.3, "successThreshold": 0.85, "goalAlignmentThreshold": 0.80 },
  "reasoningModel": "fable",
  "reasoningModelFallback": "opus",
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
  notifications: boolean;
  dbPath: string;
  skillsDir: string;
  agentsDir: string;
  roleAgentsDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}
```

---

## 환경변수 레퍼런스

| 변수명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `ANTHROPIC_API_KEY` | string | `""` | Anthropic API 키. 없으면 Interview/Spec에서 Passthrough 모드로 동작. `client: "codex"`에서도 Codex가 LLM 주체가 되도록 Interview/Spec은 Passthrough 모드로 동작. Execute는 항상 Passthrough. |
| `GESTALT_MODEL` | string | `"claude-sonnet-4-20250514"` | 기본 LLM 모델 이름 (`llm.model` 매핑) |
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
| `GESTALT_NOTIFICATIONS` | `notifications` |
| `GESTALT_DB_PATH` | `dbPath` |
| `GESTALT_SKILLS_DIR` | `skillsDir` |
| `GESTALT_AGENTS_DIR` | `agentsDir` |
| `GESTALT_ROLE_AGENTS_DIR` | `roleAgentsDir` |
| `GESTALT_REVIEW_AGENTS_DIR` | `reviewAgentsDir` |
| `GESTALT_LOG_LEVEL` | `logLevel` |

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

## 멀티 프로바이더 설정 (LLM Tier)

작업 복잡도에 따라 다른 LLM 프로바이더를 라우팅할 수 있다. `frugal`, `standard`, `frontier` 세 가지 tier로 구분한다.

| Tier | 용도 | 예시 모델 |
|------|------|-----------|
| `frugal` | 가벼운 작업 — 점수 산정, 분류, 짧은 응답 | `llama3.2`, `haiku` |
| `standard` | 일반 작업 — 인터뷰, 스펙 생성, 코드 실행 | `claude-sonnet-4-20250514` |
| `frontier` | 고난도 추론 — 아키텍처 설계, 코드 리뷰, 진화 루프 | `claude-opus-4-20250514`, `o1` |

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
    "model": "claude-sonnet-4-20250514",
    "frugal": {
      "provider": "openai",
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "model": "llama3.2"
    },
    "standard": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514"
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
