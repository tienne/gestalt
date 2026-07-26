import { GestaltPrinciple } from './types.js';

export const RESOLUTION_THRESHOLD = 0.8;
export const MAX_INTERVIEW_ROUNDS = 15;
export const MAX_SPEC_RETRIES = 3;
export const LLM_TEMPERATURE = 0.3;
export const LLM_MAX_TOKENS = 4096;
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_REASONING_MODEL = 'fable';
export const REASONING_MODEL_FALLBACK = 'opus';

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
export const SKILLS_DIR = 'skills';

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
