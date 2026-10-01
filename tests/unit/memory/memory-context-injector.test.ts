import { describe, it, expect, vi } from 'vitest';
import type { ProjectMemory, SpecHistoryEntry } from '../../../src/core/types.js';
import {
  buildMemoryContext,
  findRelatedSpecs,
  formatMemoryContextForPrompt,
} from '../../../src/memory/memory-context-injector.js';

function spec(n: number): SpecHistoryEntry {
  return {
    specId: `spec-${n}`,
    goal: `goal ${n}`,
    createdAt: `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`,
    sourceType: 'interview',
  };
}

function memoryWith(specCount: number, overrides: Partial<ProjectMemory> = {}): ProjectMemory {
  return {
    version: '1.0.0',
    repoRoot: '/repo',
    specHistory: Array.from({ length: specCount }, (_, i) => spec(i + 1)),
    executionHistory: [],
    architectureDecisions: [],
    lastUpdated: '2026-01-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('findRelatedSpecs', () => {
  it('최근 창 안에 다 들어가면 검색을 부르지 않는다', async () => {
    const search = vi.fn();
    const result = await findRelatedSpecs(memoryWith(5), 'topic', { search });
    expect(result).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('최근 창 밖의 스펙만 검색 대상으로 넘긴다', async () => {
    const search = vi.fn(async (_q: string, m: ProjectMemory) => m.specHistory.slice(0, 1));
    const result = await findRelatedSpecs(memoryWith(8), 'checkout flow', { search });

    const passed = search.mock.calls[0]![1];
    expect(passed.specHistory.map((s) => s.specId)).toEqual(['spec-1', 'spec-2', 'spec-3']);
    expect(search.mock.calls[0]![0]).toBe('checkout flow');
    expect(result.map((s) => s.specId)).toEqual(['spec-1']);
  });

  it('임베딩을 못 쓰면 빈 배열로 폴백한다', async () => {
    const search = vi.fn(async () => {
      throw new Error('model unavailable');
    });
    await expect(findRelatedSpecs(memoryWith(8), 'topic', { search })).resolves.toEqual([]);
  });

  it('제한 시간을 넘기면 기다리지 않고 빈 배열을 돌려준다', async () => {
    const search = vi.fn(() => new Promise<SpecHistoryEntry[]>(() => {}));
    const result = await findRelatedSpecs(memoryWith(8), 'topic', { search, timeoutMs: 10 });
    expect(result).toEqual([]);
  });
});

describe('formatMemoryContextForPrompt', () => {
  it('비슷한 과거 스펙을 최근 스펙과 따로 싣는다', () => {
    const memory = memoryWith(6);
    const ctx = buildMemoryContext(memory, [
      { goal: 'goal 1', specId: 'spec-1', createdAt: spec(1).createdAt, sourceType: 'interview' },
    ]);
    const prompt = formatMemoryContextForPrompt(ctx);

    expect(prompt).toContain('### Related Past Specs\n- [2026-01-01] goal 1');
    expect(prompt.split('### Related Past Specs')[0]).not.toContain('goal 1');
  });
});
