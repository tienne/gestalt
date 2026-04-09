import { describe, it, expect } from 'vitest';
import { selectNextPrinciple, getPrinciplePhaseLabel } from '../../../src/gestalt/principles.js';
import { GestaltPrinciple } from '../../../src/core/types.js';

describe('selectNextPrinciple', () => {
  it('returns CONTINUITY when contradictions exist', () => {
    const result = selectNextPrinciple({
      roundNumber: 1,
      dimensions: [],
      hasContradictions: true,
    });
    expect(result).toBe(GestaltPrinciple.CONTINUITY);
  });

  it('returns CLOSURE in early rounds (1-3)', () => {
    const result = selectNextPrinciple({
      roundNumber: 1,
      dimensions: [],
      hasContradictions: false,
    });
    expect(result).toBe(GestaltPrinciple.CLOSURE);
  });

  it('returns PROXIMITY or SIMILARITY in mid rounds (4-8)', () => {
    const even = selectNextPrinciple({
      roundNumber: 4,
      dimensions: [],
      hasContradictions: false,
    });
    const odd = selectNextPrinciple({
      roundNumber: 5,
      dimensions: [],
      hasContradictions: false,
    });
    expect(even).toBe(GestaltPrinciple.PROXIMITY);
    expect(odd).toBe(GestaltPrinciple.SIMILARITY);
  });

  it('returns FIGURE_GROUND in late rounds (9+)', () => {
    const result = selectNextPrinciple({
      roundNumber: 10,
      dimensions: [],
      hasContradictions: false,
    });
    expect(result).toBe(GestaltPrinciple.FIGURE_GROUND);
  });

  it('targets weakest dimension when clarity < 0.5', () => {
    const result = selectNextPrinciple({
      roundNumber: 5,
      dimensions: [
        {
          name: 'goalClarity',
          clarity: 0.9,
          weight: 0.4,
          gestaltPrinciple: GestaltPrinciple.CLOSURE,
        },
        {
          name: 'constraintClarity',
          clarity: 0.2,
          weight: 0.25,
          gestaltPrinciple: GestaltPrinciple.PROXIMITY,
        },
        {
          name: 'successCriteria',
          clarity: 0.8,
          weight: 0.2,
          gestaltPrinciple: GestaltPrinciple.SIMILARITY,
        },
        {
          name: 'priorityClarity',
          clarity: 0.7,
          weight: 0.15,
          gestaltPrinciple: GestaltPrinciple.FIGURE_GROUND,
        },
      ],
      hasContradictions: false,
    });
    expect(result).toBe(GestaltPrinciple.PROXIMITY);
  });

  it('uses phase-based default when all clarity >= 0.5', () => {
    const result = selectNextPrinciple({
      roundNumber: 2,
      dimensions: [
        {
          name: 'goalClarity',
          clarity: 0.8,
          weight: 0.4,
          gestaltPrinciple: GestaltPrinciple.CLOSURE,
        },
        {
          name: 'constraintClarity',
          clarity: 0.7,
          weight: 0.25,
          gestaltPrinciple: GestaltPrinciple.PROXIMITY,
        },
      ],
      hasContradictions: false,
    });
    expect(result).toBe(GestaltPrinciple.CLOSURE);
  });
});

describe('getPrinciplePhaseLabel', () => {
  it('returns correct labels', () => {
    expect(getPrinciplePhaseLabel(1)).toBe('early (goal definition)');
    expect(getPrinciplePhaseLabel(5)).toBe('mid (structuring)');
    expect(getPrinciplePhaseLabel(10)).toBe('late (prioritization)');
  });
});
