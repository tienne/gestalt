import { describe, it, expect } from 'vitest';
import { generateEvolutionHtml } from '../../../src/graph-viz/evolution-html-generator.js';
import { randomUUID } from 'node:crypto';
import type { ExecuteSession, EvolutionGeneration, Spec } from '../../../src/core/types.js';

function makeMinimalSpec(): Spec {
  return {
    version: '1.0.0',
    goal: 'Test goal',
    constraints: [],
    acceptanceCriteria: ['AC 1'],
    ontologySchema: { entities: [], relations: [] },
    gestaltAnalysis: [],
    metadata: {
      specId: randomUUID(),
      interviewSessionId: randomUUID(),
      resolutionScore: 0.85,
      generatedAt: new Date().toISOString(),
    },
  };
}

function makeEvolutionGeneration(
  overrides: Partial<EvolutionGeneration> = {},
): EvolutionGeneration {
  return {
    generation: 1,
    spec: makeMinimalSpec(),
    evaluationScore: 0.75,
    goalAlignment: 0.8,
    delta: { fieldsChanged: ['acceptanceCriteria'], similarity: 0.9, generation: 1 },
    ...overrides,
  };
}

function makeSession(overrides: Partial<ExecuteSession> = {}): ExecuteSession {
  const sessionId = randomUUID();
  return {
    sessionId,
    specId: randomUUID(),
    spec: makeMinimalSpec(),
    status: 'evolving',
    currentStep: 1,
    planningSteps: [],
    taskResults: [],
    completedTaskIds: [],
    nextTaskId: null,
    subTasks: [],
    driftHistory: [],
    evolutionHistory: [],
    currentGeneration: 0,
    lateralTriedPersonas: [],
    lateralAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('generateEvolutionHtml()', () => {
  describe('빈 evolutionHistory', () => {
    it('"No evolution data" 텍스트를 포함한다', () => {
      const session = makeSession({ evolutionHistory: [] });
      const html = generateEvolutionHtml(session);
      expect(html).toContain('No evolution data');
    });

    it('sessionId를 포함한다', () => {
      const session = makeSession({ evolutionHistory: [] });
      const html = generateEvolutionHtml(session);
      expect(html).toContain(session.sessionId);
    });

    it('유효한 HTML 구조를 반환한다', () => {
      const session = makeSession({ evolutionHistory: [] });
      const html = generateEvolutionHtml(session);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html');
      expect(html).toContain('</html>');
    });

    it('Chart.js CDN URL을 포함하지 않는다 (빈 상태에서는 차트 불필요)', () => {
      const session = makeSession({ evolutionHistory: [] });
      const html = generateEvolutionHtml(session);
      expect(html).not.toContain('https://cdn.jsdelivr.net/npm/chart.js');
    });
  });

  describe('데이터가 있을 때', () => {
    it('Chart.js CDN URL을 포함한다', () => {
      const session = makeSession({
        evolutionHistory: [makeEvolutionGeneration({ generation: 1, evaluationScore: 0.75 })],
        currentGeneration: 1,
      });
      const html = generateEvolutionHtml(session);
      expect(html).toContain('https://cdn.jsdelivr.net/npm/chart.js');
    });

    it('evaluationScore 값을 포함한다', () => {
      const session = makeSession({
        evolutionHistory: [makeEvolutionGeneration({ generation: 1, evaluationScore: 0.75 })],
        currentGeneration: 1,
      });
      const html = generateEvolutionHtml(session);
      expect(html).toContain('0.75');
    });

    it('sessionId를 포함한다', () => {
      const session = makeSession({
        evolutionHistory: [makeEvolutionGeneration({ generation: 1 })],
        currentGeneration: 1,
      });
      const html = generateEvolutionHtml(session);
      expect(html).toContain(session.sessionId);
    });

    it('goalAlignment 값을 포함한다', () => {
      const session = makeSession({
        evolutionHistory: [
          makeEvolutionGeneration({ generation: 1, evaluationScore: 0.6, goalAlignment: 0.88 }),
        ],
        currentGeneration: 1,
      });
      const html = generateEvolutionHtml(session);
      expect(html).toContain('0.88');
    });

    it('generation 레이블을 포함한다', () => {
      const session = makeSession({
        evolutionHistory: [
          makeEvolutionGeneration({ generation: 1 }),
          makeEvolutionGeneration({ generation: 2, evaluationScore: 0.85, goalAlignment: 0.9 }),
        ],
        currentGeneration: 2,
      });
      const html = generateEvolutionHtml(session);
      expect(html).toContain('Gen 1');
      expect(html).toContain('Gen 2');
    });

    it('lateralTriedPersonas가 있으면 해당 값을 포함한다', () => {
      const session = makeSession({
        evolutionHistory: [makeEvolutionGeneration({ generation: 1 })],
        currentGeneration: 1,
        lateralTriedPersonas: ['multistability', 'simplicity'],
      });
      const html = generateEvolutionHtml(session);
      expect(html).toContain('multistability');
      expect(html).toContain('simplicity');
    });

    it('terminationReason이 있으면 포함한다', () => {
      const session = makeSession({
        evolutionHistory: [makeEvolutionGeneration({ generation: 1, evaluationScore: 0.95 })],
        currentGeneration: 1,
        terminationReason: 'success',
      });
      const html = generateEvolutionHtml(session);
      expect(html).toContain('success');
    });

    it('복수 세대 데이터를 에러 없이 처리한다', () => {
      const history = Array.from({ length: 5 }, (_, i) =>
        makeEvolutionGeneration({
          generation: i + 1,
          evaluationScore: 0.5 + i * 0.1,
          goalAlignment: 0.4 + i * 0.12,
        }),
      );
      const session = makeSession({ evolutionHistory: history, currentGeneration: 5 });
      expect(() => generateEvolutionHtml(session)).not.toThrow();
      const html = generateEvolutionHtml(session);
      expect(html).toContain('https://cdn.jsdelivr.net/npm/chart.js');
    });

    it('유효한 HTML 구조를 반환한다', () => {
      const session = makeSession({
        evolutionHistory: [makeEvolutionGeneration({ generation: 1 })],
        currentGeneration: 1,
      });
      const html = generateEvolutionHtml(session);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('</html>');
    });
  });
});
