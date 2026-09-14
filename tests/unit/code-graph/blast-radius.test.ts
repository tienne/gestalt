import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import { computeBlastRadius } from '../../../src/code-graph/blast-radius.js';
import { NodeKind, EdgeKind } from '../../../src/code-graph/types.js';
import type {
  CodeGraphNode,
  CodeGraphEdge,
  CoChangeLookup,
} from '../../../src/code-graph/types.js';

function makeNode(id: string, filePath: string, isTest = false): CodeGraphNode {
  return {
    id,
    kind: NodeKind.Function,
    name: id.split(':').pop() ?? id,
    filePath,
    isTest,
    updatedAt: Date.now(),
  };
}

function makeEdge(
  sourceId: string,
  targetId: string,
  kind: EdgeKind = EdgeKind.IMPORTS_FROM,
): CodeGraphEdge {
  return {
    kind,
    sourceId,
    targetId,
    updatedAt: Date.now(),
  };
}

describe('computeBlastRadius()', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/code-graph-${randomUUID()}.db`;
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
  });

  it('changedFiles가 빈 배열이면 빈 결과를 반환한다', () => {
    store.upsertNode(makeNode('function:src/a.ts:fn', 'src/a.ts'));

    const result = computeBlastRadius(store, []);

    expect(result.changedFiles).toHaveLength(0);
    expect(result.impactedFiles).toHaveLength(0);
    expect(result.impactedNodes).toHaveLength(0);
    expect(result.riskScore).toBe(0);
    expect(result.summary).toContain('No changed files');
  });

  it('변경 파일을 직접 의존하는 노드를 추적한다', () => {
    // 그래프: consumer.ts → auth.ts (consumer가 auth를 import)
    const authNode = makeNode('function:src/auth.ts:login', 'src/auth.ts');
    const consumerNode = makeNode('function:src/consumer.ts:use', 'src/consumer.ts');

    store.upsertNode(authNode);
    store.upsertNode(consumerNode);

    // consumer → auth (consumer가 auth에 의존)
    store.upsertEdge(makeEdge('function:src/consumer.ts:use', 'function:src/auth.ts:login'));

    const result = computeBlastRadius(store, ['src/auth.ts']);

    // consumer가 auth에 의존하므로 영향받음
    expect(result.impactedNodes.some((n) => n.filePath === 'src/consumer.ts')).toBe(true);
    expect(result.changedFiles).toContain('src/auth.ts');
  });

  it('maxDepth=1이면 1단계 의존만 추적한다', () => {
    // 그래프: C → B → A (A가 변경됨)
    const nodeA = makeNode('fn:src/a.ts:fnA', 'src/a.ts');
    const nodeB = makeNode('fn:src/b.ts:fnB', 'src/b.ts');
    const nodeC = makeNode('fn:src/c.ts:fnC', 'src/c.ts');

    store.upsertNode(nodeA);
    store.upsertNode(nodeB);
    store.upsertNode(nodeC);

    // B → A, C → B (역방향 BFS)
    store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/a.ts:fnA'));
    store.upsertEdge(makeEdge('fn:src/c.ts:fnC', 'fn:src/b.ts:fnB'));

    const resultDepth1 = computeBlastRadius(store, ['src/a.ts'], 1);

    // depth=1이면 B만 포함, C는 포함 안 됨
    const impactedFilePaths = resultDepth1.impactedNodes.map((n) => n.filePath);
    expect(impactedFilePaths).toContain('src/b.ts');
    expect(impactedFilePaths).not.toContain('src/c.ts');
    expect(resultDepth1.maxDepthUsed).toBe(1);
  });

  it('maxDepth=2이면 2단계 의존까지 추적한다', () => {
    // 그래프: C → B → A (A가 변경됨)
    const nodeA = makeNode('fn:src/a.ts:fnA', 'src/a.ts');
    const nodeB = makeNode('fn:src/b.ts:fnB', 'src/b.ts');
    const nodeC = makeNode('fn:src/c.ts:fnC', 'src/c.ts');

    store.upsertNode(nodeA);
    store.upsertNode(nodeB);
    store.upsertNode(nodeC);

    store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/a.ts:fnA'));
    store.upsertEdge(makeEdge('fn:src/c.ts:fnC', 'fn:src/b.ts:fnB'));

    const resultDepth2 = computeBlastRadius(store, ['src/a.ts'], 2);

    const impactedFilePaths = resultDepth2.impactedNodes.map((n) => n.filePath);
    expect(impactedFilePaths).toContain('src/b.ts');
    expect(impactedFilePaths).toContain('src/c.ts');
  });

  it('테스트 파일이 impactedNodes에서 먼저 정렬된다', () => {
    const authNode = makeNode('fn:src/auth.ts:login', 'src/auth.ts');
    const appNode = makeNode('fn:src/app.ts:run', 'src/app.ts');
    const testNode = makeNode('fn:tests/auth.test.ts:testLogin', 'tests/auth.test.ts', true);

    store.upsertNode(authNode);
    store.upsertNode(appNode);
    store.upsertNode(testNode);

    // appNode와 testNode 모두 authNode에 의존
    store.upsertEdge(makeEdge('fn:src/app.ts:run', 'fn:src/auth.ts:login'));
    store.upsertEdge(makeEdge('fn:tests/auth.test.ts:testLogin', 'fn:src/auth.ts:login'));

    const result = computeBlastRadius(store, ['src/auth.ts'], 2);

    // impactedNodes에서 isTest=true인 노드가 앞에 와야 함
    const firstNonSeedImpacted = result.impactedNodes[0];
    expect(firstNonSeedImpacted?.isTest).toBe(true);
  });

  it('테스트 파일이 impactedFiles에서 먼저 정렬된다', () => {
    const authNode = makeNode('fn:src/auth.ts:login', 'src/auth.ts');
    const testNode = makeNode('fn:tests/auth.test.ts:testLogin', 'tests/auth.test.ts', true);
    const appNode = makeNode('fn:src/app.ts:run', 'src/app.ts');

    store.upsertNode(authNode);
    store.upsertNode(testNode);
    store.upsertNode(appNode);

    store.upsertEdge(makeEdge('fn:tests/auth.test.ts:testLogin', 'fn:src/auth.ts:login'));
    store.upsertEdge(makeEdge('fn:src/app.ts:run', 'fn:src/auth.ts:login'));

    const result = computeBlastRadius(store, ['src/auth.ts'], 2);

    // impactedFiles에서 테스트 파일이 먼저 나와야 함
    const testFileIndex = result.impactedFiles.findIndex((f) => f.includes('.test.'));
    const nonTestIndex = result.impactedFiles.findIndex((f) => f === 'src/app.ts');

    if (testFileIndex !== -1 && nonTestIndex !== -1) {
      expect(testFileIndex).toBeLessThan(nonTestIndex);
    }
  });

  it('순환 의존성이 있어도 무한 루프 없이 종료된다', () => {
    // A → B → C → A (순환)
    const nodeA = makeNode('fn:src/a.ts:fnA', 'src/a.ts');
    const nodeB = makeNode('fn:src/b.ts:fnB', 'src/b.ts');
    const nodeC = makeNode('fn:src/c.ts:fnC', 'src/c.ts');

    store.upsertNode(nodeA);
    store.upsertNode(nodeB);
    store.upsertNode(nodeC);

    store.upsertEdge(makeEdge('fn:src/a.ts:fnA', 'fn:src/b.ts:fnB'));
    store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/c.ts:fnC'));
    store.upsertEdge(makeEdge('fn:src/c.ts:fnC', 'fn:src/a.ts:fnA'));

    // 타임아웃 없이 정상 종료되어야 함
    expect(() => computeBlastRadius(store, ['src/a.ts'], 3)).not.toThrow();
  });

  it('riskScore가 0과 1 사이의 값이다', () => {
    const nodeA = makeNode('fn:src/a.ts:fnA', 'src/a.ts');
    const nodeB = makeNode('fn:src/b.ts:fnB', 'src/b.ts');
    const nodeC = makeNode('fn:src/c.ts:fnC', 'src/c.ts');

    store.upsertNode(nodeA);
    store.upsertNode(nodeB);
    store.upsertNode(nodeC);

    store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/a.ts:fnA'));
    store.upsertEdge(makeEdge('fn:src/c.ts:fnC', 'fn:src/a.ts:fnA'));

    const result = computeBlastRadius(store, ['src/a.ts'], 2);

    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(1);
  });

  it('노드가 하나도 없는 그래프에서 riskScore는 0이다', () => {
    const result = computeBlastRadius(store, ['src/auth.ts'], 2);

    expect(result.riskScore).toBe(0);
  });

  it('summary 문자열이 변경 파일 수와 영향 파일 수를 포함한다', () => {
    const nodeA = makeNode('fn:src/a.ts:fnA', 'src/a.ts');
    const nodeB = makeNode('fn:src/b.ts:fnB', 'src/b.ts');
    store.upsertNode(nodeA);
    store.upsertNode(nodeB);
    store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/a.ts:fnA'));

    const result = computeBlastRadius(store, ['src/a.ts'], 2);

    expect(result.summary).toContain('Changed 1 file(s)');
    expect(result.summary).toMatch(/Risk: (LOW|MEDIUM|HIGH)/);
  });

  it('의존하는 노드가 없으면 impactedNodes가 비어있다', () => {
    store.upsertNode(makeNode('fn:src/a.ts:fnA', 'src/a.ts'));
    // 아무 엣지 없음

    const result = computeBlastRadius(store, ['src/a.ts'], 2);

    expect(result.impactedNodes).toHaveLength(0);
    expect(result.changedFiles).toContain('src/a.ts');
  });

  describe('깊이 상한 노출', () => {
    /** a ← b ← c ← d 사슬. a를 바꾸면 b(1홉), c(2홉), d(3홉)가 영향받는다 */
    function buildChain(): void {
      for (const f of ['a', 'b', 'c', 'd']) {
        store.upsertNode(makeNode(`fn:src/${f}.ts:fn${f.toUpperCase()}`, `src/${f}.ts`));
      }
      store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/a.ts:fnA'));
      store.upsertEdge(makeEdge('fn:src/c.ts:fnC', 'fn:src/b.ts:fnB'));
      store.upsertEdge(makeEdge('fn:src/d.ts:fnD', 'fn:src/c.ts:fnC'));
    }

    it('상한에 걸려 멈추면 depthExhausted로 알린다', () => {
      buildChain();

      const result = computeBlastRadius(store, ['src/a.ts'], 2);

      // 2홉까지만 갔으니 d는 안 잡힌다 — 그게 잘렸다는 사실이 드러나야 한다
      expect(result.impactedFiles).not.toContain('src/d.ts');
      expect(result.depthExhausted).toBe(true);
      expect(result.unexploredNodes).toBeGreaterThan(0);
      expect(result.summary).toContain('INCOMPLETE');
      expect(result.summary).toContain('lower bounds');
    });

    it('끝까지 탐색했으면 depthExhausted가 false다', () => {
      buildChain();

      const result = computeBlastRadius(store, ['src/a.ts'], 10);

      expect(result.impactedFiles).toContain('src/d.ts');
      expect(result.depthExhausted).toBe(false);
      expect(result.unexploredNodes).toBe(0);
      expect(result.summary).not.toContain('INCOMPLETE');
    });

    it('잘린 riskScore는 끝까지 탐색한 값보다 작다 — 하한이라는 뜻', () => {
      buildChain();

      const truncated = computeBlastRadius(store, ['src/a.ts'], 2);
      const full = computeBlastRadius(store, ['src/a.ts'], 10);

      expect(truncated.riskScore).toBeLessThan(full.riskScore);
    });
  });

  describe('co-change 병합', () => {
    function buildImportGraph(): void {
      store.upsertNode(makeNode('function:src/a.ts:fn', 'src/a.ts'));
      store.upsertNode(makeNode('function:src/b.ts:fn', 'src/b.ts'));
      store.upsertEdge(makeEdge('function:src/b.ts:fn', 'function:src/a.ts:fn'));
    }

    function lookup(neighbors: CoChangeLookup['neighbors']): CoChangeLookup {
      return {
        available: true,
        pairsInDb: neighbors.length,
        neighbors,
        totalMatched: neighbors.length,
        truncated: false,
      };
    }

    it('3인자로 부르면 이력 신호 없이 import 출처만 남는다', () => {
      buildImportGraph();

      const result = computeBlastRadius(store, ['src/a.ts'], 2);

      expect(result.coChangeAvailable).toBe(false);
      expect(result.rankedFiles.length).toBeGreaterThan(0);
      expect(result.rankedFiles.every((f) => f.origin === 'import')).toBe(true);
      expect(result.summary).toContain('Git history signal unavailable');
    });

    it('빈 입력도 rankedFiles를 빈 배열로 낸다', () => {
      const result = computeBlastRadius(store, []);

      expect(result.rankedFiles).toEqual([]);
      expect(result.coChangeAvailable).toBe(false);
    });

    it('두 신호에 모두 걸린 파일이 가장 위로 온다', () => {
      buildImportGraph();

      const result = computeBlastRadius(
        store,
        ['src/a.ts'],
        2,
        lookup([
          { filePath: 'plugin/mcp.json', pairCount: 14, confidence: 0.7, lift: 8 },
          { filePath: 'src/b.ts', pairCount: 18, confidence: 0.9, lift: 12 },
        ]),
      );

      expect(result.coChangeAvailable).toBe(true);
      expect(result.rankedFiles[0]).toMatchObject({ filePath: 'src/b.ts', origin: 'both' });
      expect(result.rankedFiles[1]).toMatchObject({
        filePath: 'plugin/mcp.json',
        origin: 'history',
      });
      expect(result.rankedFiles.at(-1)!.origin).toBe('import');
    });

    it('이력에만 걸린 파일은 impactedFiles를 오염시키지 않는다', () => {
      buildImportGraph();

      const result = computeBlastRadius(
        store,
        ['src/a.ts'],
        2,
        lookup([{ filePath: 'docs/guide.md', pairCount: 9, confidence: 0.5, lift: 4 }]),
      );

      // impactedFiles는 소비자가 vitest 인자로 직결한다 — md가 섞이면 안 된다
      expect(result.impactedFiles).not.toContain('docs/guide.md');
      expect(result.rankedFiles.map((f) => f.filePath)).toContain('docs/guide.md');
    });

    it('점수도 카운트도 같으면 경로 순으로 세운다', () => {
      buildImportGraph();

      // 입력을 알파벳 역순으로 준다 — 마지막 열쇠가 없으면 그 순서가 그대로 샌다
      const result = computeBlastRadius(
        store,
        ['src/a.ts'],
        2,
        lookup([
          { filePath: 'docs/z.md', pairCount: 4, confidence: 0.5, lift: 4 },
          { filePath: 'docs/m.md', pairCount: 4, confidence: 0.5, lift: 4 },
          { filePath: 'docs/a.md', pairCount: 4, confidence: 0.5, lift: 4 },
        ]),
      );

      expect(
        result.rankedFiles.filter((f) => f.origin === 'history').map((f) => f.filePath),
      ).toEqual(['docs/a.md', 'docs/m.md', 'docs/z.md']);
    });

    it('available:false면 사유를 그대로 실어 조용한 0건을 막는다', () => {
      buildImportGraph();

      const result = computeBlastRadius(store, ['src/a.ts'], 2, {
        available: false,
        reason: 'co-change history has not been collected',
        pairsInDb: 0,
        neighbors: [],
        totalMatched: 0,
        truncated: false,
      });

      expect(result.coChangeAvailable).toBe(false);
      expect(result.coChangeReason).toContain('has not been collected');
    });

    it('이력 이웃이 잘렸으면 summary가 상위 몇 개인지 말한다', () => {
      buildImportGraph();
      const neighbors = [
        { filePath: 'docs/guide.md', pairCount: 5, confidence: 0.8, lift: 4 },
        { filePath: 'docs/other.md', pairCount: 4, confidence: 0.7, lift: 3 },
      ];

      const cut = computeBlastRadius(store, ['src/a.ts'], 2, {
        available: true,
        pairsInDb: 40,
        neighbors,
        totalMatched: 40,
        truncated: true,
      });
      const full = computeBlastRadius(store, ['src/a.ts'], 2, {
        available: true,
        pairsInDb: 2,
        neighbors,
        totalMatched: 2,
        truncated: false,
      });

      expect(cut.coChangeTruncated).toBe(true);
      expect(cut.coChangeTotalMatched).toBe(40);
      expect(full.coChangeTruncated).toBe(false);
      expect(cut.summary).toContain('lower bound');
      // "at least"가 아니다. 자르는 자리가 랭킹 뒤 한 곳뿐이라 40은 정확한 수고
      // 보인 2개는 그 40의 상위 둘이다
      expect(cut.summary).toContain('showing the top 2 of 40 match(es)');
      expect(cut.summary).not.toContain('at least');
      expect(full.summary).toContain('Git history adds');
      expect(full.summary).not.toContain('lower bound');
    });
  });
});
