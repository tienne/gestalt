import { GestaltPrinciple } from './types.js';

export const RESOLUTION_THRESHOLD = 0.8;
/**
 * isReady를 정하는 규칙의 버전. 판정 규칙을 바꾸면 올려서 그 전후 결과를 한 표에 섞지 않게 한다.
 * 1은 LLM overall이 기준값 이상이면 준비됐다고 보는 규칙이다
 */
export const READINESS_RULE_VERSION = 1;
export const MAX_INTERVIEW_ROUNDS = 15;
export const MAX_SPEC_RETRIES = 3;
export const LLM_TEMPERATURE = 0.3;
export const LLM_MAX_TOKENS = 4096;
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_REASONING_MODEL = 'fable';
export const REASONING_MODEL_FALLBACK = 'opus';

/**
 * 에이전트 tier → Agent 도구 model 별칭.
 *
 * frontmatter의 tier는 "이 역할이 어느 정도 모델을 필요로 하나"를 선언할 뿐이라,
 * 실제 모델로 옮겨주는 자리가 없으면 라벨로만 남는다. 서브에이전트를 띄울 때
 * 이 표로 별칭을 뽑아 Agent 도구 model 파라미터로 넘긴다.
 *
 * DEFAULT_MODEL(API 모델 ID)과는 층위가 다르다 — 그쪽은 LLM 어댑터가 직접
 * API를 호출할 때 쓰는 정식 ID이고, 이쪽은 Passthrough에서 호스트 Agent 도구에
 * 넘기는 별칭이다.
 */
export const DEFAULT_TIER_MODELS = {
  frugal: 'haiku',
  standard: 'sonnet',
  frontier: 'opus',
} as const;

export const GREENFIELD_WEIGHTS: Record<GestaltPrinciple, number> = {
  [GestaltPrinciple.CLOSURE]: 0.4,
  [GestaltPrinciple.PROXIMITY]: 0.25,
  [GestaltPrinciple.SIMILARITY]: 0.2,
  [GestaltPrinciple.FIGURE_GROUND]: 0.15,
  [GestaltPrinciple.CONTINUITY]: 0,
};

export const BROWNFIELD_WEIGHTS: Record<GestaltPrinciple, number> = {
  [GestaltPrinciple.CLOSURE]: 0.3,
  [GestaltPrinciple.PROXIMITY]: 0.2,
  [GestaltPrinciple.SIMILARITY]: 0.15,
  [GestaltPrinciple.FIGURE_GROUND]: 0.15,
  [GestaltPrinciple.CONTINUITY]: 0.2,
};

export const CONTINUITY_PENALTY_MIN = 0.05;
export const CONTINUITY_PENALTY_MAX = 0.15;

export const PRINCIPLE_QUESTION_STRATEGIES: Record<GestaltPrinciple, string> = {
  [GestaltPrinciple.CLOSURE]:
    'Identify missing requirements. Ask: "You mentioned X, but how should Y be handled?"',
  [GestaltPrinciple.PROXIMITY]:
    'Group related requirements. Ask: "Should A and B be combined into one feature?"',
  [GestaltPrinciple.SIMILARITY]:
    'Identify patterns. Ask: "X and Y share a pattern — should they use a consistent approach?"',
  [GestaltPrinciple.FIGURE_GROUND]:
    'Separate essential from optional. Ask: "What must be in the MVP?"',
  [GestaltPrinciple.CONTINUITY]:
    'Cross-check consistency. Ask: "Earlier you said X, but now Y seems contradictory?"',
};

export const EVENT_STORE_TABLE = 'events';
export const SKILLS_DIR = 'plugin/skills';

// ─── SQLite 연결 ─────────────────────────────────────────────────
// MCP 서버는 클라이언트 세션마다 프로세스가 따로 뜨는데 DB는 홈 글로벌 경로를 공유한다.
// busy_timeout 기본값 0이면 쓰기 잠금이 겹치는 순간 기다리지 않고 SQLITE_BUSY로 즉시
// 실패하므로, 잠금이 풀릴 때까지 대기할 시간을 준다. 연결마다 설정해야 적용된다.
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

// ─── Session TTL ────────────────────────────────────────────────
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ─── Execute Engine ──────────────────────────────────────────────
export const PLANNING_PRINCIPLE_SEQUENCE = [
  GestaltPrinciple.FIGURE_GROUND,
  GestaltPrinciple.CLOSURE,
  GestaltPrinciple.PROXIMITY,
  GestaltPrinciple.CONTINUITY,
] as const;

export const PLANNING_TOTAL_STEPS = 4;

export const PLANNING_PRINCIPLE_STRATEGIES: Record<string, string> = {
  [GestaltPrinciple.FIGURE_GROUND]:
    'Separate essential (figure) from supplementary (ground) acceptance criteria. Assign priority levels based on impact and dependencies.',
  [GestaltPrinciple.CLOSURE]:
    'Identify implicit sub-tasks that are not explicitly stated but required for completeness. Decompose each AC into atomic, independently executable tasks.',
  [GestaltPrinciple.PROXIMITY]:
    'Group related atomic tasks by domain or functional area. Tasks that naturally belong together should share a group.',
  [GestaltPrinciple.CONTINUITY]:
    'Validate the dependency graph for consistency. Ensure no cycles, no conflicts between groups, and a clear execution order exists.',
};

export const MAX_ATOMIC_TASKS = 100;
export const MAX_TASK_GROUPS = 20;

// ─── Execution Phase ────────────────────────────────────────────
export const EXECUTION_PRINCIPLE_STRATEGY: Record<string, string> = {
  [GestaltPrinciple.SIMILARITY]:
    'Leverage Similarity: when executing a task, reference completed tasks with similar patterns to provide consistent implementation context.',
};

// 완료 보고된 artifacts를 git 작업 트리와 대조할 때 git 호출 하나에 주는 시간
export const ARTIFACT_GIT_TIMEOUT_MS = 10_000;
// 시작 시점 dirty 파일이 이보다 많으면 실행 시작 이벤트에 해시를 남기지 않는다. 메모리에서는 그대로 대조한다
export const BASELINE_EVENT_DIRTY_LIMIT = 2_000;
// 대조 실패 이벤트에 남기는 파일 수. 응답에는 전부 싣는다
export const VERIFICATION_EVENT_FILE_LIMIT = 50;
// 결과가 이 개수를 넘으면 execute_task 응답에 compress 안내를 붙인다
export const COMPRESSION_HINT_TASK_COUNT = 5;

// ─── Drift Detection ───────────────────────────────────────────
// Goal Drift가 문장 단위 Jaccard 유사도에서 임베딩(Xenova/all-MiniLM-L6-v2) 코사인
// 유사도로 교체되면서(src/execute/drift-detector.ts) 임계값도 새 척도에 맞게 재조정했다.
// 정렬 샘플(overall 0.30~0.57)과 이탈 샘플(overall 0.65~0.76) 실측 분포 사이의 간격에서
// 정렬 샘플 쪽에 여유를 두어 0.6으로 설정 — 상세 계산 근거는 PR/구현 기록 참고.
export const DRIFT_THRESHOLD = 0.6;
export const DRIFT_WEIGHTS = {
  goal: 0.5,
  constraint: 0.3,
  ontology: 0.2,
} as const;

// ─── Evolution Loop ────────────────────────────────────────────
export const EVOLVE_MAX_STRUCTURAL_FIX = 3;
export const EVOLVE_MAX_CONTEXTUAL = 3;
export const EVOLVE_SUCCESS_THRESHOLD = 0.85;
export const EVOLVE_GOAL_ALIGNMENT_THRESHOLD = 0.8;
export const EVOLVE_STAGNATION_DELTA = 0.05;
export const EVOLVE_STAGNATION_COUNT = 2;
export const EVOLVE_OSCILLATION_COUNT = 2;

/**
 * 컨덕터 주문 하나가 사람 손을 어디서 거치는지. merge-through는 머지까지 무승인이다.
 * 설정 스키마와 컨덕터 도메인이 함께 쓰므로 core에 둔다
 */
export const ORDER_SCOPES = ['merge-through', 'approval', 'interview-first'] as const;

/**
 * 워커 에이전트 id의 허용 꼴. 오르카 CLI 인자로 그대로 넘어가므로 `-`로 시작하는 값은 옵션으로 읽힌다.
 * 설정 스키마와 주문 접수가 같은 규칙을 쓰도록 core에 둔다. JSON 스키마 pattern도 같은 식이다
 */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Claude Code `--effort`가 받는 값. 오르카도 claude 모델에 이 다섯 개만 허용한다 */
export const HANDOFF_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type HandoffEffort = (typeof HANDOFF_EFFORTS)[number];

/**
 * 인계로 띄우는 지휘자 세션 모델 id의 허용 꼴. AGENT_ID_RE와 달리 별칭 뒤 `[1m]` 접미와 긴 전체 id를 받는다.
 * 오르카 `--model` 인자로 그대로 넘어가서 설정값과 트랜스크립트에서 읽은 값 모두 이 식으로 거른다
 */
export const HANDOFF_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}(\[1m\])?$/;
