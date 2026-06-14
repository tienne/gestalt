import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { handleEvolutionViz } from '../../../src/mcp/tools/execute/utility.js';
import { handleExecutePassthrough } from '../../../src/mcp/tools/execute-passthrough.js';
import type { ExecuteInput } from '../../../src/mcp/schemas.js';
import type { Spec } from '../../../src/core/types.js';

function makeTestSpec(): Spec {
  return {
    version: '1.0.0',
    goal: 'Build auth system',
    constraints: ['Use JWT'],
    acceptanceCriteria: ['User can login'],
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

describe('handleEvolutionViz', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/evolution-viz-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  describe('sessionId 없을 때', () => {
    it('error JSON을 반환한다', () => {
      const result = handleEvolutionViz(
        engine,
        { action: 'evolution_viz' } as ExecuteInput,
        'claude-code',
      );
      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result) as { error?: string };
      expect(parsed).toHaveProperty('error');
      expect(parsed.error).toContain('sessionId is required');
    });
  });

  describe('존재하지 않는 sessionId', () => {
    it('error JSON을 반환한다', () => {
      const result = handleEvolutionViz(
        engine,
        { action: 'evolution_viz', sessionId: 'nonexistent-session' } as ExecuteInput,
        'claude-code',
      );
      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result) as { error?: string };
      expect(parsed).toHaveProperty('error');
    });
  });

  describe('정상 세션 (evolutionHistory 빈 배열)', () => {
    it('filePath와 summary를 포함한 JSON을 반환한다', () => {
      const startResult = engine.start(makeTestSpec());
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;

      const result = handleEvolutionViz(
        engine,
        { action: 'evolution_viz', sessionId } as ExecuteInput,
        'claude-code',
      );

      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result) as {
        status?: string;
        sessionId?: string;
        filePath?: string;
        html?: string;
        summary?: {
          totalGenerations: number;
          currentGeneration: number;
          finalScore: null | number;
          triedPersonas: string[];
          terminationReason: null | string;
        };
      };

      expect(parsed.status).toBe('evolution_viz_ready');
      expect(parsed.sessionId).toBe(sessionId);
      expect(parsed.filePath).toBeDefined();
      expect(typeof parsed.filePath).toBe('string');
      expect(parsed.html).toBeDefined();
      expect(parsed.summary).toBeDefined();
      expect(parsed.summary!.totalGenerations).toBe(0);
      expect(parsed.summary!.finalScore).toBeNull();
      expect(parsed.summary!.triedPersonas).toEqual([]);
      expect(parsed.summary!.terminationReason).toBeNull();
    });

    it('html 필드가 "No evolution data"를 포함한다', () => {
      const startResult = engine.start(makeTestSpec());
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      const result = handleEvolutionViz(
        engine,
        { action: 'evolution_viz', sessionId } as ExecuteInput,
        'claude-code',
      );

      const parsed = JSON.parse(result) as { html?: string };
      expect(parsed.html).toContain('No evolution data');
    });
  });

  describe('dispatch를 통한 evolution_viz 라우팅', () => {
    it('handleExecutePassthrough에서 evolution_viz action이 정상 라우팅된다', async () => {
      const startResult = engine.start(makeTestSpec());
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;

      const result = await handleExecutePassthrough(
        engine,
        { action: 'evolution_viz', sessionId } as ExecuteInput,
        'claude-code',
      );

      expect(typeof result).toBe('string');
      expect(() => JSON.parse(result)).not.toThrow();
      const parsed = JSON.parse(result) as { status?: string; error?: string };
      expect(parsed.status).toBe('evolution_viz_ready');
      expect(parsed).not.toHaveProperty('error');
    });

    it('sessionId 없이 dispatch하면 error JSON을 반환한다', async () => {
      const result = await handleExecutePassthrough(
        engine,
        { action: 'evolution_viz' } as ExecuteInput,
        'claude-code',
      );

      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result) as { error?: string };
      expect(parsed).toHaveProperty('error');
      expect(parsed.error).toContain('sessionId is required');
    });
  });
});
