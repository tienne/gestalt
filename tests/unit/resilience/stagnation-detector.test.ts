import { describe, it, expect } from 'vitest';
import { classifyStagnation } from '../../../src/resilience/stagnation-detector.js';
import type { TerminationCondition, EvolutionGeneration } from '../../../src/core/types.js';

function makeGeneration(gen: number, score: number): EvolutionGeneration {
  return {
    generation: gen,
    spec: {} as any,
    evaluationScore: score,
    goalAlignment: score * 0.9,
    delta: { fieldsChanged: ['acceptanceCriteria'], similarity: 0.8, generation: gen },
  };
}

describe('classifyStagnation', () => {
  it('hard_cap → spinning', () => {
    const termination: TerminationCondition = {
      reason: 'hard_cap',
      scoreHistory: [0.5, 0.55, 0.6],
      stagnationDetected: false,
      oscillationDetected: false,
      hardCapReached: true,
    };

    const result = classifyStagnation({
      evolutionHistory: [makeGeneration(0, 0.5), makeGeneration(1, 0.55)],
      currentScore: 0.6,
      termination,
    });

    expect(result).toBe('spinning');
  });

  it('oscillation → oscillation', () => {
    const termination: TerminationCondition = {
      reason: 'oscillation',
      scoreHistory: [0.5, 0.7, 0.5, 0.7, 0.5],
      stagnationDetected: false,
      oscillationDetected: true,
      hardCapReached: false,
    };

    const result = classifyStagnation({
      evolutionHistory: [
        makeGeneration(0, 0.5),
        makeGeneration(1, 0.7),
        makeGeneration(2, 0.5),
        makeGeneration(3, 0.7),
      ],
      currentScore: 0.5,
      termination,
    });

    expect(result).toBe('oscillation');
  });

  it('stagnation + declining deltas → diminishing_returns', () => {
    const termination: TerminationCondition = {
      reason: 'stagnation',
      scoreHistory: [0.5, 0.55, 0.57, 0.575],
      stagnationDetected: true,
      oscillationDetected: false,
      hardCapReached: false,
    };

    const result = classifyStagnation({
      evolutionHistory: [makeGeneration(0, 0.5), makeGeneration(1, 0.55), makeGeneration(2, 0.57)],
      currentScore: 0.575,
      termination,
    });

    expect(result).toBe('diminishing_returns');
  });

  it('stagnation + zero deltas → no_drift', () => {
    const termination: TerminationCondition = {
      reason: 'stagnation',
      scoreHistory: [0.5, 0.5, 0.5, 0.5],
      stagnationDetected: true,
      oscillationDetected: false,
      hardCapReached: false,
    };

    const result = classifyStagnation({
      evolutionHistory: [makeGeneration(0, 0.5), makeGeneration(1, 0.5), makeGeneration(2, 0.5)],
      currentScore: 0.5,
      termination,
    });

    expect(result).toBe('no_drift');
  });

  it('stagnation with sufficient history and zero deltas → no_drift', () => {
    const termination: TerminationCondition = {
      reason: 'stagnation',
      scoreHistory: [0.5, 0.5, 0.5],
      stagnationDetected: true,
      oscillationDetected: false,
      hardCapReached: false,
    };

    const result = classifyStagnation({
      evolutionHistory: [makeGeneration(0, 0.5), makeGeneration(1, 0.5)],
      currentScore: 0.5,
      termination,
    });

    expect(result).toBe('no_drift');
  });

  it('stagnation with minimal history (< 2 generations) falls back to spinning', () => {
    const termination: TerminationCondition = {
      reason: 'stagnation',
      scoreHistory: [0.5, 0.5],
      stagnationDetected: true,
      oscillationDetected: false,
      hardCapReached: false,
    };

    const result = classifyStagnation({
      evolutionHistory: [makeGeneration(0, 0.5)],
      currentScore: 0.5,
      termination,
    });

    // Not enough history to classify delta pattern → fallback
    expect(result).toBe('spinning');
  });
});
