import { GestaltPrinciple } from './types.js';

export const AMBIGUITY_THRESHOLD = 0.2;
export const MAX_INTERVIEW_ROUNDS = 15;
export const MAX_SEED_RETRIES = 3;
export const LLM_TEMPERATURE = 0.3;
export const LLM_MAX_TOKENS = 4096;
export const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export const GREENFIELD_WEIGHTS: Record<GestaltPrinciple, number> = {
  [GestaltPrinciple.CLOSURE]: 0.40,
  [GestaltPrinciple.PROXIMITY]: 0.25,
  [GestaltPrinciple.SIMILARITY]: 0.20,
  [GestaltPrinciple.FIGURE_GROUND]: 0.15,
  [GestaltPrinciple.CONTINUITY]: 0,
};

export const BROWNFIELD_WEIGHTS: Record<GestaltPrinciple, number> = {
  [GestaltPrinciple.CLOSURE]: 0.30,
  [GestaltPrinciple.PROXIMITY]: 0.20,
  [GestaltPrinciple.SIMILARITY]: 0.15,
  [GestaltPrinciple.FIGURE_GROUND]: 0.15,
  [GestaltPrinciple.CONTINUITY]: 0.20,
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
