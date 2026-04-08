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
