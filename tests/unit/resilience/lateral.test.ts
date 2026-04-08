import { describe, it, expect } from 'vitest';
import { suggestPersona, buildLateralContext, buildEscalationContext } from '../../../src/resilience/lateral.js';
import type { Spec, EvaluationResult, EvolutionGeneration } from '../../../src/core/types.js';
import type { LateralPersonaName } from '../../../src/resilience/types.js';

function makeSpec(): Spec {
  return {
    version: '1.0.0',
    goal: 'Build auth system',
    constraints: ['Must use JWT'],
    acceptanceCriteria: ['Users can register', 'Users can login'],
    ontologySchema: {
      entities: [{ name: 'User', description: 'System user', attributes: ['email'] }],
      relations: [],
    },
    gestaltAnalysis: [],
    metadata: { specId: 'test', interviewSessionId: 'test', resolutionScore: 0.9, generatedAt: '' },
  };
}

function makeEvalResult(): EvaluationResult {
  return {
    verifications: [
      { acIndex: 0, satisfied: true, evidence: 'Done', gaps: [] },
      { acIndex: 1, satisfied: false, evidence: 'Partial', gaps: ['Missing OAuth'] },
    ],
    overallScore: 0.6,
    goalAlignment: 0.7,
    recommendations: ['Add OAuth support'],
  };
}

function makeHistory(count: number): EvolutionGeneration[] {
  return Array.from({ length: count }, (_, i) => ({
    generation: i,
    spec: makeSpec(),
    evaluationScore: 0.5 + i * 0.02,
    goalAlignment: 0.6 + i * 0.02,
    delta: { fieldsChanged: ['acceptanceCriteria'], similarity: 0.9, generation: i },
  }));
}

describe('suggestPersona', () => {
  it('spinning → multistability (primary mapping)', () => {
    expect(suggestPersona('spinning', [])).toBe('multistability');
  });

  it('oscillation → simplicity (primary mapping)', () => {
    expect(suggestPersona('oscillation', [])).toBe('simplicity');
  });

  it('no_drift → reification (primary mapping)', () => {
    expect(suggestPersona('no_drift', [])).toBe('reification');
  });

  it('diminishing_returns → invariance (primary mapping)', () => {
    expect(suggestPersona('diminishing_returns', [])).toBe('invariance');
  });

  it('primary tried → returns next untried persona', () => {
    expect(suggestPersona('spinning', ['multistability'])).toBe('simplicity');
  });

  it('multiple tried → returns next untried persona', () => {
    expect(suggestPersona('spinning', ['multistability', 'simplicity'])).toBe('reification');
  });

  it('all tried → returns null', () => {
    const allTried: LateralPersonaName[] = ['multistability', 'simplicity', 'reification', 'invariance'];
    expect(suggestPersona('spinning', allTried)).toBeNull();
  });
});

describe('buildLateralContext', () => {
  it('returns correctly structured LateralContext', () => {
    const ctx = buildLateralContext(
      'multistability',
      'spinning',
      makeSpec(),
      makeEvalResult(),
      makeHistory(2),
      1,
    );

    expect(ctx.phase).toBe('evolving');
    expect(ctx.stage).toBe('lateral');
    expect(ctx.persona).toBe('multistability');
    expect(ctx.pattern).toBe('spinning');
    expect(ctx.attemptNumber).toBe(1);
    expect(ctx.previousScores).toHaveLength(2);
    expect(ctx.systemPrompt).toContain('Multistability');
    expect(ctx.lateralPrompt).toContain('Spec Goal');
    expect(ctx.lateralPrompt).toContain('spinning');
  });

  it('includes unsatisfied criteria in prompt', () => {
    const ctx = buildLateralContext(
      'reification',
      'no_drift',
      makeSpec(),
      makeEvalResult(),
      [],
      1,
    );

    expect(ctx.lateralPrompt).toContain('Missing OAuth');
  });
});

describe('buildEscalationContext', () => {
  it('returns correctly structured EscalationContext', () => {
    const allTried: LateralPersonaName[] = ['multistability', 'simplicity', 'reification', 'invariance'];
    const ctx = buildEscalationContext(allTried, makeEvalResult(), makeHistory(3));

    expect(ctx.phase).toBe('evolving');
    expect(ctx.stage).toBe('human_escalation');
    expect(ctx.triedPersonas).toHaveLength(4);
    expect(ctx.bestScore).toBeGreaterThan(0);
    expect(ctx.message).toContain('exhausted');
    expect(ctx.suggestions.length).toBeGreaterThan(0);
  });
});
