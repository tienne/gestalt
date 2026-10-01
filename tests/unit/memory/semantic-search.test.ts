import { describe, it, expect, vi } from 'vitest';
import type { ProjectMemory } from '../../../src/core/types.js';

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
vi.mock('../../../src/knowledge-base/embedding.js', () => ({
  EmbeddingService: class {
    embedBatch = embedBatch;
  },
}));

const { searchSimilarSpecs } = await import('../../../src/memory/semantic-search.js');

function memoryOf(goals: string[]): ProjectMemory {
  return {
    version: '1.0.0',
    repoRoot: '/repo',
    specHistory: goals.map((goal, i) => ({
      specId: `spec-${i}`,
      goal,
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceType: 'interview',
    })),
    executionHistory: [],
    architectureDecisions: [],
    lastUpdated: '2026-01-01T00:00:00.000Z',
  };
}

describe('searchSimilarSpecs', () => {
  it('한글 쿼리는 영어 전용 모델에 넘기지 않는다', async () => {
    embedBatch.mockClear();
    const result = await searchSimilarSpecs('결제 개선', memoryOf(['Payment checkout']));
    expect(result).toEqual([]);
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('한글 goal은 후보에서 뺀다', async () => {
    embedBatch.mockClear();
    const result = await searchSimilarSpecs(
      'Improve checkout',
      memoryOf(['장바구니 결제 단계 간소화', 'Payment checkout']),
    );
    expect(embedBatch).toHaveBeenCalledWith(['Improve checkout', 'Payment checkout']);
    expect(result.map((s) => s.goal)).toEqual(['Payment checkout']);
  });

  it('minScore보다 낮은 항목은 버린다', async () => {
    embedBatch.mockImplementationOnce(async () => [
      [1, 0],
      [0, 1],
    ]);
    const result = await searchSimilarSpecs('Improve checkout', memoryOf(['Unrelated']), 3, 0.4);
    expect(result).toEqual([]);
  });
});
