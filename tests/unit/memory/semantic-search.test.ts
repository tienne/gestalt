import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectMemory } from '../../../src/core/types.js';

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
vi.mock('../../../src/knowledge-base/embedding.js', () => ({
  EmbeddingService: class {
    embedBatch = embedBatch;
  },
}));

const { searchSimilarSpecs, resetSemanticSearchState } =
  await import('../../../src/memory/semantic-search.js');

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
  beforeEach(() => {
    resetSemanticSearchState();
    embedBatch.mockReset();
    embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0]));
  });

  it('한글 쿼리는 영어 전용 모델에 넘기지 않는다', async () => {
    const result = await searchSimilarSpecs('결제 개선', memoryOf(['Payment checkout']));
    expect(result).toEqual([]);
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('한글 goal은 후보에서 뺀다', async () => {
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

  it('한 번 임베딩한 goal은 다음 검색에서 다시 넘기지 않는다', async () => {
    const memory = memoryOf(['Payment checkout', 'Search page']);
    await searchSimilarSpecs('Improve checkout', memory);
    await searchSimilarSpecs('Faster search', memory);

    expect(embedBatch).toHaveBeenLastCalledWith(['Faster search']);
  });

  it('모델이 올라오는 중에 들어온 검색은 기다리지 않고 실패로 돌린다', async () => {
    let finishLoading!: (v: number[][]) => void;
    embedBatch.mockImplementationOnce(
      () => new Promise<number[][]>((resolve) => (finishLoading = resolve)),
    );
    const memory = memoryOf(['Payment checkout']);

    const first = searchSimilarSpecs('Improve checkout', memory);
    await expect(searchSimilarSpecs('Improve checkout', memory)).rejects.toThrow(/still loading/);
    expect(embedBatch).toHaveBeenCalledTimes(1);

    finishLoading([
      [1, 0],
      [1, 0],
    ]);
    await expect(first).resolves.toHaveLength(1);
  });

  it('로딩에 실패하면 한동안 다시 받으려 들지 않는다', async () => {
    embedBatch.mockRejectedValueOnce(new Error('offline'));
    const memory = memoryOf(['Payment checkout']);

    await expect(searchSimilarSpecs('Improve checkout', memory)).rejects.toThrow('offline');
    await expect(searchSimilarSpecs('Improve checkout', memory)).rejects.toThrow(/recently/);
    expect(embedBatch).toHaveBeenCalledTimes(1);
  });
});
