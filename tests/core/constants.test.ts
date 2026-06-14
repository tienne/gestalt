import { describe, it, expect } from 'vitest';
import {
  RESOLUTION_THRESHOLD,
  MAX_INTERVIEW_ROUNDS,
  MAX_SPEC_RETRIES,
  LLM_TEMPERATURE,
  LLM_MAX_TOKENS,
  DEFAULT_MODEL,
  GREENFIELD_WEIGHTS,
  BROWNFIELD_WEIGHTS,
  CONTINUITY_PENALTY_MIN,
  CONTINUITY_PENALTY_MAX,
  PRINCIPLE_QUESTION_STRATEGIES,
  EVENT_STORE_TABLE,
  SKILLS_DIR,
  DEFAULT_SESSION_TTL_MS,
  PLANNING_PRINCIPLE_SEQUENCE,
  PLANNING_TOTAL_STEPS,
  PLANNING_PRINCIPLE_STRATEGIES,
  MAX_ATOMIC_TASKS,
  MAX_TASK_GROUPS,
  EXECUTION_PRINCIPLE_STRATEGY,
  DRIFT_THRESHOLD,
  DRIFT_WEIGHTS,
  EVOLVE_MAX_STRUCTURAL_FIX,
  EVOLVE_MAX_CONTEXTUAL,
  EVOLVE_SUCCESS_THRESHOLD,
  EVOLVE_GOAL_ALIGNMENT_THRESHOLD,
  EVOLVE_STAGNATION_DELTA,
  EVOLVE_STAGNATION_COUNT,
  EVOLVE_OSCILLATION_COUNT,
} from '../../src/core/constants.js';
import { GestaltPrinciple } from '../../src/core/types.js';

// ─── 숫자 상수 ──────────────────────────────────────────────────────────────

describe('숫자형 상수', () => {
  it('RESOLUTION_THRESHOLD는 0.8이다', () => {
    expect(RESOLUTION_THRESHOLD).toBe(0.8);
  });

  it('MAX_INTERVIEW_ROUNDS는 15다', () => {
    expect(MAX_INTERVIEW_ROUNDS).toBe(15);
  });

  it('MAX_SPEC_RETRIES는 3이다', () => {
    expect(MAX_SPEC_RETRIES).toBe(3);
  });

  it('LLM_TEMPERATURE는 0.3이다', () => {
    expect(LLM_TEMPERATURE).toBe(0.3);
  });

  it('LLM_MAX_TOKENS는 4096이다', () => {
    expect(LLM_MAX_TOKENS).toBe(4096);
  });

  it('CONTINUITY_PENALTY_MIN은 0.05다', () => {
    expect(CONTINUITY_PENALTY_MIN).toBe(0.05);
  });

  it('CONTINUITY_PENALTY_MAX는 0.15다', () => {
    expect(CONTINUITY_PENALTY_MAX).toBe(0.15);
  });

  it('CONTINUITY_PENALTY_MIN < CONTINUITY_PENALTY_MAX', () => {
    expect(CONTINUITY_PENALTY_MIN).toBeLessThan(CONTINUITY_PENALTY_MAX);
  });

  it('DEFAULT_SESSION_TTL_MS는 24시간(ms)이다', () => {
    expect(DEFAULT_SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('PLANNING_TOTAL_STEPS는 4이다', () => {
    expect(PLANNING_TOTAL_STEPS).toBe(4);
  });

  it('MAX_ATOMIC_TASKS는 100이다', () => {
    expect(MAX_ATOMIC_TASKS).toBe(100);
  });

  it('MAX_TASK_GROUPS는 20이다', () => {
    expect(MAX_TASK_GROUPS).toBe(20);
  });

  it('DRIFT_THRESHOLD는 0.3이다', () => {
    expect(DRIFT_THRESHOLD).toBe(0.3);
  });

  it('EVOLVE_MAX_STRUCTURAL_FIX는 3이다', () => {
    expect(EVOLVE_MAX_STRUCTURAL_FIX).toBe(3);
  });

  it('EVOLVE_MAX_CONTEXTUAL는 3이다', () => {
    expect(EVOLVE_MAX_CONTEXTUAL).toBe(3);
  });

  it('EVOLVE_SUCCESS_THRESHOLD는 0.85다', () => {
    expect(EVOLVE_SUCCESS_THRESHOLD).toBe(0.85);
  });

  it('EVOLVE_GOAL_ALIGNMENT_THRESHOLD는 0.8이다', () => {
    expect(EVOLVE_GOAL_ALIGNMENT_THRESHOLD).toBe(0.8);
  });

  it('EVOLVE_STAGNATION_DELTA는 0.05다', () => {
    expect(EVOLVE_STAGNATION_DELTA).toBe(0.05);
  });

  it('EVOLVE_STAGNATION_COUNT는 2다', () => {
    expect(EVOLVE_STAGNATION_COUNT).toBe(2);
  });

  it('EVOLVE_OSCILLATION_COUNT는 2다', () => {
    expect(EVOLVE_OSCILLATION_COUNT).toBe(2);
  });
});

// ─── 문자열 상수 ────────────────────────────────────────────────────────────

describe('문자열 상수', () => {
  it('DEFAULT_MODEL은 빈 문자열이 아니다', () => {
    expect(DEFAULT_MODEL.length).toBeGreaterThan(0);
  });

  it('DEFAULT_MODEL은 claude 모델 이름이다', () => {
    expect(DEFAULT_MODEL).toMatch(/claude/i);
  });

  it('EVENT_STORE_TABLE은 events다', () => {
    expect(EVENT_STORE_TABLE).toBe('events');
  });

  it('SKILLS_DIR은 skills다', () => {
    expect(SKILLS_DIR).toBe('skills');
  });
});

// ─── GREENFIELD_WEIGHTS ─────────────────────────────────────────────────────

describe('GREENFIELD_WEIGHTS', () => {
  it('모든 GestaltPrinciple 키를 포함한다', () => {
    const principles = Object.values(GestaltPrinciple);
    for (const p of principles) {
      expect(GREENFIELD_WEIGHTS).toHaveProperty(p);
    }
  });

  it('모든 weight는 0 이상 1 이하다', () => {
    for (const [, w] of Object.entries(GREENFIELD_WEIGHTS)) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('CLOSURE weight는 CONTINUITY보다 크다 (greenfield는 연속성 낮음)', () => {
    expect(GREENFIELD_WEIGHTS[GestaltPrinciple.CLOSURE]).toBeGreaterThan(
      GREENFIELD_WEIGHTS[GestaltPrinciple.CONTINUITY],
    );
  });
});

// ─── BROWNFIELD_WEIGHTS ─────────────────────────────────────────────────────

describe('BROWNFIELD_WEIGHTS', () => {
  it('모든 GestaltPrinciple 키를 포함한다', () => {
    const principles = Object.values(GestaltPrinciple);
    for (const p of principles) {
      expect(BROWNFIELD_WEIGHTS).toHaveProperty(p);
    }
  });

  it('모든 weight는 0 초과 1 이하다 (brownfield는 continuity > 0)', () => {
    for (const [, w] of Object.entries(BROWNFIELD_WEIGHTS)) {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('brownfield CONTINUITY weight는 greenfield보다 크다', () => {
    expect(BROWNFIELD_WEIGHTS[GestaltPrinciple.CONTINUITY]).toBeGreaterThan(
      GREENFIELD_WEIGHTS[GestaltPrinciple.CONTINUITY],
    );
  });
});

// ─── PRINCIPLE_QUESTION_STRATEGIES ─────────────────────────────────────────

describe('PRINCIPLE_QUESTION_STRATEGIES', () => {
  it('모든 GestaltPrinciple에 대한 전략 문자열이 있다', () => {
    const principles = Object.values(GestaltPrinciple);
    for (const p of principles) {
      expect(PRINCIPLE_QUESTION_STRATEGIES).toHaveProperty(p);
      expect(typeof PRINCIPLE_QUESTION_STRATEGIES[p]).toBe('string');
      expect(PRINCIPLE_QUESTION_STRATEGIES[p]!.length).toBeGreaterThan(0);
    }
  });
});

// ─── PLANNING_PRINCIPLE_SEQUENCE ────────────────────────────────────────────

describe('PLANNING_PRINCIPLE_SEQUENCE', () => {
  it('4개의 원리로 구성된다', () => {
    expect(PLANNING_PRINCIPLE_SEQUENCE.length).toBe(4);
  });

  it('FIGURE_GROUND이 첫 번째다', () => {
    expect(PLANNING_PRINCIPLE_SEQUENCE[0]).toBe(GestaltPrinciple.FIGURE_GROUND);
  });

  it('CONTINUITY가 마지막이다', () => {
    const last = PLANNING_PRINCIPLE_SEQUENCE[PLANNING_PRINCIPLE_SEQUENCE.length - 1]!;
    expect(last).toBe(GestaltPrinciple.CONTINUITY);
  });

  it('유효한 GestaltPrinciple 값만 포함한다', () => {
    const valid = new Set(Object.values(GestaltPrinciple));
    for (const p of PLANNING_PRINCIPLE_SEQUENCE) {
      expect(valid.has(p)).toBe(true);
    }
  });
});

// ─── PLANNING_PRINCIPLE_STRATEGIES ─────────────────────────────────────────

describe('PLANNING_PRINCIPLE_STRATEGIES', () => {
  it('FIGURE_GROUND 전략 문자열이 존재한다', () => {
    expect(PLANNING_PRINCIPLE_STRATEGIES[GestaltPrinciple.FIGURE_GROUND]).toBeTruthy();
  });

  it('CLOSURE 전략 문자열이 존재한다', () => {
    expect(PLANNING_PRINCIPLE_STRATEGIES[GestaltPrinciple.CLOSURE]).toBeTruthy();
  });

  it('PROXIMITY 전략 문자열이 존재한다', () => {
    expect(PLANNING_PRINCIPLE_STRATEGIES[GestaltPrinciple.PROXIMITY]).toBeTruthy();
  });

  it('CONTINUITY 전략 문자열이 존재한다', () => {
    expect(PLANNING_PRINCIPLE_STRATEGIES[GestaltPrinciple.CONTINUITY]).toBeTruthy();
  });
});

// ─── DRIFT_WEIGHTS ──────────────────────────────────────────────────────────

describe('DRIFT_WEIGHTS', () => {
  it('goal, constraint, ontology 키가 있다', () => {
    expect(DRIFT_WEIGHTS).toHaveProperty('goal');
    expect(DRIFT_WEIGHTS).toHaveProperty('constraint');
    expect(DRIFT_WEIGHTS).toHaveProperty('ontology');
  });

  it('모든 weight는 0 초과 1 이하다', () => {
    for (const [, w] of Object.entries(DRIFT_WEIGHTS)) {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('goal + constraint + ontology 합은 1.0이다', () => {
    const total = DRIFT_WEIGHTS.goal + DRIFT_WEIGHTS.constraint + DRIFT_WEIGHTS.ontology;
    expect(total).toBeCloseTo(1.0);
  });
});

// ─── EXECUTION_PRINCIPLE_STRATEGY ──────────────────────────────────────────

describe('EXECUTION_PRINCIPLE_STRATEGY', () => {
  it('SIMILARITY 전략 문자열이 존재한다', () => {
    expect(EXECUTION_PRINCIPLE_STRATEGY[GestaltPrinciple.SIMILARITY]).toBeTruthy();
  });
});
