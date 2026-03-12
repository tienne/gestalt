import type { SpecPatch, EvaluationResult } from '../core/types.js';

// ─── Stagnation Classification ─────────────────────────────────

export type StagnationPattern = 'spinning' | 'oscillation' | 'no_drift' | 'diminishing_returns';
export type LateralPersonaName = 'multistability' | 'simplicity' | 'reification' | 'invariance';

/**
 * Stagnation Pattern → Lateral Persona 매핑
 *
 * | Pattern            | Persona        | 전략               |
 * |--------------------|----------------|--------------------|
 * | spinning (hard_cap)| Multistability | 다른 각도로 보기    |
 * | oscillation        | Simplicity     | 단순하게 줄이기     |
 * | no_drift           | Reification    | 빠진 조각 채우기    |
 * | diminishing_returns| Invariance     | 성공 패턴 복제하기  |
 */
export const STAGNATION_PERSONA_MAP: Record<StagnationPattern, LateralPersonaName> = {
  spinning: 'multistability',
  oscillation: 'simplicity',
  no_drift: 'reification',
  diminishing_returns: 'invariance',
};

// ─── Lateral Context ───────────────────────────────────────────

export interface LateralContext {
  systemPrompt: string;
  lateralPrompt: string;
  phase: 'evolving';
  stage: 'lateral';
  persona: LateralPersonaName;
  pattern: StagnationPattern;
  attemptNumber: number; // 1-4
  previousScores: number[];
}

export interface LateralResult {
  persona: LateralPersonaName;
  specPatch: SpecPatch;
  description: string;
}

// ─── Human Escalation ──────────────────────────────────────────

export interface EscalationContext {
  phase: 'evolving';
  stage: 'human_escalation';
  message: string;
  triedPersonas: LateralPersonaName[];
  bestScore: number;
  lastEvaluationResult: EvaluationResult;
  suggestions: string[];
}
