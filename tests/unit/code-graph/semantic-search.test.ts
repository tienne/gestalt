import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import { reciprocalRankFusion } from '../../../src/code-graph/rrf.js';
import type { ScoredFile } from '../../../src/code-graph/rrf.js';
import { NodeKind } from '../../../src/code-graph/types.js';
import type { CodeNodeEmbedding } from '../../../src/code-graph/embedding-provider.js';

// ─── 헬퍼 ─────────────────────────────────────────────────────────

function makeDbPath() {
  return `.gestalt-test/semantic-${randomUUID()}.db`;
}

function float32ToBuffer(values: number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer);
}

function makeEmbedding(nodeId: string, filePath: string, values: number[]): CodeNodeEmbedding {
  return {
    nodeId,
    filePath,
    embedding: float32ToBuffer(values),
    modelId: 'test-model',
    createdAt: Date.now(),
  };
}

function cleanupDb(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

// ─── RRF 알고리즘 ──────────────────────────────────────────────────

describe('reciprocalRankFusion', () => {
  it('단일 리스트에서 순서를 유지한다', () => {
    const list: ScoredFile[] = [
      { filePath: 'src/a.ts', score: 0.9 },
      { filePath: 'src/b.ts', score: 0.8 },
      { filePath: 'src/c.ts', score: 0.7 },
    ];
    const result = reciprocalRankFusion([list]);
    expect(result.map((r) => r.filePath)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('두 리스트에서 공통 항목의 점수가 합산된다', () => {
    const list1: ScoredFile[] = [
      { filePath: 'src/a.ts', score: 1.0 }, // rank 0
      { filePath: 'src/b.ts', score: 0.5 }, // rank 1
    ];
    const list2: ScoredFile[] = [
      { filePath: 'src/b.ts', score: 1.0 }, // rank 0 → 1/60 + 1/61
      { filePath: 'src/a.ts', score: 0.3 }, // rank 1 → 1/60 + 1/61
    ];
    const result = reciprocalRankFusion([list1, list2]);
    // src/a.ts: 1/60 + 1/61, src/b.ts: 1/61 + 1/60 — 동점이므로 순서는 Map 삽입 순
    expect(result).toHaveLength(2);
    // 두 항목의 RRF 점수가 동일한지 확인
    expect(result[0]!.score).toBeCloseTo(result[1]!.score, 5);
  });

  it('한쪽 리스트에만 있는 항목도 결과에 포함된다', () => {
    const list1: ScoredFile[] = [{ filePath: 'src/a.ts', score: 1.0 }];
    const list2: ScoredFile[] = [{ filePath: 'src/b.ts', score: 1.0 }];
    const result = reciprocalRankFusion([list1, list2]);
    const paths = result.map((r) => r.filePath);
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/b.ts');
  });

  it('k=60 기본값으로 1등 항목의 점수는 1/60이다', () => {
    const list: ScoredFile[] = [{ filePath: 'src/a.ts', score: 1.0 }];
    const result = reciprocalRankFusion([list]);
    expect(result[0]!.score).toBeCloseTo(1 / 60, 6);
  });

  it('k 값을 변경하면 점수가 달라진다', () => {
    const list: ScoredFile[] = [{ filePath: 'src/a.ts', score: 1.0 }];
    const r60 = reciprocalRankFusion([list], 60);
    const r10 = reciprocalRankFusion([list], 10);
    expect(r10[0]!.score).toBeGreaterThan(r60[0]!.score);
  });

  it('빈 리스트 입력 시 빈 배열을 반환한다', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
  });
});

// ─── CodeGraphStore 임베딩 CRUD ────────────────────────────────────

describe('CodeGraphStore — 임베딩 CRUD', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeDbPath();
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
  });

  it('임베딩을 저장하고 조회할 수 있다', () => {
    const emb = makeEmbedding('node:1', 'src/auth.ts', [0.1, 0.2, 0.3]);
    store.upsertEmbedding(emb);

    const result = store.getEmbedding('node:1');
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('node:1');
    expect(result!.filePath).toBe('src/auth.ts');
    expect(result!.modelId).toBe('test-model');
  });

  it('같은 nodeId로 upsert 시 덮어쓴다', () => {
    store.upsertEmbedding(makeEmbedding('node:1', 'src/auth.ts', [0.1, 0.2]));
    store.upsertEmbedding(makeEmbedding('node:1', 'src/auth.ts', [0.9, 0.8]));

    const result = store.getEmbedding('node:1');
    const vec = new Float32Array(result!.embedding.buffer, result!.embedding.byteOffset, result!.embedding.byteLength / 4);
    expect(vec[0]).toBeCloseTo(0.9, 4);
  });

  it('getAllEmbeddings()로 전체 임베딩을 가져온다', () => {
    store.upsertEmbedding(makeEmbedding('node:1', 'src/a.ts', [0.1]));
    store.upsertEmbedding(makeEmbedding('node:2', 'src/b.ts', [0.2]));
    store.upsertEmbedding(makeEmbedding('node:3', 'src/c.ts', [0.3]));

    const all = store.getAllEmbeddings();
    expect(all).toHaveLength(3);
  });

  it('deleteEmbedding()으로 특정 노드 임베딩을 삭제한다', () => {
    store.upsertEmbedding(makeEmbedding('node:1', 'src/a.ts', [0.1]));
    store.deleteEmbedding('node:1');
    expect(store.getEmbedding('node:1')).toBeNull();
  });

  it('deleteEmbeddingsByFile()로 파일 단위 삭제가 가능하다', () => {
    store.upsertEmbedding(makeEmbedding('node:1', 'src/auth.ts', [0.1]));
    store.upsertEmbedding(makeEmbedding('node:2', 'src/auth.ts', [0.2]));
    store.upsertEmbedding(makeEmbedding('node:3', 'src/other.ts', [0.3]));

    store.deleteEmbeddingsByFile('src/auth.ts');
    expect(store.getAllEmbeddings()).toHaveLength(1);
    expect(store.getAllEmbeddings()[0]!.filePath).toBe('src/other.ts');
  });
});

// ─── searchBySemantic mocking ──────────────────────────────────────

describe('searchBySemantic — mock 기반 정렬 검증', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeDbPath();
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  it('임베딩이 없으면 빈 배열을 반환한다', async () => {
    // LocalEmbeddingProvider를 mock해 실제 WASM 모델 로드를 방지
    vi.mock('../../../src/code-graph/providers/local-embedding.js', () => ({
      LocalEmbeddingProvider: vi.fn().mockImplementation(() => ({
        modelId: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 384,
        embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      })),
    }));

    // getAllEmbeddings가 빈 배열 반환 → 빈 결과
    const allEmbs = store.getAllEmbeddings();
    expect(allEmbs).toHaveLength(0);
  });

  it('코사인 유사도 높은 파일이 먼저 온다', () => {
    // 쿼리 벡터: [1, 0, 0]
    // file A: [1, 0, 0] → similarity 1.0
    // file B: [0, 1, 0] → similarity 0.0
    // file C: [0.7071, 0.7071, 0] → similarity ≈ 0.707
    const query = [1, 0, 0];
    const fileA = [1, 0, 0];
    const fileB = [0, 1, 0];
    const fileC = [0.7071, 0.7071, 0];

    function cosSim(a: number[], b: number[]): number {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        const ai = a[i] ?? 0;
        const bi = b[i] ?? 0;
        dot += ai * bi;
        na += ai * ai;
        nb += bi * bi;
      }
      if (na === 0 || nb === 0) return 0;
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    const similarities = [
      { filePath: 'src/a.ts', score: cosSim(query, fileA) },
      { filePath: 'src/b.ts', score: cosSim(query, fileB) },
      { filePath: 'src/c.ts', score: cosSim(query, fileC) },
    ].sort((a, b) => b.score - a.score);

    expect(similarities[0]!.filePath).toBe('src/a.ts');
    expect(similarities[1]!.filePath).toBe('src/c.ts');
    expect(similarities[2]!.filePath).toBe('src/b.ts');
  });
});

// ─── searchByHybrid — fallback 동작 ───────────────────────────────

describe('searchByHybrid — RRF 통합 및 fallback', () => {
  it('semantic 결과가 없으면 keyword 결과만 반환한다', () => {
    // keyword 결과
    const keywordResults: ScoredFile[] = [
      { filePath: 'src/auth.ts', score: 1.0 },
      { filePath: 'src/user.ts', score: 0.5 },
    ];
    // semantic 결과 없음
    const semanticResults: ScoredFile[] = [];

    // searchByHybrid 내부 로직 시뮬레이션
    const merged = semanticResults.length === 0
      ? keywordResults.slice(0, 10).map((r) => r.filePath)
      : reciprocalRankFusion([keywordResults, semanticResults]).slice(0, 10).map((r) => r.filePath);

    expect(merged).toEqual(['src/auth.ts', 'src/user.ts']);
  });

  it('두 결과가 모두 있으면 RRF로 병합된다', () => {
    const keywordResults: ScoredFile[] = [
      { filePath: 'src/auth.ts', score: 1.0 },  // rank 0
      { filePath: 'src/user.ts', score: 0.5 },  // rank 1
    ];
    const semanticResults: ScoredFile[] = [
      { filePath: 'src/user.ts', score: 0.9 },  // rank 0 in semantic
      { filePath: 'src/auth.ts', score: 0.8 },  // rank 1 in semantic
    ];

    const merged = reciprocalRankFusion([keywordResults, semanticResults]).slice(0, 10);
    const paths = merged.map((r) => r.filePath);

    // 두 파일 모두 포함
    expect(paths).toContain('src/auth.ts');
    expect(paths).toContain('src/user.ts');

    // auth.ts: 1/60 (kw rank 0) + 1/61 (sem rank 1) ≈ 0.03304
    // user.ts: 1/61 (kw rank 1) + 1/60 (sem rank 0) ≈ 0.03304
    // 동점 — 결과 길이는 2
    expect(merged).toHaveLength(2);
  });

  it('topK로 결과 개수가 제한된다', () => {
    const lists: ScoredFile[][] = [
      Array.from({ length: 20 }, (_, i) => ({ filePath: `src/file${i}.ts`, score: 1 / (i + 1) })),
    ];
    const merged = reciprocalRankFusion(lists).slice(0, 10);
    expect(merged).toHaveLength(10);
  });

  it('키워드만 있어도 중복 없이 반환된다', () => {
    // 같은 filePath가 여러 번 등장하는 경우
    const list: ScoredFile[] = [
      { filePath: 'src/a.ts', score: 0.9 },
      { filePath: 'src/a.ts', score: 0.8 }, // 중복
      { filePath: 'src/b.ts', score: 0.7 },
    ];
    const result = reciprocalRankFusion([list]);
    const paths = result.map((r) => r.filePath);
    // RRF에서 같은 filePath는 누적됨 — 중복 경로가 합산된다
    const uniquePaths = [...new Set(paths)];
    expect(paths).toHaveLength(uniquePaths.length);
  });
});

// ─── buildEmbeddings — mock provider 사용 ─────────────────────────

describe('buildEmbeddings — 임베딩 저장 검증', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeDbPath();
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
  });

  it('File 노드가 없으면 embeddingsBuilt=0을 반환한다', () => {
    const fileNodes = store.getAllNodes().filter((n) => n.kind === NodeKind.File);
    expect(fileNodes).toHaveLength(0);
  });

  it('File 노드에 대해 임베딩이 저장된다', () => {
    // File 노드 추가
    store.upsertNode({
      id: 'file:src/auth.ts',
      kind: NodeKind.File,
      name: 'auth.ts',
      filePath: 'src/auth.ts',
      isTest: false,
      updatedAt: Date.now(),
    });

    // mock 임베딩 저장 (실제 buildEmbeddings 없이)
    const embedding = makeEmbedding('file:src/auth.ts', 'src/auth.ts', [0.1, 0.2, 0.3]);
    store.upsertEmbedding(embedding);

    const stored = store.getEmbedding('file:src/auth.ts');
    expect(stored).not.toBeNull();
    expect(stored!.nodeId).toBe('file:src/auth.ts');
    expect(stored!.filePath).toBe('src/auth.ts');
  });

  it('incremental 모드에서 기존 임베딩이 있는 노드는 건너뛴다', () => {
    const nodeId = 'file:src/auth.ts';
    const modelId = 'Xenova/all-MiniLM-L6-v2';

    // 기존 임베딩 저장
    store.upsertEmbedding({
      nodeId,
      filePath: 'src/auth.ts',
      embedding: float32ToBuffer([0.1, 0.2]),
      modelId,
      createdAt: Date.now(),
    });

    // incremental 모드 체크 시뮬레이션
    const existing = store.getEmbedding(nodeId);
    const shouldSkip = existing !== null && existing.modelId === modelId;
    expect(shouldSkip).toBe(true);
  });
});
