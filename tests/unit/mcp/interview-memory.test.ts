import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ProjectMemory } from '../../../src/core/types.js';
import { EventStore } from '../../../src/events/store.js';
import { AgentRegistry } from '../../../src/agent/registry.js';
import { PassthroughEngine } from '../../../src/interview/passthrough-engine.js';
import { handleInterviewPassthrough } from '../../../src/mcp/tools/interview-passthrough.js';

describe('interview start의 과거 스펙 주입', () => {
  let store: EventStore;
  let engine: PassthroughEngine;
  let dbPath: string;
  let cwd: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/interview-memory-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    const registry = new AgentRegistry('plugin/agents');
    registry.loadAll();
    engine = new PassthroughEngine(store, registry);

    // package.json을 두면 ProjectMemoryStore가 레포 루트를 여기서 찾는다
    cwd = `.gestalt-test/interview-memory-cwd-${randomUUID()}`;
    mkdirSync(`${cwd}/.gestalt`, { recursive: true });
    writeFileSync(`${cwd}/package.json`, '{}');
    const memory: ProjectMemory = {
      version: '1.0.0',
      repoRoot: cwd,
      specHistory: Array.from({ length: 6 }, (_, i) => ({
        specId: `spec-${i}`,
        goal: i === 0 ? 'Payment checkout flow' : `Unrelated goal ${i}`,
        createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        sourceType: 'interview' as const,
      })),
      executionHistory: [],
      architectureDecisions: [],
      lastUpdated: '2026-01-06T00:00:00.000Z',
    };
    writeFileSync(`${cwd}/.gestalt/memory.json`, JSON.stringify(memory));
  });

  afterEach(() => {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  const start = async (search: () => Promise<ProjectMemory['specHistory']>) =>
    JSON.parse(
      await handleInterviewPassthrough(
        engine,
        { action: 'start', topic: 'Improve checkout', cwd },
        { search },
      ),
    );

  it('찾은 과거 스펙을 priorContext와 시스템 프롬프트에 함께 싣는다', async () => {
    const res = await start(async () => [
      {
        specId: 'spec-0',
        goal: 'Payment checkout flow',
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceType: 'interview',
      },
    ]);

    expect(res.priorContext.relatedSpecs.map((s: { specId: string }) => s.specId)).toEqual([
      'spec-0',
    ]);
    expect(res.gestaltContext.systemPrompt).toContain(
      '### Related Past Specs\n- [2026-01-01] Payment checkout flow',
    );
  });

  it('검색이 실패하면 최근 스펙만 넣고 나머지 응답은 그대로다', async () => {
    const res = await start(async () => {
      throw new Error('model unavailable');
    });

    expect(res.status).toBe('started');
    expect(res.priorContext.relatedSpecs).toEqual([]);
    expect(res.priorContext.recentSpecs).toHaveLength(5);
    expect(res.gestaltContext.systemPrompt).not.toContain('### Related Past Specs');
  });
});
