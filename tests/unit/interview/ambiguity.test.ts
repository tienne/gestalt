import { describe, it, expect } from 'vitest';
import { computeAmbiguityScore } from '../../../src/gestalt/analyzer.js';

describe('computeAmbiguityScore', () => {
  it('returns high ambiguity for all-zero clarity', () => {
    const score = computeAmbiguityScore(
      {
        goalClarity: 0,
        constraintClarity: 0,
        successCriteria: 0,
        priorityClarity: 0,
        contradictions: [],
      },
      'greenfield',
    );
    expect(score.overall).toBe(1.0);
    expect(score.isReady).toBe(false);
  });

  it('returns low ambiguity for all-perfect clarity', () => {
    const score = computeAmbiguityScore(
      {
        goalClarity: 1.0,
        constraintClarity: 1.0,
        successCriteria: 1.0,
        priorityClarity: 1.0,
        contradictions: [],
      },
      'greenfield',
    );
    expect(score.overall).toBe(0.0);
    expect(score.isReady).toBe(true);
  });

  it('applies continuity penalty for contradictions', () => {
    const withoutContradictions = computeAmbiguityScore(
      {
        goalClarity: 0.5,
        constraintClarity: 0.5,
        successCriteria: 0.5,
        priorityClarity: 0.5,
        contradictions: [],
      },
      'greenfield',
    );

    const withContradictions = computeAmbiguityScore(
      {
        goalClarity: 0.5,
        constraintClarity: 0.5,
        successCriteria: 0.5,
        priorityClarity: 0.5,
        contradictions: ['goal vs constraint mismatch'],
      },
      'greenfield',
    );

    expect(withContradictions.overall).toBeGreaterThan(withoutContradictions.overall);
  });

  it('includes contextClarity for brownfield projects', () => {
    const score = computeAmbiguityScore(
      {
        goalClarity: 0.9,
        constraintClarity: 0.9,
        successCriteria: 0.9,
        priorityClarity: 0.9,
        contextClarity: 0.9,
        contradictions: [],
      },
      'brownfield',
    );
    expect(score.dimensions).toHaveLength(5);
    expect(score.dimensions.find((d) => d.name === 'contextClarity')).toBeDefined();
  });

  it('greenfield has 4 dimensions', () => {
    const score = computeAmbiguityScore(
      {
        goalClarity: 0.5,
        constraintClarity: 0.5,
        successCriteria: 0.5,
        priorityClarity: 0.5,
        contradictions: [],
      },
      'greenfield',
    );
    expect(score.dimensions).toHaveLength(4);
  });

  it('clamps values to 0-1 range', () => {
    const score = computeAmbiguityScore(
      {
        goalClarity: 1.5,
        constraintClarity: -0.2,
        successCriteria: 0.5,
        priorityClarity: 0.5,
        contradictions: [],
      },
      'greenfield',
    );
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.overall).toBeLessThanOrEqual(1);
  });
});
