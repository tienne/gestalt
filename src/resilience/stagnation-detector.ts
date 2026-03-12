import type { EvolutionGeneration, TerminationCondition } from '../core/types.js';
import type { StagnationPattern } from './types.js';

interface ClassifyInput {
  evolutionHistory: EvolutionGeneration[];
  currentScore: number;
  termination: TerminationCondition;
}

/**
 * Stagnation Detector — termination 사유를 세분화된 StagnationPattern으로 분류한다.
 *
 * - hard_cap → spinning (다른 각도로 보기)
 * - oscillation → oscillation (단순하게 줄이기)
 * - stagnation → score delta 패턴 분석:
 *   - delta가 점점 줄어드는 패턴 → diminishing_returns
 *   - delta가 거의 0 → no_drift
 */
export function classifyStagnation(input: ClassifyInput): StagnationPattern {
  const { evolutionHistory, termination } = input;

  if (termination.hardCapReached) {
    return 'spinning';
  }

  if (termination.oscillationDetected) {
    return 'oscillation';
  }

  // stagnation → delta 패턴 분석
  if (termination.stagnationDetected && evolutionHistory.length >= 2) {
    const deltas: number[] = [];
    const scores = termination.scoreHistory;

    for (let i = 1; i < scores.length; i++) {
      deltas.push(Math.abs(scores[i]! - scores[i - 1]!));
    }

    if (deltas.length >= 2) {
      // delta가 줄어드는 추세인지 확인 (마지막 2개 비교)
      const lastDelta = deltas[deltas.length - 1]!;
      const prevDelta = deltas[deltas.length - 2]!;

      if (prevDelta > lastDelta && prevDelta > 0.001) {
        return 'diminishing_returns';
      }
    }

    return 'no_drift';
  }

  // fallback: hard_cap가 아닌 reason이더라도 spinning으로 분류
  return 'spinning';
}
