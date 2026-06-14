import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// @xenova/transformers는 실제 모델 다운로드가 필요하므로 vi.mock으로 처리한다.
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(),
}));

import { pipeline } from '@xenova/transformers';
import { EmbeddingService } from '../../../src/knowledge-base/embedding.js';

// ─── 헬퍼 ─────────────────────────────────────────────────────────

/**
 * 주어진 texts 배열을 받아 flat Float32Array를 반환하는 mock extractor를 만든다.
 * 각 text에 대해 dim 차원 벡터를 생성한다.
 */
function makeMockExtractor(dim = 4, fillValue = 0.1) {
  return vi.fn().mockImplementation(async (texts: string[]) => {
    const count = texts.length;
    const flat = new Float32Array(count * dim).fill(fillValue);
    return { data: flat };
  });
}

// ─── embedBatch ───────────────────────────────────────────────────

describe('EmbeddingService.embedBatch', () => {
  let service: EmbeddingService;
  let mockExtractor: ReturnType<typeof makeMockExtractor>;

  beforeEach(() => {
    service = new EmbeddingService();
    mockExtractor = makeMockExtractor(4, 0.1);
    vi.mocked(pipeline).mockResolvedValue(mockExtractor as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('빈 배열 입력 시 즉시 [] 반환 (pipeline 호출 없음)', async () => {
    const result = await service.embedBatch([]);
    expect(result).toEqual([]);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('단일 텍스트 → 길이 1인 결과 배열 반환', async () => {
    const result = await service.embedBatch(['hello']);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(4); // dim=4
  });

  it('batchSize보다 적은 텍스트는 pipeline을 한 번만 호출한다', async () => {
    const texts = ['a', 'b', 'c'];
    await service.embedBatch(texts, 32);
    // pipeline은 lazy-load 시 1회, extractor는 chunk당 1회
    expect(mockExtractor).toHaveBeenCalledTimes(1);
    expect(mockExtractor).toHaveBeenCalledWith(['a', 'b', 'c'], {
      pooling: 'mean',
      normalize: true,
    });
  });

  it('텍스트 수가 batchSize를 초과하면 청크 수만큼 pipeline이 호출된다', async () => {
    const texts = ['a', 'b', 'c', 'd', 'e'];
    // batchSize=2 → ceil(5/2)=3 청크
    await service.embedBatch(texts, 2);
    expect(mockExtractor).toHaveBeenCalledTimes(3);
    // 첫 번째 청크
    expect(mockExtractor).toHaveBeenNthCalledWith(1, ['a', 'b'], {
      pooling: 'mean',
      normalize: true,
    });
    // 두 번째 청크
    expect(mockExtractor).toHaveBeenNthCalledWith(2, ['c', 'd'], {
      pooling: 'mean',
      normalize: true,
    });
    // 세 번째 청크 (나머지 1개)
    expect(mockExtractor).toHaveBeenNthCalledWith(3, ['e'], {
      pooling: 'mean',
      normalize: true,
    });
  });

  it('반환 벡터 개수가 입력 텍스트 개수와 동일하다', async () => {
    const texts = ['a', 'b', 'c', 'd', 'e'];
    const result = await service.embedBatch(texts, 2);
    expect(result).toHaveLength(5);
  });

  it('dim은 flat.length / chunk.length로 동적 계산된다 (하드코딩 없음)', async () => {
    // dim=8 짜리 extractor로 교체
    mockExtractor = vi.fn().mockImplementation(async (texts: string[]) => {
      const flat = new Float32Array(texts.length * 8).fill(0.5);
      return { data: flat };
    });
    vi.mocked(pipeline).mockResolvedValue(mockExtractor as never);

    // 서비스 인스턴스 새로 생성 (pipeline cache 초기화)
    const svc = new EmbeddingService();
    const result = await svc.embedBatch(['x', 'y'], 32);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(8);
    expect(result[1]).toHaveLength(8);
  });

  it('batchSize=1 → 각 텍스트마다 개별 청크 처리', async () => {
    const texts = ['x', 'y', 'z'];
    await service.embedBatch(texts, 1);
    expect(mockExtractor).toHaveBeenCalledTimes(3);
  });

  it('각 벡터의 값이 Float32Array에서 올바르게 추출된다', async () => {
    // dim=2, fillValue로 구분 가능한 값 설정
    const customExtractor = vi.fn().mockImplementation(async (texts: string[]) => {
      // text index에 따라 다른 값을 부여
      const count = texts.length;
      const dim = 2;
      const flat = new Float32Array(count * dim);
      for (let i = 0; i < count; i++) {
        flat[i * dim] = i + 1; // 1.0, 2.0, ...
        flat[i * dim + 1] = (i + 1) * 0.1; // 0.1, 0.2, ...
      }
      return { data: flat };
    });
    vi.mocked(pipeline).mockResolvedValue(customExtractor as never);

    const svc = new EmbeddingService();
    const result = await svc.embedBatch(['a', 'b', 'c'], 32);

    expect(result).toHaveLength(3);
    expect(result[0]![0]).toBeCloseTo(1.0, 4);
    expect(result[0]![1]).toBeCloseTo(0.1, 4);
    expect(result[1]![0]).toBeCloseTo(2.0, 4);
    expect(result[1]![1]).toBeCloseTo(0.2, 4);
    expect(result[2]![0]).toBeCloseTo(3.0, 4);
    expect(result[2]![1]).toBeCloseTo(0.3, 4);
  });
});

// ─── embed (단건 위임) ─────────────────────────────────────────────

describe('EmbeddingService.embed', () => {
  let service: EmbeddingService;
  let mockExtractor: ReturnType<typeof makeMockExtractor>;

  beforeEach(() => {
    service = new EmbeddingService();
    mockExtractor = makeMockExtractor(4, 0.25);
    vi.mocked(pipeline).mockResolvedValue(mockExtractor as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('embed(text) → 1차원 number[] 반환', async () => {
    const result = await service.embed('hello world');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(4);
  });

  it('embed() 내부에서 embedBatch([text])를 통해 extractor가 1회 호출된다', async () => {
    await service.embed('test');
    expect(mockExtractor).toHaveBeenCalledTimes(1);
    expect(mockExtractor).toHaveBeenCalledWith(['test'], {
      pooling: 'mean',
      normalize: true,
    });
  });

  it('embed()는 embedBatch 결과의 첫 번째 벡터를 반환한다', async () => {
    const customExtractor = vi.fn().mockResolvedValue({
      data: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    });
    vi.mocked(pipeline).mockResolvedValue(customExtractor as never);

    const svc = new EmbeddingService();
    const result = await svc.embed('anything');
    expect(result).toHaveLength(4);
    expect(result[0]).toBeCloseTo(0.1, 4);
    expect(result[3]).toBeCloseTo(0.4, 4);
  });

  it('embedBatch가 빈 배열을 반환하면 embed()는 []를 반환한다 (fallback)', async () => {
    // pipeline 로드 없이 빈 배열 케이스를 시뮬레이션
    // embedBatch([text])는 내부적으로 1건을 처리하므로 실제로 빈 배열은 올 수 없지만
    // ?? [] fallback 동작을 검증하기 위해 embedBatch를 spy로 교체한다
    const spy = vi.spyOn(service, 'embedBatch').mockResolvedValue([]);
    const result = await service.embed('test');
    expect(result).toEqual([]);
    spy.mockRestore();
  });
});
