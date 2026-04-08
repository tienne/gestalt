# Configuration Reference

설정값 우선순위 (높→낮):
1. `loadConfig(overrides)` — 코드에서 직접 전달
2. Shell 환경변수 (`export GESTALT_*`)
3. `.env` 파일 (dotenv)
4. `gestalt.json` 파일
5. 기본값

## gestalt.json

`gestalt init` 명령어로 생성. JSON Schema로 IDE 자동완성 지원.

```json
{
  "$schema": "./node_modules/@tienne/gestalt/schemas/gestalt.schema.json",
  "llm": { "apiKey": "", "model": "claude-sonnet-4-20250514" },
  "interview": { "resolutionThreshold": 0.8, "maxRounds": 10 },
  "execute": { "driftThreshold": 0.3, "successThreshold": 0.85, "goalAlignmentThreshold": 0.80 },
  "dbPath": ".gestalt/gestalt.db",
  "logLevel": "info"
}
```

## GestaltConfig 타입

```typescript
interface GestaltConfig {
  llm: { apiKey: string; model: string };
  interview: { resolutionThreshold: number; maxRounds: number };
  execute: { driftThreshold: number; successThreshold: number; goalAlignmentThreshold: number };
  notifications: boolean;
  dbPath: string;
  skillsDir: string;
  agentsDir: string;
  roleAgentsDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}
```

## 환경변수 매핑

| 환경변수 | Config 경로 | 기본값 |
|----------|-------------|--------|
| `ANTHROPIC_API_KEY` | `llm.apiKey` | `""` |
| `GESTALT_MODEL` | `llm.model` | `"claude-sonnet-4-20250514"` |
| `GESTALT_RESOLUTION_THRESHOLD` | `interview.resolutionThreshold` | `0.8` |
| `GESTALT_MAX_ROUNDS` | `interview.maxRounds` | `10` |
| `GESTALT_DRIFT_THRESHOLD` | `execute.driftThreshold` | `0.3` |
| `GESTALT_EVOLVE_SUCCESS_THRESHOLD` | `execute.successThreshold` | `0.85` |
| `GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD` | `execute.goalAlignmentThreshold` | `0.80` |
| `GESTALT_NOTIFICATIONS` | `notifications` | `false` |
| `GESTALT_DB_PATH` | `dbPath` | `"~/.gestalt/events.db"` |
| `GESTALT_SKILLS_DIR` | `skillsDir` | `"skills"` |
| `GESTALT_AGENTS_DIR` | `agentsDir` | `"agents"` |
| `GESTALT_LOG_LEVEL` | `logLevel` | `"info"` |

잘못된 설정값은 경고를 출력하고 기본값으로 fallback한다 (에러를 throw하지 않음).

---

## 멀티 프로바이더 설정 (LLM Tier)

Gestalt는 작업 복잡도에 따라 다른 LLM 프로바이더를 사용할 수 있어요. **frugal**, **standard**, **frontier** 세 가지 tier로 구분해요.

| Tier | 용도 | 예시 |
|------|------|------|
| **frugal** | 가벼운 작업 — 점수 산정, 분류, 짧은 응답 | `llama3.2`, `haiku` |
| **standard** | 일반 작업 — 인터뷰, 스펙 생성, 코드 실행 | `claude-sonnet-4-20250514` |
| **frontier** | 고난도 추론 — 아키텍처 설계, 코드 리뷰, 진화 루프 | `claude-opus-4-20250514`, `o1` |

### gestalt.json 예시

Anthropic과 Ollama(OpenAI 호환)를 혼합해서 사용하는 설정이에요.

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

> 💡 **Tip**: tier를 설정하지 않으면 기존 `llm.apiKey` + `llm.model` 조합으로 모든 tier에 Anthropic 어댑터를 사용해요. 기존 설정과 완전히 호환돼요.

### tier 설정 규칙

각 tier 객체에는 다음 필드를 지정할 수 있어요.

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `provider` | `"anthropic"` \| `"openai"` | O | LLM 프로바이더 |
| `model` | `string` | O | 모델 이름 |
| `apiKey` | `string` | - | 해당 tier의 API 키. 생략하면 `llm.apiKey`를 사용해요. |
| `baseURL` | `string` | - | API 엔드포인트 URL. Ollama 등 로컬 서버 연결 시 필요해요. |

### 환경변수 매핑

tier별 설정은 환경변수로도 지정할 수 있어요. 패턴은 `GESTALT_LLM_{TIER}_{FIELD}`예요.

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

## Ollama 연결하기

Ollama는 OpenAI 호환 API를 제공해요. `openai` provider에 `baseURL`을 지정하면 Gestalt에서 바로 사용할 수 있어요.

### 1. Ollama 설치 및 모델 다운로드

```bash
# macOS
brew install ollama

# 서버 시작
ollama serve

# 모델 다운로드
ollama pull llama3.2
```

### 2. gestalt.json에 frugal tier로 설정

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

> 📝 **참고**: Ollama의 OpenAI 호환 엔드포인트는 `http://localhost:11434/v1`이에요. `apiKey`는 아무 문자열이나 넣으면 돼요 (Ollama가 인증을 요구하지 않지만, OpenAI SDK가 빈 값을 허용하지 않아요).
