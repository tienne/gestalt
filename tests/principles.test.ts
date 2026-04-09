import { describe, it, expect } from 'vitest';
import {
  selectNextPrinciple,
  getPrinciplePhaseLabel,
  getAllPrinciples,
} from '../src/gestalt/principles.js';
import { GestaltPrinciple, type ResolutionDimension } from '../src/core/types.js';

describe('selectNextPrinciple', () => {
  it('returns CONTINUITY when contradictions exist', () => {
    const result = selectNextPrinciple({
      roundNumber: 1,
      dimensions: [],
      hasContradictions: true,
    });
    expect(result).toBe(GestaltPrinciple.CONTINUITY);
  });

  it('returns CLOSURE for early rounds (1-3)', () => {
    for (const round of [1, 2, 3]) {
      const result = selectNextPrinciple({
        roundNumber: round,
        dimensions: [],
        hasContradictions: false,
      });
      expect(result).toBe(GestaltPrinciple.CLOSURE);
    }
  });

  it('alternates PROXIMITY/SIMILARITY for mid rounds (4-8)', () => {
    const r4 = selectNextPrinciple({ roundNumber: 4, dimensions: [], hasContradictions: false });
    const r5 = selectNextPrinciple({ roundNumber: 5, dimensions: [], hasContradictions: false });
    expect(r4).toBe(GestaltPrinciple.PROXIMITY);
    expect(r5).toBe(GestaltPrinciple.SIMILARITY);
  });

  it('returns FIGURE_GROUND for late rounds (9+)', () => {
    const result = selectNextPrinciple({
      roundNumber: 9,
      dimensions: [],
      hasContradictions: false,
    });
    expect(result).toBe(GestaltPrinciple.FIGURE_GROUND);
  });

  it('targets weakest dimension when clarity < 0.5', () => {
    const dims: ResolutionDimension[] = [
      { name: 'scope', clarity: 0.8, weight: 0.4, gestaltPrinciple: GestaltPrinciple.CLOSURE },
      { name: 'arch', clarity: 0.3, weight: 0.3, gestaltPrinciple: GestaltPrinciple.PROXIMITY },
    ];

    const result = selectNextPrinciple({
      roundNumber: 5,
      dimensions: dims,
      hasContradictions: false,
    });
    expect(result).toBe(GestaltPrinciple.PROXIMITY);
  });
});

describe('getPrinciplePhaseLabel', () => {
  it('returns correct phase labels', () => {
    expect(getPrinciplePhaseLabel(1)).toContain('early');
    expect(getPrinciplePhaseLabel(5)).toContain('mid');
    expect(getPrinciplePhaseLabel(10)).toContain('late');
  });
});

describe('getAllPrinciples', () => {
  it('returns all 5 principles', () => {
    const all = getAllPrinciples();
    expect(all).toHaveLength(5);
    expect(all).toContain(GestaltPrinciple.CLOSURE);
    expect(all).toContain(GestaltPrinciple.CONTINUITY);
  });
});
