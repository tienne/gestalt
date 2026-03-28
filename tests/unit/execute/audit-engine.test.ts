import { describe, it, expect } from 'vitest';
import { AuditEngine } from '../../../src/execute/audit-engine.js';
import type { Spec } from '../../../src/core/types.js';

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    version: '1.0',
    goal: 'Build a REST API',
    constraints: ['Use TypeScript', 'REST API'],
    acceptanceCriteria: [
      'Users can register with email and password',
      'Users can log in and receive a JWT token',
      'Protected routes require valid JWT',
    ],
    ontologySchema: { entities: [], relations: [] },
    gestaltAnalysis: [],
    metadata: {
      specId: 'test-spec-id',
      interviewSessionId: 'test-session-id',
      ambiguityScore: 0.1,
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('AuditEngine', () => {
  const engine = new AuditEngine();

  describe('buildAuditContext', () => {
    it('returns systemPrompt and auditPrompt', () => {
      const spec = makeSpec();
      const ctx = engine.buildAuditContext(spec, 'const app = express();');
      expect(ctx.systemPrompt).toBeTruthy();
      expect(ctx.auditPrompt).toBeTruthy();
    });

    it('includes spec goal in auditPrompt', () => {
      const spec = makeSpec({ goal: 'Unique goal text' });
      const ctx = engine.buildAuditContext(spec, 'code');
      expect(ctx.auditPrompt).toContain('Unique goal text');
    });

    it('includes all acceptance criteria in auditPrompt', () => {
      const spec = makeSpec();
      const ctx = engine.buildAuditContext(spec, 'code');
      expect(ctx.auditPrompt).toContain('AC[0]');
      expect(ctx.auditPrompt).toContain('AC[1]');
      expect(ctx.auditPrompt).toContain('AC[2]');
      expect(ctx.auditPrompt).toContain('Users can register');
      expect(ctx.auditPrompt).toContain('JWT token');
    });

    it('includes codebase snapshot in auditPrompt', () => {
      const spec = makeSpec();
      const snapshot = 'function register() { /* ... */ }';
      const ctx = engine.buildAuditContext(spec, snapshot);
      expect(ctx.auditPrompt).toContain(snapshot);
    });

    it('handles empty acceptance criteria', () => {
      const spec = makeSpec({ acceptanceCriteria: [] });
      const ctx = engine.buildAuditContext(spec, 'code');
      expect(ctx.auditPrompt).toBeTruthy();
    });
  });

  describe('buildAuditResult', () => {
    it('returns AuditResult with correct fields', () => {
      const raw = {
        implementedACs: [0, 2],
        partialACs: [1],
        missingACs: [3],
        gapAnalysis: 'Missing authentication middleware',
      };
      const result = engine.buildAuditResult(raw);
      expect(result.implementedACs).toEqual([0, 2]);
      expect(result.partialACs).toEqual([1]);
      expect(result.missingACs).toEqual([3]);
      expect(result.gapAnalysis).toBe('Missing authentication middleware');
    });

    it('sets auditedAt to ISO date string', () => {
      const raw = { implementedACs: [], partialACs: [], missingACs: [], gapAnalysis: '' };
      const result = engine.buildAuditResult(raw);
      expect(result.auditedAt).toBeTruthy();
      const date = new Date(result.auditedAt);
      expect(date.getFullYear()).toBeGreaterThan(2000);
    });

    it('handles empty arrays', () => {
      const raw = {
        implementedACs: [],
        partialACs: [],
        missingACs: [],
        gapAnalysis: 'Everything is missing',
      };
      const result = engine.buildAuditResult(raw);
      expect(result.implementedACs).toHaveLength(0);
      expect(result.partialACs).toHaveLength(0);
      expect(result.missingACs).toHaveLength(0);
    });
  });
});
