import type { TerminationCondition, EvolutionGeneration } from '../core/types.js';
import {
  EVOLVE_SUCCESS_THRESHOLD,
  EVOLVE_GOAL_ALIGNMENT_THRESHOLD,
  EVOLVE_STAGNATION_DELTA,
  EVOLVE_STAGNATION_COUNT,
  EVOLVE_OSCILLATION_COUNT,
  EVOLVE_MAX_STRUCTURAL_FIX,
  EVOLVE_MAX_CONTEXTUAL,
} from '../core/constants.js';

interface TerminationInput {
  evolutionHistory: EvolutionGeneration[];
  currentScore: number;
  currentGoalAlignment: number;
  structuralFixCount: number;
  contextualCount: number;
}

/**
 * Termination Detector — 진화 루프 종료 조건을 검사한다.
 *
 * 종료 조건 (우선순위 순):
 * 1. Success: overallScore ≥ threshold AND goalAlignment ≥ threshold
 * 2. Hard Cap: structural fix ≥ MAX_STRUCTURAL_FIX 또는 contextual ≥ MAX_CONTEXTUAL
 * 3. Stagnation: 연속 N회 delta < threshold
 * 4. Oscillation: 연속 N회 score가 오르내림 반복
 */
export function checkTermination(input: TerminationInput): TerminationCondition | null {
  const {
    evolutionHistory,
    currentScore,
    currentGoalAlignment,
    structuralFixCount,
    contextualCount,
  } = input;

  const scoreHistory = [...evolutionHistory.map((g) => g.evaluationScore), currentScore];

  // 1. Success
  if (
    currentScore >= EVOLVE_SUCCESS_THRESHOLD &&
    currentGoalAlignment >= EVOLVE_GOAL_ALIGNMENT_THRESHOLD
  ) {
    return {
      reason: 'success',
      scoreHistory,
      stagnationDetected: false,
      oscillationDetected: false,
      hardCapReached: false,
    };
  }

  // 2. Hard Cap
  if (structuralFixCount >= EVOLVE_MAX_STRUCTURAL_FIX || contextualCount >= EVOLVE_MAX_CONTEXTUAL) {
    return {
      reason: 'hard_cap',
      scoreHistory,
      stagnationDetected: false,
      oscillationDetected: false,
      hardCapReached: true,
    };
  }

  // 3. Stagnation: 연속 STAGNATION_COUNT회 이상 delta가 STAGNATION_DELTA 미만
  if (scoreHistory.length >= EVOLVE_STAGNATION_COUNT + 1) {
    const recentDeltas: number[] = [];
    for (let i = scoreHistory.length - EVOLVE_STAGNATION_COUNT; i < scoreHistory.length; i++) {
      recentDeltas.push(Math.abs(scoreHistory[i]! - scoreHistory[i - 1]!));
    }
    const isStagnant = recentDeltas.every((d) => d < EVOLVE_STAGNATION_DELTA);
    if (isStagnant) {
      return {
        reason: 'stagnation',
        scoreHistory,
        stagnationDetected: true,
        oscillationDetected: false,
        hardCapReached: false,
      };
    }
  }

  // 4. Oscillation: 연속 OSCILLATION_COUNT회 score가 up/down 반복
  if (scoreHistory.length >= EVOLVE_OSCILLATION_COUNT * 2 + 1) {
    const tail = scoreHistory.slice(-(EVOLVE_OSCILLATION_COUNT * 2 + 1));
    let oscillating = true;
    for (let i = 1; i < tail.length - 1; i++) {
      const prev = tail[i - 1]!;
      const curr = tail[i]!;
      const next = tail[i + 1]!;
      // 각 중간점이 양쪽과 다른 방향이어야 oscillation
      if (!((curr > prev && curr > next) || (curr < prev && curr < next))) {
        oscillating = false;
        break;
      }
    }
    if (oscillating) {
      return {
        reason: 'oscillation',
        scoreHistory,
        stagnationDetected: false,
        oscillationDetected: true,
        hardCapReached: false,
      };
    }
  }

  return null; // 종료 조건 미충족 — 계속 진행
}
